/* ============================================================
 * ArkWork — 仓库源码快照（测试基建 · v0.38.0 D158）
 *
 * ★ 为什么要有这个文件
 *   沙箱（brokered-fs）下每次 `readFileSync` 实测 ≈ 30–100ms，全仓 ~700 个
 *   .ts/.tsx 一次全扫 ≈ 20–70s。此前的守卫用例（TC-DEAD-* / TC-D102-* /
 *   TC-HARN-001）**各自**做全仓扫描，且 `dead-code-gate` 的 TC-DEAD-005 是对
 *   「每个 widget」各扫一遍 —— 实测这 5 个用例吃掉了全量测试时间的 **83%**
 *   （242s / 290s，见 v0.38.0 收尾实测），是「测试从 1 分钟涨到小时级」的主因之一。
 *
 *   本模块把「walk + read + stripComments」收敛为**每进程一次**的缓存快照，
 *   供各守卫文件共享同一份内存数据。语义与各自原来的实现逐字对齐
 *   （walk 规则 = `scripts/run-tests.mjs` 的口径 + `__tests__` 排除），只消除重复 I/O，
 *   不改变任何判定。
 *
 * ★ 为什么放在 shared/utils
 *   与 `source-guard.ts` 同理：它是「测试与守卫共用的基础设施」，且必须被
 *   `@shared/` 别名解析（loader 只认这个前缀）。生产代码不 import 它，
 *   故不会进任何 bundle。
 * ============================================================ */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './source-guard'

export interface RepoScan {
  /** 生产代码：`.ts/.tsx`，排除 `__tests__` 目录与 `*.test.ts(x)` */
  readonly production: readonly string[]
  /** 测试侧：`*.test.ts(x)`（全仓，含 `__tests__` 内外的）∪ `__tests__` 目录内文件 */
  readonly testSide: readonly string[]
  /** 全部 `.ts/.tsx`（含生产 + 测试 + 基建） */
  readonly all: readonly string[]
  /** 原文（惰性读 + 进程内缓存） */
  raw(abs: string): string
  /** 剥注释后的源码（惰性 + 进程内缓存）—— 守卫断言一律用它（纪律⑫/㉒） */
  stripped(abs: string): string
}

interface MutableScan {
  srcRoot: string
  production: string[]
  testSide: string[]
  all: string[]
  rawCache: Map<string, string>
  strippedCache: Map<string, string>
}

function walk(srcRoot: string, dir: string, acc: MutableScan, inTestsDir: boolean): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue
      walk(srcRoot, full, acc, inTestsDir || ent.name === '__tests__')
      continue
    }
    if (!/\.(ts|tsx)$/.test(ent.name)) continue
    acc.all.push(full)
    const isTestFile = /\.test\.tsx?$/.test(ent.name)
    if (isTestFile || inTestsDir) acc.testSide.push(full)
    if (!isTestFile && !inTestsDir) acc.production.push(full)
  }
}

function build(srcRoot: string): RepoScan {
  const acc: MutableScan = {
    srcRoot,
    production: [],
    testSide: [],
    all: [],
    rawCache: new Map(),
    strippedCache: new Map(),
  }
  walk(srcRoot, srcRoot, acc, false)
  return {
    production: acc.production,
    testSide: acc.testSide,
    all: acc.all,
    raw(abs: string): string {
      let s = acc.rawCache.get(abs)
      if (s === undefined) {
        s = readFileSync(abs, 'utf-8')
        acc.rawCache.set(abs, s)
      }
      return s
    },
    stripped(abs: string): string {
      let s = acc.strippedCache.get(abs)
      if (s === undefined) {
        s = stripComments(this.raw(abs))
        acc.strippedCache.set(abs, s)
      }
      return s
    },
  }
}

/** 每进程每个根只建一次快照（守卫用例共享同一份内存数据） */
const cache = new Map<string, RepoScan>()

export function getRepoScan(srcRoot: string): RepoScan {
  let s = cache.get(srcRoot)
  if (!s) {
    s = build(srcRoot)
    cache.set(srcRoot, s)
  }
  return s
}
