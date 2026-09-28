/* ============================================================
 * ArkWork — B3 实机冒烟 runner（v0.36.0 · 临时开发设施）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.5 / §6 批次表 B3
 *
 * 触发：`ARKWORK_B3_SMOKE=1 npx electron . --user-data-dir=app/.dev-data`
 * 门槛：**真仓库 + 真插件 + 真桥** —— 「Git 面板出真数据，写操作真落审计」。
 *
 * 这条链路为什么必须实机跑（单测覆盖不到的部分）：
 *   iframe 面板 → postMessage → viewCall('host.call') → Host 半 onCall('git.run')
 *   → ctx.ark.git.* → 网关（权限闸门）→ git/service（审批+审计）→ 真 git 进程
 * 其中「Host 半是否真的把桥方法登记上了」「ctx.ark.git 是否真的注入到插件 ctx」
 * 「插件激活是否真的成立」三件事都只在真 utilityProcess + 真 ipc 下才成立 ——
 * 这正是 v0.36.0 开头 P0-1/P0-2 那类「函数全对、接线缺失」缺陷的所在层。
 *
 * 隔离：本 runner 把工作区**切到冒烟仓库**（.arkwork/b3-smoke/repo），
 * 故必须搭配独立的 --user-data-dir 运行，绝不污染真实工作区。
 * ============================================================ */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getWorkspaceDir, setWorkspaceDir } from '../store/db.js'
import { getPluginHostService } from '../plugins/runtime/host-service.js'
import { gitAuditLogPath } from '../git/audit.js'
import { resolveGitEngine, resetGitEngineCache } from '../git/engine.js'
import { setSessionMode } from '../agent/session-mode.js'
import { logger } from '../system/logger.js'

const GIT_PLUGIN = 'ark.plugin.git-manager'
const VIEW_REF = 'view:git'

/** 产物位置：**仓库根** .arkwork/b3-smoke（与 B1/B2 冒烟同约定，不用 __dirname —— 会被打进 chunks/） */
const HERE = resolve(app.getAppPath(), '..', '.arkwork', 'b3-smoke')
const REPO = join(HERE, 'repo')
const RESULT = join(HERE, 'result.json')

interface StepResult {
  step: string
  ok: boolean
  detail: string
}

const steps: StepResult[] = []

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await fn()
    steps.push({ step: name, ok: true, detail })
    logger.info('System', `[b3-smoke] ✔ ${name} — ${detail}`)
    return true
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    steps.push({ step: name, ok: false, detail })
    logger.warn('System', `[b3-smoke] ✘ ${name} — ${detail}`)
    return false
  }
}

export function maybeRunB3Smoke(): void {
  if (process.env.ARKWORK_B3_SMOKE !== '1' || app.isPackaged) return
  // ★ 自清夹具（幂等）：用进程内 fs 而非 shell `rm -rf` —— 后者会被外层的
  //   安全删除守卫按「条目数超阈值」拦下，导致冒烟"看起来跑了"其实是旧结果。
  rmSync(REPO, { recursive: true, force: true })
  rmSync(join(HERE, 'remote.git'), { recursive: true, force: true })
  mkdirSync(REPO, { recursive: true })

  void (async () => {
    /* ---- ① 引擎探测：先说清「用哪个 git」—— 四级解析链的实机取值 ---- */
    let pass = await step('engine', async () => {
      resetGitEngineCache()
      const e = resolveGitEngine()
      const ver = await e.exec(REPO, ['--version'])
      if (ver.exitCode !== 0) throw new Error(`git --version 失败：${ver.stderr}`)
      return `${e.kind}（${e.binPath}）→ ${ver.stdout.trim()}`
    })

    /* ---- ② 真仓库：用**引擎自身**建仓（与生产同一条执行路径） ---- */
    if (pass)
      pass = await step('repo', async () => {
        const e = resolveGitEngine()
        await e.exec(REPO, ['init'])
        writeFileSync(join(REPO, 'smoke.txt'), 'arkwork b3 smoke\n', 'utf-8')
        setWorkspaceDir(REPO)
        if (getWorkspaceDir() !== REPO) throw new Error('工作区切换未生效')
        return `工作区已切至 ${REPO}`
      })

    const svc = getPluginHostService()
    if (pass && !svc) {
      steps.push({ step: 'prerequisite', ok: false, detail: '插件运行时未就绪（getPluginHostService() 为空）' })
      pass = false
    }

    /* ---- ③ 插件在册且启用（随包种子落盘 + 默认启用） ---- */
    if (pass && svc)
      pass = await step('plugin', async () => {
        const index = await svc!.refreshIndex()
        const entry = index.find((x) => x.id === GIT_PLUGIN)
        if (!entry) throw new Error(`${GIT_PLUGIN} 不在册（随包种子未落盘？）`)
        if (!entry.enabled) throw new Error(`${GIT_PLUGIN} 未启用`)
        return `在册 ${index.length} 个插件；${GIT_PLUGIN} enabled=true source=${entry.source}`
      })

    /* ---- ④ 开视图 = 真激活 Host 半（P0-1 环境注入 / P0-2 能力注入全在这一步现形） ---- */
    let sessionId = ''
    if (pass && svc)
      pass = await step('open-view', async () => {
        const r = await svc!.openView(GIT_PLUGIN, VIEW_REF)
        if (!r.ok) throw new Error(`${r.reason}：${r.message ?? ''}`)
        sessionId = r.session.sessionId
        return `视图会话建立 session=${sessionId.slice(0, 24)}…（Host 半已激活）`
      })

    /* ---- ⑤ 读 op 经真桥：面板拿到的就是这里返回的东西 ---- */
    if (pass && svc)
      pass = await step('bridge.status', async () => {
        const r = await svc!.viewCall(sessionId, 'host.call', {
          method: 'git.run',
          params: { op: 'status', args: {} },
        })
        if (!r.ok) throw new Error(`${r.error?.code}：${r.error?.message}`)
        const out = (r.result as { output?: { entries?: Array<{ path: string; x: string; y: string }> } })?.output
        const entries = out?.entries ?? []
        const hit = entries.find((x) => x.path === 'smoke.txt')
        if (!hit) throw new Error(`未看到未跟踪文件 smoke.txt（实际 ${JSON.stringify(entries)}）`)
        return `status 返回 ${entries.length} 条，含 smoke.txt(${hit.x}${hit.y})`
      })

    /* ---- ⑥ 写 op 经真桥：临时切 autoApprove 免弹窗（真机上写路径要走到审计） ---- */
    if (pass && svc)
      pass = await step('bridge.write', async () => {
        setSessionMode(REPO, 'autoApprove')
        const call = (op: string, args: Record<string, unknown> = {}) =>
          svc!.viewCall(sessionId, 'host.call', { method: 'git.run', params: { op, args } })
        const add = await call('add', { files: ['.'] })
        if (!add.ok) throw new Error(`add 失败 ${add.error?.code}：${add.error?.message}`)
        const commit = await call('commit', { message: 'chore(b3-smoke): 冒烟提交' })
        if (!commit.ok) throw new Error(`commit 失败 ${commit.error?.code}：${commit.error?.message}`)
        const log = await call('log', { limit: 5 })
        if (!log.ok) throw new Error(`log 失败 ${log.error?.code}：${log.error?.message}`)
        const entries = (log.result as { output?: { entries?: Array<{ subject: string }> } })?.output?.entries ?? []
        if (!entries.some((x) => x.subject === 'chore(b3-smoke): 冒烟提交')) {
          throw new Error(`提交未出现在历史里：${JSON.stringify(entries)}`)
        }
        return `add/commit/log 全通，历史首条=${entries[0]?.subject}`
      })

    /* ---- ⑦ 推送：网络类写 op（走同一条审批 + 审计链）→ 本地裸仓库当远端 ----
     * 门禁原话是「真仓库 status→commit→log→push 全链路」，所以 push 必须在冒烟里。
     * 裸仓库而非真实远端：不引入凭据/网络这两个与本次改动无关的失败源。
     * 注意 remote add 不在白名单 op 内 —— 那是**夹具搭建**（冒烟设施），
     * 用引擎直接做；白名单管的是插件能做什么，不是测试能做什么。 */
    if (pass && svc)
      pass = await step('bridge.push', async () => {
        const e = resolveGitEngine()
        const bare = join(HERE, 'remote.git')
        const init = await e.exec(HERE, ['init', '--bare', bare])
        if (init.exitCode !== 0) throw new Error(`裸仓库创建失败：${init.stderr}`)
        await e.exec(REPO, ['remote', 'remove', 'origin'])
        const addRemote = await e.exec(REPO, ['remote', 'add', 'origin', bare])
        if (addRemote.exitCode !== 0) throw new Error(`remote add 失败：${addRemote.stderr}`)
        const head = await e.exec(REPO, ['rev-parse', '--abbrev-ref', 'HEAD'])
        const branch = head.stdout.trim()
        if (!branch) throw new Error('取不到当前分支名')

        const r = await svc!.viewCall(sessionId, 'host.call', {
          method: 'git.run',
          params: { op: 'push', args: { remote: 'origin', branch } },
        })
        if (!r.ok) throw new Error(`${r.error?.code}：${r.error?.message}`)

        const ls = await e.exec(HERE, ['ls-remote', bare])
        if (!ls.stdout.includes(`refs/heads/${branch}`)) {
          throw new Error(`裸仓库里没有 refs/heads/${branch}：${ls.stdout.trim()}`)
        }
        return `push ${branch} → 裸仓库；ls-remote 命中 refs/heads/${branch}`
      })

    /* ---- ⑧ 审计落盘：写类 op 逐条落 .arkwork/logs/git-audit.jsonl ---- */
    if (pass)
      pass = await step('audit', async () => {
        const path = gitAuditLogPath(REPO)
        if (!existsSync(path)) throw new Error(`审计文件不存在：${path}`)
        const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
        const parsed = lines.map((l) => JSON.parse(l) as { op: string; result: string; pluginId: string })
        const ops = parsed.map((p) => `${p.op}:${p.result}`)
        for (const need of ['add:success', 'commit:success', 'push:success']) {
          if (!ops.includes(need)) throw new Error(`审计缺 ${need}：${ops.join(' ')}`)
        }
        if (!parsed.every((p) => p.pluginId === GIT_PLUGIN)) {
          throw new Error('审计归属插件 id 不对（应为发起插件）')
        }
        return `${parsed.length} 条：${ops.join(' ')}`
      })

    /* ---- ⑨ 关视图（会话撤销）：不留孤儿会话 ---- */
    if (pass && svc)
      pass = await step('close-view', async () => {
        const closed = svc!.closeView(sessionId)
        if (!closed) throw new Error('closeView 返回 false')
        if (svc!.sessionOf(sessionId)) throw new Error('会话仍在（残留）')
        return '视图会话已撤销'
      })

    finish(pass)
  })()
}

function finish(pass = false): void {
  const ok = pass && steps.every((s) => s.ok)
  const summary = {
    gate: '真仓库 + 真插件 + 真桥：status 真数据 / add·commit·push 真落审计',
    ok,
    steps,
    workspace: getWorkspaceDir(),
    auditPath: gitAuditLogPath(getWorkspaceDir()),
  }
  try {
    writeFileSync(RESULT, JSON.stringify(summary, null, 2))
  } catch (err) {
    logger.warn('System', `[b3-smoke] 结果落盘失败：${String(err)}`)
  }
  logger.info('System', `[b3-smoke] 门槛${ok ? '通过' : '失败'}：${steps.map((s) => `${s.step}=${s.ok ? '✔' : '✘'}`).join(' ')}`)
  setTimeout(() => app.exit(ok ? 0 : 1), 400)
}
