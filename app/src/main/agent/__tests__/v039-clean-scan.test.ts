/**
 * v0.39.0 详测 — 清创守卫（TC-CLEAN-001…010）
 *
 * 依据：docs/versions/v0.39.0/04-system-design.md §5（W14–W21）、§7（D186/D189/D190/D194/D196）
 *       docs/versions/v0.39.0/01-research.md §1.3（零生产引用导出清创候选表）
 *
 * 这一组全是**反向守卫**：不测"功能对不对"，测"该消失的东西没有偷偷回来"。
 * 每个版本的清创都会被后来的人重新加回一两处 —— 没有守卫，收敛等于没做（纪律⑮）。
 *
 * ⚠️ 纪律⑫/㉒：源码断言前必须剥注释，且只用唯一真源 `@shared/utils/source-guard`
 *    （自写块注释正则会吞掉字符串里的 `/*` 之后的真实代码）。
 * ⚠️ 纪律㉙：全仓扫描走 `@shared/utils/repo-scan` 的**每进程一次**快照，
 *    不在用例内重复 walk/read（D158 的教训：5 个守卫用例各扫一遍全仓 = 吃掉 83% 测试时间）。
 * ⚠️ 纪律⑫：`__dirname` 断言不能写「全文件不得出现 `__dirname`」—— b2-smoke.ts:65 的
 *    诊断探针把 `${__dirname}` 插进**模板字符串**（那是字符串不是注释，剥注释剥不掉），
 *    判据必须是「它没被用作路径基址」。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs v039-clean-scan
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRepoScan } from '@shared/utils/repo-scan'

const SRC = fileURLToPath(new URL('../../..', import.meta.url)) // → app/src
const REPO_AGENT = join(SRC, 'main', 'agent')

const scan = getRepoScan(SRC)
const rel = (abs: string): string => relative(SRC, abs).split('\\').join('/')

/** 生产侧（已排除 `__tests__` 与 `*.test.ts(x)`）—— 清创守卫的主要扫描对象 */
const PROD = scan.production.map((abs) => ({ abs, rel: rel(abs) }))
/** 全仓（含测试）—— 用于「只统计引用次数」这类不判违规的场景 */
const ALL = scan.all.map((abs) => ({ abs, rel: rel(abs) }))
const code = (abs: string): string => scan.stripped(abs)
const text = (abs: string): string => scan.raw(abs)

const { RETIRED_PLAN_TOOLS } = await import('../engine/work-class.js')
const { PLAN_TOOL_HINT, PLAN_TOOL_NAME } = await import('../ledger/hint.js')

/* ============================================================
 * TC-CLEAN-001 ★ 模型可见文案不得教模型调已下架工具（D186 / D189）
 * ============================================================ */

test('TC-CLEAN-001 ★ 模型可见文案：不得出现「用/调用 <已下架工具>」形态', () => {
  assert.ok(RETIRED_PLAN_TOOLS.length >= 9, '前提：退役表非空（事实源在被测集里）')
  // 判据只认「指引模型去调某个工具」的形态 —— 泛指出现不算违规：
  //   · 迁移/兜底映射（tasks.migrate / action-description）必须保留历史名，否则旧数据渲染不出来
  //   · 真值表夹具（tool-name-hint.test）刻意含历史名，见该文件头注释
  // 用全仓（含测试）扫，测试命中单独说明。
  const shape = new RegExp(
    `(调用|改用|请用|使用)\\s*[\`'"]?(${RETIRED_PLAN_TOOLS.map((t) => t.replace(/-/g, '\\-')).join('|')})\\b`,
  )
  const hits: string[] = []
  for (const f of ALL) {
    if (f.rel.includes('__tests__')) continue // 夹具/说明不算模型可见文案
    for (const line of code(f.abs).split('\n')) {
      if (shape.test(line)) hits.push(`${f.rel}: ${line.trim().slice(0, 120)}`)
    }
  }
  assert.deepEqual(
    hits,
    [],
    `★ 模型照做必吃软失败（act.ts 退役兜底），且这些字符串是模型可见通道：\n${hits.join('\n')}`,
  )
})

test('TC-CLEAN-002 清单控制面文案只有一个事实源（PLAN_TOOL_HINT）', () => {
  // 消费方数量下限（纪律⑮：收敛必须带「禁止新增绕过」的守卫）
  const consumers = ALL.filter(
    (f) => !f.rel.endsWith('ledger/hint.ts') && /\bPLAN_TOOL_HINT\b/.test(code(f.abs)),
  ).map((f) => f.rel)
  assert.ok(
    consumers.length >= 3,
    `★ PLAN_TOOL_HINT 必须被多个模块消费（实测 ${consumers.length}：${consumers.join(', ')}）`,
  )
  for (const need of ['graph/invariants.ts', 'graph/replan.ts', 'graph/gate.ts', 'engine/ledger-guard.ts']) {
    assert.ok(
      consumers.some((c) => c.endsWith(need)),
      `${need} 必须引唯一事实源。实测消费方：${JSON.stringify(consumers)}`,
    )
  }
  // 提示表自身不许硬编工具名（除唯一名常量）
  const hintSrc = text(join(REPO_AGENT, 'ledger/hint.ts'))
  assert.match(hintSrc, /export const PLAN_TOOL_NAME = 'task_plan'/)
  assert.equal(PLAN_TOOL_HINT.update.includes(PLAN_TOOL_NAME), true, '文案由常量插值而来')
})

/* ============================================================
 * TC-CLEAN-003 ★ 零引用导出不得复活（研究表 §1.3）
 * ============================================================ */

test('TC-CLEAN-003 ★ 已删除的零引用导出不得复活', () => {
  // 只列**已被删除且不应回来**的；`forceCloseOpenItems` 不在列表里 —— 它已接线（D178），
  // 有 2 个真实调用点，属于"必须存在"。
  //
  // ⚠️ 也不含 `applyPlanItemStatusesRobust`：研究表 §1.3 把它列为**候选**，但核查后
  //    它是「零生产引用、仅自己的回归套件在调」—— 删它等于删掉 D123 的两级定位回归
  //    （图镜像域），属 TaskGraph 整体退役的决策范围。**候选 ≠ 已删**，守卫只钉已删的
  //    （纪律㉛：守卫断言必须反映真实做过的清创，否则就是用测试伪造进展）。
  const mustBeGone = [
    'renderTree',
    'getLedgerVersion',
    'hasPendingResume',
    'getTaskById',
    'LEDGER_MODES',
    'isLedgerMode',
    'GRAPH_TOOL_NAMES',
    'DISABLEABLE_GRAPH_TOOLS',
    'getSpecsConfigPath',
    'ReadonlyTool',
    'set-status-by-index',
    'refuseCompletionForLeftovers',
    'MAX_COMPLETE_REFUSALS',
    'MAX_PLAN_DEPTH',
    // D196：转发壳连同定义一起删（全 src 唯一出现处就是那个 export { }）
    'assigneeLabel',
  ]
  const hits: string[] = []
  for (const f of PROD) {
    const src = code(f.abs)
    for (const name of mustBeGone) {
      // 只在**导出/赋值/引用**位置命中才算复活（注释已被剥离）
      const re = new RegExp(`(export\\s+(async\\s+)?(function|const|type|interface|enum)\\s+${name}\\b)|(\\b${name}\\s*[(:=)])`)
      if (re.test(src)) hits.push(`${f.rel} → ${name}`)
    }
  }
  assert.deepEqual(hits, [], `★ 这些导出已按 §1.3 清创删除，不得复活：\n${hits.join('\n')}`)
})

test('TC-CLEAN-004 废弃模块 plan-regex 已删除且无 import 残留', () => {
  assert.equal(existsSync(join(REPO_AGENT, 'engine/plan-regex.ts')), false, '★ plan-regex.ts 应已删除（被 planning/parse.ts 取代）')
  // 判据只认「import / require 该模块」——日志标签 `plan-regex:` 只是字符串，不构成依赖
  const hits = PROD.filter((f) =>
    /from\s+['"][^'"]*plan-regex|require\(['"][^'"]*plan-regex/.test(code(f.abs)),
  ).map((f) => f.rel)
  assert.deepEqual(hits, [], `不得再 import 已删除模块：${hits.join(', ')}`)
})

/* ============================================================
 * TC-CLEAN-005 planning 模块不留死常量
 * ============================================================ */

test('TC-CLEAN-005 planning/types.ts 不留死常量（判据：全仓只出现一次 = 只有声明本身）', () => {
  const typesAbs = join(REPO_AGENT, 'planning/types.ts')
  const decls = [...code(typesAbs).matchAll(/export const (\w+)/g)].map((m) => m[1]!)
  assert.ok(decls.length >= 5, `前提：至少 5 个阈值常量（实测 ${decls.length}）`)
  const dead: string[] = []
  for (const name of decls) {
    // ⚠️ 判据是「全仓总出现次数 ≤ 1」而不是「本文件外无人引用」：
    //    后者会误杀合法用例 —— 例如 `PLANNER_TRIGGERS` 由本文件的
    //    `PlannerTrigger = (typeof PLANNER_TRIGGERS)[number]` 消费，
    //    这种「数组推导类型」恰恰是我们要的唯一事实源写法。
    const total = ALL.reduce(
      (n, f) => n + (code(f.abs).match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0),
      0,
    )
    if (total <= 1) dead.push(name)
  }
  // `MAX_PLAN_DEPTH = 2` 就是这么被逮到的：「定义了但没人用」的常量比没有常量更坏 ——
  // 它让人以为改这里能改行为（层级上限的唯一执法点在 ops.ts），是假的事实源（纪律㉚③）。
  assert.deepEqual(dead, [], `★ 零消费的阈值常量（假事实源）：${dead.join(', ')}`)
})

test('TC-CLEAN-006 渲染层的当前工具名判定不得含历史名', () => {
  assert.doesNotMatch(
    code(join(REPO_AGENT, 'engine/gates.ts')),
    /'todo-update'|'todo_update'/,
    '★ gates.ts PRODUCTIVE 集合里的 todo-update 永不命中（act.ts 已用 isPlanTool 排除清单族）',
  )
  // 判据：**当前**工具名单里不得只剩历史名。`TOOL_DISPLAY` 必须覆盖 `task_plan` / `turn_note`
  // （v0.38 收敛后唯一的两个入口）—— 此前表里没有它们，用户看到机械英文名（D190）。
  const constantsAbs = join(SRC, 'renderer/constants.ts')
  const constants = code(constantsAbs)
  assert.match(constants, /^\s*task_plan:\s*\{/m, '★ TOOL_DISPLAY 必须有 task_plan 条目（D190）')
  assert.match(constants, /^\s*turn_note:\s*\{/m, '★ TOOL_DISPLAY 必须有 turn_note 条目（D190）')
  assert.match(constants, /const\.tool\.taskPlan/, '文案必须走 i18n（不得硬编码中文）')
  // 四语言必须同步（少一个 → 该语言下显示 key 原文）
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    assert.match(
      text(join(SRC, 'renderer/i18n/locales', `${lang}.json`)),
      /"taskPlan":\s*"..*"/,
      `★ locales/${lang}.json 缺 const.tool.taskPlan`,
    )
  }
  // 历史名只允许出现在「展示映射」这一处，且必须带上是历史用的说明。
  // ⚠️ 这一条**故意读未剥注释的原文** —— 被断言的正是注释本身。
  assert.match(
    text(constantsAbs),
    /只为渲染旧会话/,
    '★ 保留历史名条目必须写明「只为渲染旧会话」—— 否则下一个人会以为 todo_update 还在册',
  )
})

/* ============================================================
 * TC-CLEAN-007 层级上限只许一处执法
 * ============================================================ */

test('TC-CLEAN-007 层级上限判据全仓只出现一处（生产代码）', () => {
  const hits = PROD.filter((f) => /层级最多两层/.test(code(f.abs))).map((f) => f.rel)
  assert.deepEqual(
    hits,
    ['main/agent/ledger/ops.ts'],
    '★ 层级判据只许在 ops.ts plan-commit（plan-diff 只负责解析引用）。实测：' + (hits.join(', ') || '（无）'),
  )
  assert.match(PLAN_TOOL_HINT.update, /task_plan/, '提示常量与工具表同源')
})

/* ============================================================
 * TC-CLEAN-008/009 构建产物不得夹带冒烟残留（D194）
 *
 * 现象：`ArkWork.app/Contents/Resources/app.asar` 里有 `/out/.arkwork/b2-smoke/result.json`
 *       （2026-09-20 的一次 **ok:false** 冒烟结果），随包交付。
 * 根因：`b2-smoke.ts` 早期版本用 `resolve(__dirname, '..', '..', '.arkwork', …)` 推产物目录；
 *       electron-vite 把主进程打进 `out/main/chunks/`，于是 `__dirname` 推导出的是
 *       **构建产物内部**的 `out/.arkwork/`，而不是仓库根 `.arkwork/`。
 *       源码后来改成 `app.getAppPath()` 并在注释里写了「不要用 __dirname」（根因已修），
 *       但那一次写下的文件**没有任何机制去发现**，于是被 electron-builder 原样打进 asar。
 *
 * 教训：修根因 ≠ 清现场。凡是"构建产物目录本身会被打包"的仓库，
 *      都必须有一条**扫现场**的用例，否则残留会以「字节数不大、没人看得见」的方式长期随包出货。
 * ============================================================ */

test('TC-CLEAN-008 ★ 构建产物 out/ 不得夹带 .arkwork 冒烟残留（D194）', () => {
  // app/out —— 打包时被 electron-builder 收进 app.asar 的那棵树
  const OUT = join(SRC, '..', 'out')
  if (!existsSync(OUT)) return // 未构建环境（CI 首跑）无现场可查，不算通过也不算失败
  const entries = readdirSync(OUT)
  // 先自证「看的是对的那棵树」：没有这条，路径写错会得到一个永远绿的用例（纪律㉚③）
  assert.ok(
    entries.includes('main') && entries.includes('renderer'),
    `前提校验：${OUT} 应是 electron-vite 产物根（实测 ${entries.join(', ')}）`,
  )
  const residue = entries.filter((n) => n === '.arkwork' || n.startsWith('.arkwork-'))
  assert.deepEqual(
    residue,
    [],
    `★ out/ 下不得有冒烟残留（会被打进 app.asar）：${residue.join(', ')}\n` +
      '  产物目录请走 app.getAppPath() 推导（见 TC-CLEAN-009），存量残留直接删。',
  )
})

test('TC-CLEAN-009 ★ 冒烟产物目录必须由 app.getAppPath() 推导（D194 根因守卫）', () => {
  for (const mod of ['dev/b2-smoke.ts', 'dev/b3-smoke.ts']) {
    const abs = join(SRC, 'main', mod)
    assert.ok(existsSync(abs), `前提：${mod} 存在`)
    const src = code(abs)
    // ① 路径基址必须是 app.getAppPath()
    const hereStmt = src.split('\n').find((l) => /const\s+HERE\s*=/.test(l))
    assert.ok(hereStmt, `${mod} 应有 const HERE = … 约定`)
    assert.match(
      hereStmt!,
      /app\.getAppPath\(\)/,
      `★ ${mod} 的 HERE 必须基于 app.getAppPath()（打包后 __dirname 指向 out/main/chunks）`,
    )
    // ② __dirname 不得出现在任何路径拼接里（模板字符串里的诊断插值不算 —— 它不是路径基址）
    assert.doesNotMatch(
      src,
      /(?:resolve|join)\s*\(\s*__dirname/,
      `★ ${mod} 不得用 resolve/join(__dirname, …) 拼产物路径（D194 根因）`,
    )
  }
})

/* ============================================================
 * TC-CLEAN-010 纯转发壳导出（D196）
 *
 * 形态：`import { X } from './真源.js'` + `export { X }`，而 X 在本文件里
 * **没有被用过一次** —— 这个 export 存在的唯一效果是给同一个 X 造出第二条 import 路径。
 * 它是「模块树已改、转发壳没删」的残渣（与 D192① 批评 `plan-regex.ts`
 * "薄封装保留导出名" 是同一件事，只是发生在同文件内）。
 *
 * 判据的边界（为什么只到 Level 1）：
 *   Level 1（本用例）=「本文件内该名字总出现次数 ≤ 2」→ 只可能是 import + export 两处，
 *                      再加一条排除：「本模块被别处以 `export { … } from '本模块'` 再导出」的
 *                      不算壳（那是**有意的门面链**，例如 `engine-context.ts` 转发 `llm-call.js`）。
 *                      零误报的前提正是这第二条 —— 首版没有它，实测立刻误报
 *                      `llm-call.ts → isContextOverflowError`（它有真实门面消费者）。
 *   Level 2（模块图）=「全仓无人从本模块导入该名字」→ 更彻底，但启发式解析 import
 *                      路径会误报（实测一次扫描给出 20 条候选，其中 `ipcMain`、
 *                      `getWorkspaceDir`、`EditorPanel` 等经核实都有真实消费者，
 *                      只是走了别名/多跳再导出）。**带误报的守卫等于假守卫**，
 *                      所以 Level 2 只做人工清点（见 01-research §1.3 候选表），不进用例。
 * ============================================================ */

/**
 * 检测器：返回「纯转发壳」名字（本文件内只出现在 import 与 export 两处）。
 * 只认 `export { A, B }`（**无 `from`**）—— 带 `from` 的是真·再导出模块（facade 有明确意图），
 * `export { x as y }` 这类别名形态交人工，不在此判据内。
 */
function findPassthroughReexports(src: string): string[] {
  const names = new Set<string>()
  for (const m of src.matchAll(/^export \{([^}]+)\}$/gm)) {
    for (const raw of m[1]!.split(',')) {
      const n = raw.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
    }
  }
  const out: string[] = []
  for (const n of names) {
    const total = src.match(new RegExp(`\\b${n}\\b`, 'g'))?.length ?? 0
    if (total <= 2) out.push(n)
  }
  return out
}

/**
 * 门面链名单：别处以 `export { … } from '<spec>'` 再导出的名字，按 `<spec>` 的
 * 文件名（去 `.js`）归类。用来把「有意的门面」从「纯转发壳」里剔出去。
 */
function collectFacadeChainNames(): Map<string, Set<string>> {
  const byModuleBasename = new Map<string, Set<string>>()
  for (const f of ALL) {
    const src = code(f.abs)
    for (const m of src.matchAll(/export\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
      const base = (m[2]!.split('/').pop() ?? '').replace(/\.js$/, '')
      if (!base) continue
      if (!byModuleBasename.has(base)) byModuleBasename.set(base, new Set())
      for (const raw of m[1]!.split(',')) {
        const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!
        if (/^[A-Za-z_$][\w$]*$/.test(n)) byModuleBasename.get(base)!.add(n)
      }
    }
  }
  return byModuleBasename
}

test('TC-CLEAN-010 ★ 纯转发壳导出不得复活（本文件内只 import + export 两处）', () => {
  // ① 检测器自检（纪律⑮/D102：收敛若不带守卫等于没收敛，守卫若不自检等于假守卫）
  assert.deepEqual(
    findPassthroughReexports("import { foo } from './x.js'\n\nexport { foo }\n"),
    ['foo'],
    '检测器自检：只 import + export 的名字必须被抓到',
  )
  assert.deepEqual(
    findPassthroughReexports("import { foo } from './x.js'\n\nconst y = foo(1)\nexport { foo }\n"),
    [],
    '检测器自检：本文件真用过的名字不得误报',
  )
  assert.deepEqual(
    findPassthroughReexports("export { bar } from './x.js'\n"),
    [],
    '检测器自检：带 from 的再导出模块不在此判据内',
  )

  // ② 真扫：planning / graph / agent 三个已清创目录
  const facade = collectFacadeChainNames()
  const offenders: string[] = []
  for (const dir of ['planning', 'graph', '.']) {
    const abs = join(REPO_AGENT, dir)
    for (const f of readdirSync(abs)) {
      if (!f.endsWith('.ts') || f.includes('.test.')) continue
      const base = f.replace(/\.ts$/, '')
      const chained = facade.get(base) ?? new Set<string>()
      for (const n of findPassthroughReexports(code(join(abs, f)))) {
        if (chained.has(n)) continue // 有意的门面链：别处正在 `export { N } from '本模块'`
        offenders.push(`${dir === '.' ? 'agent/' : `${dir}/`}${f} → ${n}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `★ 纯转发壳（本文件根本没用的再导出，只留下架模块的活口）：\n${offenders.join('\n')}`,
  )
})
