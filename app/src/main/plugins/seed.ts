/* ============================================================
 * ArkWork — 随包示例插件落盘（v0.34.0 · P4；v0.34.1 P6 改**按 id 补写**）
 * 设计文档：docs/versions/v0.34.1/04-system-design.md §5.2
 *
 * 落盘策略（v0.34.1，逐条都有代价依据）：
 *  · **按 id 补写**：某个随包示例的目录不存在 → 写出来；**已存在则一字不改**
 *    （用户编辑过的 plugin.json 是用户副本，绝不覆盖）。
 *  · 为什么从 v0.34.0 的「目录有任何插件就整批跳过」改成按 id 补写：
 *    旧策略下**已装机的用户永远拿不到新版新增的示例** —— v0.34.1 用真实股票
 *    插件替换四个假数据示例时，恰好卡在这里（本机已有旧示例目录 → 新插件
 *    永远不落盘）。「尊重用户现状」是对的，但不能以「新版内容永不可达」为代价。
 *  · 用户想去掉随包示例 → **禁用**（启停状态记在 plugins.json，受尊重）；
 *    手动删目录会在下次启动补回 —— 这是「随包内容」的既定语义，不是 bug。
 *
 * ★ 退役清理（v0.34.1）：v0.34.0 的四个假数据示例被移除，其残留目录由
 *   `removeRetiredSamplePlugins()` 显式删除（用户裁决「测试用内置插件删掉」）。
 *
 * 纪律：逐插件隔离 —— 单个写入/删除失败只 warn，不影响其他插件与启动。
 * ============================================================ */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RAW_SAMPLE_PLUGINS, PLUGIN_DIR_NAME } from './sample-plugins.js'
import { logger } from '../system/logger.js'

export interface SeedResult {
  /** 实际写入的插件 id（已存在的不计入） */
  written: string[]
  /** 本次是否执行了落盘动作 */
  seeded: boolean
}

/**
 * v0.34.1：已退役的随包示例 id（假数据演示件，被真实股票插件取代）。
 *
 * 这些目录若不清理，会以「本地插件」身份长期滞留 —— 而它们既不是用户写的，
 * 也早已不被随包清单承认，属于纯粹的残留。
 */
export const RETIRED_SAMPLE_PLUGIN_IDS: readonly string[] = [
  'ark.plugin.workbench-guide',
  'ark.plugin.runtime-metrics',
  'ark.plugin.workspace-table',
  'ark.plugin.kchart-renderer',
]

/** 删除退役示例的残留目录（幂等；失败只 warn） */
export function removeRetiredSamplePlugins(pluginDir: string): string[] {
  if (!existsSync(pluginDir)) return []
  const removed: string[] = []
  for (const id of RETIRED_SAMPLE_PLUGIN_IDS) {
    const sub = join(pluginDir, id)
    if (!existsSync(sub)) continue
    try {
      if (!statSync(sub).isDirectory()) continue
      rmSync(sub, { recursive: true, force: true })
      removed.push(id)
    } catch (err) {
      logger.warn('System', `[plugin] 退役示例 ${id} 清理失败：${String(err)}`)
    }
  }
  if (removed.length > 0) {
    logger.info('System', `[plugin] 已清理 ${removed.length} 个退役示例插件（假数据演示件，v0.34.1 起不再随包）`)
  }
  return removed
}

/**
 * 按 id 补写随包示例插件。
 *
 * @param pluginDir 插件目录根（`{userData}/arkwork-data/plugins`；由调用方给绝对路径）
 * @returns 写入清单与是否执行（供启动日志与测试断言）
 */
export function ensureSamplePlugins(pluginDir: string): SeedResult {
  // 先清退役示例，再补写 —— 顺序反了会把刚删掉的旧示例又写回来（v0.34.1）
  removeRetiredSamplePlugins(pluginDir)

  try {
    if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true })
  } catch (err) {
    logger.warn('System', `[plugin] 示例插件目录准备失败：${String(err)}`)
    return { written: [], seeded: false }
  }

  const written: string[] = []
  for (const raw of RAW_SAMPLE_PLUGINS) {
    const id = String(raw.id)
    const sub = join(pluginDir, id)
    // 已存在 → 一字不改（用户副本）
    if (existsSync(join(sub, 'plugin.json'))) continue
    const file = join(sub, 'plugin.json')
    try {
      if (!existsSync(sub)) mkdirSync(sub, { recursive: true })
      writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8')
      written.push(id)
    } catch (err) {
      // 逐插件隔离：单个失败不影响其他插件，也不阻断启动
      logger.warn('System', `[plugin] 示例插件 ${id} 落盘失败：${String(err)}`)
    }
  }
  if (written.length > 0) {
    logger.info(
      'System',
      `[plugin] 已落盘随包示例插件 ${written.length} 个到 ${PLUGIN_DIR_NAME}/（${written.join(', ')}）`,
    )
  }
  return { written, seeded: written.length > 0 }
}

/** 目录里是否已有插件子目录（隐藏目录不计）—— 诊断与测试用 */
export function hasAnyPluginDir(dir: string): boolean {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      if (statSync(join(dir, name)).isDirectory()) return true
    } catch {
      continue
    }
  }
  return false
}
