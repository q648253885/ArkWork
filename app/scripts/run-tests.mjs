#!/usr/bin/env node
/* ============================================================
 * ArkWork — 统一测试 runner（v0.27.0 R0）
 *
 * 取代 package.json 里 15 段手工 && 串接：
 *   - 自动发现 src 下所有 __tests__ 目录中的 *.test.ts / *.test.tsx
 *   - 所有套件统一挂 src/test/electron-mock-loader.mjs（单份 electron 桩）
 *   - 陈年红灯套件显式列入 EXCLUSIONS（带原因），逐版清账，不许静默新增
 *   - 支持过滤：node scripts/run-tests.mjs <substring> [more-substrings...]
 *
 * ★ v0.37.0（D146）：并发数可调 —— `TEST_CONCURRENCY=<n>`。
 *   背景：node:test 默认按 CPU 并行起子进程（每文件一进程）。在**受限沙箱**
 *   （如 WorkBuddy 的 brokered-fs 环境）下，多子进程同时申请「运行时文件规则」
 *   会耗尽规则池，表现为**套件在第 1 个文件之后静默停滞**（无报错、无输出、
 *   不退出）—— 实测 `--test-concurrency` 3 与默认值均停滞，1 稳定通过。
 *   故这里透传一个显式旋钮；**默认不设**，保持与历史测量口径一致。
 * ============================================================ */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// v0.38.1（D164）：按 node 版本构造 flag 的纯函数（单一事实源，TC-RUNNER 直测）
import {
  buildCleanupInjection,
  buildTsLoaderArgs,
  nodeSupport,
  parseNodeVersion,
  resolvePoolSize,
} from './run-tests-args.mjs'

const APP_ROOT = pathResolveHere()
function pathResolveHere() {
  // scripts/run-tests.mjs → app/
  return fileURLToPath(new URL('..', import.meta.url))
}

/** 已知红灯/环境不兼容套件（显式欠账清单；修复后请从此处移除） */
const EXCLUSIONS = [
  {
    match: 'e2e-memory-l4-llm.test.ts',
    reason: 'TODO(v0.28): 依赖真实 models.json apiKey + 外网 + deepseek-v4-flash，非密闭套件；单跑见该文件头注释',
  },
]

const LOADER_REL = 'src/test/electron-mock-loader.mjs'

/* ------------------------------------------------------------------
 * ★ v0.37.0（D148）：清扫测试遗留的临时工作区（系统性夹具卫生）
 *
 * 背景（实测）：全仓 30 处 `mkdtempSync` 的前缀**全部**以 `arkwork-` 开头，
 * 但其中 **23 个文件只清「最后一个」或完全不清理**（`after()` 里 `rmSync(WS)`
 * 的 WS 是模块级变量，被 `beforeEach` 反复覆盖）。实测累积：`arkwork-dp-ws-*`
 * **1301 个**、`arkwork-*` 合计 **7622 个**，TMPDIR 单项数 9420。
 * 后果不是"占点磁盘"——而是**目录操作变慢**，把「N 秒内必须发生某事」的
 * 用例门槛（`waitFor(谓词, 5000)`）推爆（D145 / D147 的共同放大器），
 * 且每轮全量继续新增约千个 → **越跑越慢、越跑越红**的自我强化循环。
 *
 * 这里做两层防护：① 运行**前**清上一轮遗留（打破循环）；② 运行**后**清本轮遗留。
 * 安全约束：前缀白名单写死 `arkwork-` + 名字须匹配 `^arkwork-<slug>$` + 只删目录；
 * 清理失败（占用中）只跳过不阻断。`ARKWORK_TEST_KEEP_TMP=1` 可关闭。
 * ------------------------------------------------------------------ */
const TMP_PREFIX = 'arkwork-'
const TMP_NAME_RE = /^arkwork-[A-Za-z0-9._-]+$/

/* ------------------------------------------------------------------
 * ★ v0.39.0（D191）：**本 run 的命名空间**。
 *
 * 背景（实测，非推断）：slot 目录与 TAP 日志名此前**只按序号**命名 ——
 *   · `$TMPDIR/arkwork-pool-tmp-<slot>`        两个 run 用同一路径 → 夹具互踩
 *   · `$TMPDIR/arkwork-tests-file-<n>.log`     两个 run 同名 → 日志互相覆盖
 * 更致命的是清扫：子进程注入的 `tmp-cleanup` 会**无条件**清掉自己 TMPDIR 里的
 * 一切，而 `pruneTempWorkspaces('运行后')` 的 `minAgeMs=0` 会清掉全局 tmpdir 里
 * **全部** `arkwork-*`（含另一个 run **正在使用**的 slot 目录）。启动那次虽有
 * 5 分钟年龄门，但长跑（全量约 11 分钟）中启动的第二个 run 同样会跨过门槛。
 * 后果不是"跑得慢"，而是**失败无法归因** —— 实测一轮 7 个红里 6 个由互踩产生，
 * 日志被覆盖后连报错原文都取不到（纪律㉕：先分诊代码红 vs 环境红，但前提是
 * 证据本身没被另一个进程毁掉）。
 *
 * 修法：命名空间按 **PID** 隔离 + prune 只回收**自己的** slot（其他人的 slot
 * 仅在"明显已死"时按年龄回收）。单 run 语义与此前逐字等价。
 * ------------------------------------------------------------------ */
const RUN_TAG = String(process.pid)
const SLOT_PREFIX = `${TMP_PREFIX}pool-tmp-`
const OWN_SLOT_PREFIX = `${SLOT_PREFIX}${RUN_TAG}-`
/** 其他 run 的 slot：只在「明显已死」时回收（活跃 run 会持续重建，2h 足够宽容） */
const STALE_FOREIGN_SLOT_MS = 2 * 60 * 60 * 1000

function pruneTempWorkspaces(label, minAgeMs = 0) {
  if (process.env.ARKWORK_TEST_KEEP_TMP === '1') return
  const dir = tmpdir()
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const now = Date.now()
  let removed = 0
  for (const e of entries) {
    if (!e.isDirectory() || !NAME_RE_GUARD(e.name)) continue
    const full = join(dir, e.name)
    // v0.39.0（D191）：**别的 run 的 slot 目录一律不碰**（活跃的并发 run 正在用）。
    // 只回收陈年残留，避免"运行后 minAge=0"把并发 run 的夹具一起清掉。
    if (e.name.startsWith(SLOT_PREFIX) && !e.name.startsWith(OWN_SLOT_PREFIX)) {
      try {
        if (now - statSync(full).mtimeMs < STALE_FOREIGN_SLOT_MS) continue
      } catch {
        continue
      }
    } else if (minAgeMs > 0) {
      // 并发保护：只清「旧」遗留，绝不动同时运行的另一个套件正在使用的目录
      try {
        if (now - statSync(full).mtimeMs < minAgeMs) continue
      } catch {
        continue
      }
    }
    try {
      rmSync(full, { recursive: true, force: true })
      removed += 1
    } catch {
      /* 占用中 / 权限：跳过，不阻断测试 */
    }
  }
  if (removed > 0) {
    console.log(
      `[run-tests] ${label}清扫遗留临时工作区 ${removed} 个（前缀 ${TMP_PREFIX}*${minAgeMs ? `，仅清 ${minAgeMs / 1000}s 前的` : ''}；ARKWORK_TEST_KEEP_TMP=1 可关闭）`,
    )
  }
}

/** 名字白名单：arkwork-<slug>（避免误删同前缀的其它工具目录） */
function NAME_RE_GUARD(name) {
  return name.startsWith(TMP_PREFIX) && TMP_NAME_RE.test(name)
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.test\.(ts|tsx)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

async function main() {
  const filters = process.argv.slice(2)
  const all = walk(join(APP_ROOT, 'src'), [])
  const relAll = all.map((p) => relative(APP_ROOT, p).split(sep).join('/')).sort()

  let candidates = relAll
  for (const reason0 of EXCLUSIONS) {
    candidates = candidates.filter((p) => !p.includes(reason0.match))
  }
  if (filters.length > 0) {
    candidates = candidates.filter((p) => filters.some((f) => p.includes(f)))
  }

  if (candidates.length === 0) {
    console.error('[run-tests] 未匹配到任何测试文件（filters=%s）', filters.join(' ') || '<none>')
    process.exit(1)
  }
  console.log(`[run-tests] 共 ${relAll.length} 个测试文件，本轮执行 ${candidates.length} 个（排除 ${EXCLUSIONS.length} 个显式欠账）`)
  for (const ex of EXCLUSIONS) console.log(`  [excluded] ${ex.match} —— ${ex.reason}`)

  // v0.38.0（D158）：**为什么不再调 `node_modules/.bin/tsx`** —— node:test 给每个测试
  // 文件各起一个子进程，而 `tsx` CLI 本身是个包装器（shell → node → 再 fork node + esbuild），
  // 单次启动实测 **5.1–6.0s**；换成同进程注册 tsx loader，单文件实测 **2.7–3.0s**。
  // v0.38.1（D164）：**版本自适应** —— `--import` 是 node v20.6.0 才引入的旗标，用户实机
  // v18.11.0 直接 `bad option: --import`（D158 方案在本机从未跑通过的根因）。低版本走
  // 双 loader 链（`--experimental-loader tsx/esm`，实测单文件 0.7s），高版本保留快路径。
  const nodeBin = process.execPath
  const support = nodeSupport(parseNodeVersion(process.version))
  const loaderUrl = pathToFileURL(join(APP_ROOT, LOADER_REL)).href
  const loaderArgs = buildTsLoaderArgs(support, loaderUrl)
  const absFiles = candidates.map((p) => join(APP_ROOT, p))

  // v0.37.0（D146）→ v0.38.1（D164 rev2）：`TEST_CONCURRENCY` 旋钮由全局并发池
  // 直接消费（见下），不再走 `--test-concurrency` 旗标 —— node < 18.17 本没有该
  // 旗标，旧实现只在 ≥18.17 上生效且沙箱下会静默停滞；池化后对所有版本语义一致。
  // v0.38.0（D158）的 `TEST_ISOLATION=none` 随池化移除：池模式每文件本就是独立
  // 进程（隔离由构造保证），同进程模式不再有意义。

  // v0.37.0（D148）：先清上一轮遗留（仅清 5 分钟前的，避免误伤并发套件），
  // 再跑，跑完清本轮（见 pruneTempWorkspaces 注释）
  pruneTempWorkspaces('运行前', 300_000)

  // v0.37.0（D148）：把「进程退出清扫」注入每个 node 子进程（含 node:test 的嵌套 runner）。
  // 用 NODE_OPTIONS 而不是 execArgv —— 嵌套 runner 只继承 NODE_OPTIONS，不继承 execArgv。
  // 必须**追加**而不是覆盖：宿主环境可能已用 NODE_OPTIONS 注入 shim（覆盖会静默失效）。
  // v0.38.1（D164）：node < 20.6 不允许 `--import` 进 NODE_OPTIONS → 低版本改 `--require`
  // CJS shim（tmp-cleanup.cjs，行为逐行等价）；注入选择收敛在 run-tests-args.mjs。
  const cleanupInjection = buildCleanupInjection(
    support,
    pathToFileURL(join(APP_ROOT, 'src/test/tmp-cleanup.mjs')).href,
    join(APP_ROOT, 'src/test/tmp-cleanup.cjs'),
  )
  const childEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${cleanupInjection.flag} ${cleanupInjection.url}`.trim(),
  }

  // v0.38.1（D164 rev2）：**全局并发池** 取代 v0.38.0 D162 的「分片 × 片内」两层并发。
  //
  // 实测根因：node 18.11 无 `--test-concurrency`（18.17 才有），分片内并发不可控
  // （默认 ≈ cpu-1）；8 核机上 6 分片 × 7 ≈ 42 个并发 node 进程严重过载，时敏用例
  // （waitFor 期限类）随机爆线 —— 两轮全量失败集**轮换**（21 → 7 个文件，无稳定根因），
  // 全部单跑复验皆绿（环境红）。
  //
  // 方案：runner 自己维护 **K 路全局并发池**，每文件一个独立 `node --test <file>`
  // 子进程（隔离语义不变），K 即总并发，任何 node 版本都精确可控：
  //   · K 默认 min(cpu-1, 8)；TEST_CONCURRENCY / TEST_SHARDS 均可覆盖（后者语义
  //     从「分片数」收敛为「池大小」，历史旋钮全部兼容）。
  //   · 每文件独立 TMPDIR（`arkwork-pool-tmp-<pid>-<slot>`，按 worker 槽复用）—— 否则
  //     某文件退出时的 tmp-cleanup 会删掉**并行文件**正在用的临时工作区
  //     （D162 分片修订的同一根因，下沉到文件粒度）。
  //     v0.39.0（D191）追加 `<pid>` 段：只按槽号命名时，**两个 run 进程**共用同一
  //     目录、同一批日志名，互踩夹具 + 覆盖日志 → 失败不可归因。
  //   · 每文件 TAP 落 `$TMPDIR/arkwork-tests-file-<pid>-<n>.log`，跑完聚合。
  const { spawn } = await import('node:child_process')
  const { openSync, readFileSync } = await import('node:fs')
  const poolSize = Math.min(
    resolvePoolSize(process.env.TEST_CONCURRENCY, process.env.TEST_SHARDS, cpus()?.length ?? 2),
    absFiles.length,
  )
  const t0 = Date.now()
  console.log(`[run-tests] 全局并发池：${poolSize} 路 × ${absFiles.length} 文件（node ${process.version}）`)

  const results = await new Promise((resolveAll) => {
    const out = []
    let next = 0
    let fileSeq = 0
    async function worker(slot) {
      const slotTmp = join(tmpdir(), `${OWN_SLOT_PREFIX}${slot}`)
      mkdirSync(slotTmp, { recursive: true })
      const slotEnv = { ...childEnv, TMPDIR: slotTmp }
      while (next < absFiles.length) {
        const file = absFiles[next++]
        const logPath = join(tmpdir(), `arkwork-tests-file-${RUN_TAG}-${fileSeq++}.log`)
        const fd = openSync(logPath, 'w')
        const code = await new Promise((resolveOne) => {
          const child = spawn(nodeBin, [...loaderArgs, '--test', file], {
            cwd: APP_ROOT,
            env: slotEnv,
            stdio: ['ignore', fd, fd],
          })
          child.on('exit', (c) => resolveOne(c ?? 1))
          child.on('error', () => resolveOne(1))
        })
        out.push({ file, logPath, code })
      }
    }
    const workers = Array.from({ length: poolSize }, (_, i) => worker(i))
    Promise.all(workers).then(() => resolveAll(out))
  })

  pruneTempWorkspaces('运行后')
  let fail = 0
  const failures = []
  for (const r of results) {
    let text = ''
    try { text = readFileSync(r.logPath, 'utf-8') } catch { /* 不阻断 */ }
    const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : 0 }
    const fileFail = r.code !== 0 || num(/^# fail (\d+)/m) > 0
    if (fileFail) {
      fail += 1
      const rel = relative(APP_ROOT, r.file)
      failures.push(`  ✗ ${rel}`)
      // 摘录该文件内失败的用例名（缩进级 not ok 行）
      for (const line of text.split('\n')) {
        if (/^\s+not ok /.test(line)) failures.push(`      ${line.trim()}`)
      }
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n[run-tests] 汇总：${results.length} 文件，fail=${fail}（${secs}s）`)
  if (failures.length > 0) {
    console.log('--- failures ---')
    for (const f of failures.slice(0, 60)) console.log(f)
    if (failures.length > 60) console.log(`  … 其余 ${failures.length - 60} 条见 $TMPDIR/arkwork-tests-file-*.log`)
  }
  process.exit(fail > 0 ? 1 : 0)
}

await main()
