/* ============================================================
 * ArkWork — B2 实机冒烟 runner（v0.36.0 · 临时开发设施）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.4 / §6 批次表 B2
 *
 * 触发：`ARKWORK_B2_SMOKE=1 npx electron .`（仅 dev 非打包模式有意义）
 * 门槛：zip 安装 → 启用 → 命令触发 → 卸载无残留。
 *
 * 走的都是**真实主进程路径**（与 IPC handler 同一批函数）：
 *   installPluginFromZip（install.ts）→ setPluginEnabled（registry.ts）
 *   → host-service.runCommand（懒激活 + host/emit 投递）
 *   → uninstallPlugin（含 teardownHook purgeData）
 * 结果落 `.arkwork/b2-smoke/result.json`，随后 `app.exit(0|1)`。
 *
 * 注：冒烟插件源与 zip 在 `.arkwork/b2-smoke/`（项目纪律：临时产物，验证后清理）。
 * ============================================================ */
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { installPluginFromZip } from '../plugins/install.js'
import { listPlugins, setPluginEnabled, uninstallPlugin } from '../plugins/registry.js'
import { getEnabledMap, pluginsDir } from '../plugins/store.js'
import { getPluginHostService } from '../plugins/runtime/host-service.js'
import { getArkworkDir } from '../store/db.js'
import { logger } from '../system/logger.js'

const PLUGIN_ID = 'ark.b2.smoke'
// 产物位置与 B1 冒烟一致：**仓库根** .arkwork/b2-smoke（app.getAppPath()=app/，上一层即仓库根）。
// 不要用 __dirname：本模块会被 electron-vite 打进 out/main/chunks/，相对层级会随打包策略漂移。
const HERE = resolve(app.getAppPath(), '..', '.arkwork', 'b2-smoke')
const ZIP = join(HERE, `${PLUGIN_ID}.zip`)
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
    logger.info('System', `[b2-smoke] ✔ ${name} — ${detail}`)
    return true
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    steps.push({ step: name, ok: false, detail })
    logger.warn('System', `[b2-smoke] ✘ ${name} — ${detail}`)
    return false
  }
}

export function maybeRunB2Smoke(): void {
  if (process.env.ARKWORK_B2_SMOKE !== '1' || app.isPackaged) return
  mkdirSync(HERE, { recursive: true })

  void (async () => {
    // 探查：app 进程视角下 zip 是否可见（排「实机看得到/看不到」歧义用）
    try {
      const lvl = (p: string) => `${existsSync(p) ? 'y' : 'n'}:${p}`
      logger.info(
        'System',
        `[b2-smoke] probe: cwd=${process.cwd()} dirname=${__dirname} HERE=${HERE}\n` +
          `[b2-smoke] probe: ${[lvl('/Users/gongzheng/ai/ArkWork/.arkwork'), lvl('/Users/gongzheng/ai/ArkWork/.arkwork/b2-smoke'), lvl(ZIP), lvl(HERE)].join(' | ')}`,
      )
    } catch (err) {
      logger.warn('System', `[b2-smoke] probe 失败：${String(err)}`)
    }
    const svc = getPluginHostService()
    if (!svc) {
      steps.push({ step: 'prerequisite', ok: false, detail: '插件运行时未就绪（getPluginHostService() 为空）' })
      finish()
      return
    }

    // ---- ① zip 安装（确认段）：落盘 + 默认禁用 ----
    let pass = await step('install', async () => {
      const r = await installPluginFromZip({ zipPath: ZIP, confirmed: true })
      if (!r.ok) throw new Error(`${r.error ?? 'UNKNOWN'}：${r.message ?? ''}`)
      const dir = join(pluginsDir('global'), PLUGIN_ID)
      if (!existsSync(join(dir, 'plugin.json')) || !existsSync(join(dir, 'main.js'))) {
        throw new Error('落盘不完整：缺 plugin.json 或 main.js')
      }
      const enabled = await getEnabledMap('global')
      if (enabled[PLUGIN_ID] !== false) throw new Error('安装后应为默认禁用（enabled map 记 false）')
      return `目录落盘 ${dir}，默认禁用`
    })

    // ---- ② 启用：走真实启停路径（偏好 + 插槽重注册 + 索引刷新） ----
    if (pass)
      pass = await step('enable', async () => {
        const on = await setPluginEnabled(PLUGIN_ID, true, 'global')
        if (!on.ok) throw new Error(`setPluginEnabled 失败：${on.reason ?? ''}`)
        const inIndex = await svc.refreshIndex()
        const entry = inIndex.find((x) => x.id === PLUGIN_ID)
        if (!entry || !entry.enabled) throw new Error('刷新索引后插件应处于 enabled')
        return `索引 enabled=true（${inIndex.length} 个插件在册）`
      })

    // ---- ③ 命令触发：懒激活 + host/emit 投递（runCommand 抛错 = 投递失败） ----
    if (pass)
      pass = await step('command', async () => {
        await svc.runCommand(PLUGIN_ID, 'ping')
        return 'runCommand 正常返回（delivered≥1；插件激活/收令日志见上方 host/log）'
      })

    // ---- ④ 卸载无残留：目录消失 + 偏好死条目被对账 + KV 无残留 ----
    if (pass)
      pass = await step('uninstall', async () => {
        const off = await uninstallPlugin(PLUGIN_ID, { purgeData: true })
        if (!off.ok) throw new Error(`uninstallPlugin 失败：${off.reason ?? ''}`)
        const dir = join(pluginsDir('global'), PLUGIN_ID)
        if (existsSync(dir)) throw new Error('插件目录仍在（残留）')
        const kv = join(getArkworkDir(), 'plugin-storage', `${PLUGIN_ID}.json`)
        if (existsSync(kv)) throw new Error('plugin-storage KV 仍在（残留）')
        const after = await listPlugins()
        if (after.some((p) => p.manifest.id === PLUGIN_ID)) throw new Error('重扫后插件仍在册（残留）')
        const enabled = await getEnabledMap('global')
        if (PLUGIN_ID in enabled) throw new Error('enabled map 死条目未被对账清掉（残留）')
        return '目录/KV/在册/偏好四处均无残留'
      })

    finish(pass)
  })()
}

function finish(pass = false): void {
  const ok = pass && steps.every((s) => s.ok)
  const summary = {
    gate: 'zip 安装 → 启用 → 命令触发 → 卸载无残留',
    ok,
    steps,
    pluginsDirAfter: (() => {
      try {
        return readdirSync(pluginsDir('global')).sort()
      } catch {
        return []
      }
    })(),
  }
  try {
    writeFileSync(RESULT, JSON.stringify(summary, null, 2))
  } catch (err) {
    logger.warn('System', `[b2-smoke] 结果落盘失败：${String(err)}`)
  }
  logger.info('System', `[b2-smoke] 门槛${ok ? '通过' : '失败'}：${steps.map((s) => `${s.step}=${s.ok ? '✔' : '✘'}`).join(' ')}`)
  // 留一点时间把日志刷出去再退
  setTimeout(() => app.exit(ok ? 0 : 1), 400)
}
