/* ============================================================
 * ArkWork — 插件清单外科式迁移（v0.35.0 · D75 / A12）
 * 设计文档：docs/versions/v0.35.0/00-release-goal.md §二2.3 · §四 A12
 *
 * 要解决的问题：随包示例 `ark.plugin.stock` 的三个面板里，「个股详情」
 * （`panel:stock-detail`）与「日K线」（`panel:stock-kline`）被用户点名为**废弃**
 * （指令原文第 2 条「删除废弃的侧边栏插件」）。
 *
 * ★ 为什么不能只改 `sample-plugins.ts` 的字面量：
 *   那只能让**新装机**的用户看不到这两个面板。已装机的用户磁盘上躺着一份
 *   v0.34.x 落下的 `plugin.json`，它才是运行期真正被读的那份 ——
 *   不改它，用户升级之后那两个面板**照旧存在**（A12 的字面要求）。
 *
 * ★ 为什么必须是「外科式」而不是整体覆盖：
 *   落盘副本的既定语义是**用户副本**（`seed.ts` 头注释）—— 用户会去改自选股清单、
 *   改列、加面板。整体覆盖等于把用户编辑全吃掉。而这两个面板是**宿主认定的废弃项**，
 *   与用户改没改过无关，所以正确做法是：只摘掉这两个面板及其引用，
 *   其余部分（含用户的其它编辑）一字不动。
 *
 * ★ 为什么用 JSON 结构操作而不是字符串替换：
 *   落盘文件的空白/缩进/键序在用户手里千变万化（`seed.ts` 的 D57 字符串迁移
 *   必须逐字节匹配，那套机制适合「改正一个固定字符串」）。这里是**结构性删除**，
 *   字符串替换换不来。代价是写回会重新格式化 —— 用 2 空格缩进，与落盘格式一致。
 * ============================================================ */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from '../system/logger.js'

/**
 * 被废弃的面板 ref（**唯一真源**）。
 *
 * 增删都只改这里：迁移、测试、装配期守卫共用同一份 —— 分成两份就会出现
 * 「迁移删了但守卫还认」这类两边都不报错的错位。
 */
export const RETIRED_PANEL_REFS: readonly string[] = ['panel:stock-detail', 'panel:stock-kline']

/** 迁移结果（供日志与测试断言） */
export interface SurgicalMigrationResult {
  /** 是否真的改了什么（false = 无需迁移，**不要写回**） */
  changed: boolean
  /** 被摘掉的面板 ref */
  removedPanels: string[]
  /** 是否摘掉了 `interact.onRowClick` */
  removedInteract: boolean
  /** 是否顺带剥掉了 `interact.onRowClick.panelRefs` 里的废弃引用（部分摘除） */
  prunedInteractRefs: string[]
}

const EMPTY_RESULT: SurgicalMigrationResult = {
  changed: false,
  removedPanels: [],
  removedInteract: false,
  prunedInteractRefs: [],
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 对一份 `plugin.json` 的原始对象做外科式迁移（**纯函数**，不改入参、不碰磁盘）。
 *
 * 规则（逐条都有理由）：
 *  ① `provides.panels[]` 里 `panelRef` 命中废弃集 → 整条摘掉；
 *  ② 某个面板的 `interact.onRowClick` **指向**废弃面板 → 摘掉整个 `onRowClick`
 *     （不能只摘它数组里那两个 ref：摘完之后浮窗里什么都不会开，
 *      留下一个「点了没反应」的交互比没有交互更难排查）；
 *  ③ `interact.onRowClick.panelRefs` 里**部分**命中废弃集 → 只摘掉命中的那些
 *     （用户可能自己往里加过其它面板 —— 那部分是他的东西，留着）；
 *  ④ 摘完 `panelRefs` 变空 → 摘掉整个 `onRowClick`（同 ②，空数组 = 点了没反应）；
 *  ⑤ `provides` 里除 `panels` 外的键（views / tools / 别的东西）**不动**；
 *  ⑥ 顶层除 `provides` 外的键（含用户的版本号、名称、其它编辑）**不动**。
 */
export function migratePluginManifest(
  raw: Record<string, unknown>,
  retired: readonly string[] = RETIRED_PANEL_REFS,
): { next: Record<string, unknown>; result: SurgicalMigrationResult } {
  const retiredSet = new Set(retired)
  const provides = raw.provides
  if (!isRec(provides) || !Array.isArray(provides.panels)) {
    return { next: raw, result: EMPTY_RESULT }
  }

  const removedPanels: string[] = []
  const prunedInteractRefs: string[] = []
  let removedInteract = false

  const nextPanels: unknown[] = []
  for (const p of provides.panels) {
    if (isRec(p) && typeof p.panelRef === 'string' && retiredSet.has(p.panelRef)) {
      removedPanels.push(p.panelRef)
      continue
    }
    if (!isRec(p)) {
      // 形状不合法的条目**原样保留** —— 本迁移只负责摘废弃项，
      // 顺手清理非法条目会让「谁的锅」变得说不清（校验器会另行报 VP）
      nextPanels.push(p)
      continue
    }

    const interact = p.interact
    if (!isRec(interact) || !isRec(interact.onRowClick)) {
      nextPanels.push(p)
      continue
    }
    const orc = interact.onRowClick
    if (!Array.isArray(orc.panelRefs)) {
      nextPanels.push(p)
      continue
    }

    const refs = orc.panelRefs.filter((r) => typeof r === 'string')
    const kept = refs.filter((r) => !retiredSet.has(r))
    const hit = refs.filter((r) => retiredSet.has(r))
    if (hit.length === 0) {
      nextPanels.push(p)
      continue
    }
    prunedInteractRefs.push(...hit)

    const nextInteract: Record<string, unknown> = { ...interact }
    if (kept.length === 0) {
      delete nextInteract.onRowClick
      removedInteract = true
    } else {
      nextInteract.onRowClick = { ...orc, panelRefs: kept }
    }
    const nextPanel: Record<string, unknown> = { ...p }
    if (Object.keys(nextInteract).length === 0) delete nextPanel.interact
    else nextPanel.interact = nextInteract
    nextPanels.push(nextPanel)
  }

  const changed =
    removedPanels.length > 0 || removedInteract || prunedInteractRefs.length > 0
  if (!changed) return { next: raw, result: EMPTY_RESULT }

  return {
    next: { ...raw, provides: { ...provides, panels: nextPanels } },
    result: { changed: true, removedPanels, removedInteract, prunedInteractRefs },
  }
}

/**
 * 扫描插件目录并逐插件执行迁移（**写回**改过的那些）。
 *
 * 纪律：
 *  · 逐插件隔离 —— 单个文件读/写失败只 warn，不影响其他插件与启动；
 *  · 只在**真的改了**的时候写回（`changed=false` 不写，避免无谓地重排用户文件的格式）；
 *  · dry-run 可达（`apply:false`）—— 测试与「检查」按钮用它，不落盘。
 *
 * @returns 被修改的插件目录名列表
 */
export function migratePluginManifestsOnDisk(
  pluginDir: string,
  opts: { apply?: boolean } = {},
): string[] {
  const apply = opts.apply !== false
  if (!existsSync(pluginDir)) return []
  const touched: string[] = []

  let names: string[] = []
  try {
    names = readdirSync(pluginDir)
  } catch (err) {
    logger.warn('System', `[plugin] 读取插件目录失败（${pluginDir}）：${String(err)}`)
    return []
  }

  for (const name of names) {
    const manifestPath = join(pluginDir, name, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    try {
      const text = readFileSync(manifestPath, 'utf-8')
      const raw = JSON.parse(text) as unknown
      if (!isRec(raw)) continue
      const { next, result } = migratePluginManifest(raw)
      if (!result.changed) continue
      touched.push(name)
      if (!apply) continue
      writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
      logger.info(
        'System',
        `[plugin] 外科式迁移 ${name}：摘除面板 ${result.removedPanels.join(', ') || '—'}` +
          `${result.removedInteract ? '；摘除 interact.onRowClick' : ''}` +
          `${result.prunedInteractRefs.length > 0 ? `；从 onRowClick 中移除引用 ${result.prunedInteractRefs.join(', ')}` : ''}`,
      )
    } catch (err) {
      // 单个坏文件不阻断其余迁移（用户可能手改坏了 JSON；校验器会另外报 VP）
      logger.warn('System', `[plugin] 迁移 ${name}/plugin.json 失败：${String(err)}`)
    }
  }
  return touched
}
