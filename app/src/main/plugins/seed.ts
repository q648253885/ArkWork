/* ============================================================
 * ArkWork — 随包示例插件落盘（v0.34.0 P4；v0.34.1 P6 改按 id 补写；
 *                       v0.34.2 D57 增「未改动即随版本升级」）
 * 设计文档：docs/versions/v0.34.2/04-system-design.md §3
 *
 * 落盘策略（逐条都有代价依据）：
 *  · **按 id 补写**：某个随包示例的目录不存在 → 写出来；
 *    已存在则**默认一字不改**（用户编辑过的 plugin.json 是用户副本）。
 *  · 为什么从 v0.34.0 的「目录有任何插件就整批跳过」改成按 id 补写：
 *    旧策略下**已装机的用户永远拿不到新版新增的示例** —— v0.34.1 用真实股票
 *    插件替换四个假数据示例时，恰好卡在这里。
 *
 * ★ v0.34.2（D57）为什么还要再改一次 —— 「新增可达」不等于「修正可达」：
 *   v0.34.1 的策略能送**新示例**，却送不了**对已有示例的修正**。v0.34.2 恰好
 *   就撞在这上面：股票插件的数据源主机（`push2.eastmoney.com`）在真机实测
 *   不可达（`net::ERR_EMPTY_RESPONSE`），必须改成 `push2delay.eastmoney.com`；
 *   而磁盘上那份 v0.34.1 落下的副本「已存在」→ 修正永远进不去 → 用户看到的
 *   仍然是「插件打开失败」。**交付即用的反面就是这一条。**
 *
 *   修法（既送得到修正，又不吃掉用户编辑）——每个随包示例落盘时，在它自己的
 *   目录写一份**指纹副文件** `.arkwork-seed.json`（记落盘内容 sha256）；
 *   下次启动三分支判定：
 *     ① 内容与新版随包一致        → 什么都不做；
 *     ② 内容哈希 == 副文件记录    → **磁盘副本没被改过** → 用新版覆盖 + 更新指纹；
 *     ③ 内容按 `SEED_STRING_MIGRATIONS` 还原后与随包内容一致 → 旧版未改动副本
 *        （升级路径上没有副文件的存量用户）→ 同样覆盖 + 补写指纹；
 *     ④ 其余 → 用户改过 → 一字不改（照旧）。
 *
 *   为什么 ③ 用「归一化比对」而不是冻结旧哈希：冻结哈希每发一版都要追加一条，
 *   且失败模式是静默的（漏追加 = 用户永远收不到修正）；归一化比对只表达
 *   「这一次迁移动了什么」，与内容无关，漏不掉也骗不了。
 *
 *  · 用户想去掉随包示例 → **禁用**（启停状态记在 plugins.json，受尊重）；
 *    手动删目录会在下次启动补回 —— 这是「随包内容」的既定语义，不是 bug。
 *
 * ★ 退役清理（v0.34.1）：v0.34.0 的四个假数据示例被移除，其残留目录由
 *   `removeRetiredSamplePlugins()` 显式删除（用户裁决「测试用内置插件删掉」）。
 *
 * 纪律：逐插件隔离 —— 单个写入/删除失败只 warn，不影响其他插件与启动。
 * ============================================================ */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RAW_SAMPLE_PLUGINS, PLUGIN_DIR_NAME } from './sample-plugins.js'
import { logger } from '../system/logger.js'

export interface SeedResult {
  /** 实际写入的插件 id（首次落盘） */
  written: string[]
  /** v0.34.2：内容被升级覆盖的插件 id（磁盘副本未被用户改动过） */
  upgraded: string[]
  /** 本次是否执行了落盘动作（写入或升级） */
  seeded: boolean
}

/** 指纹副文件名（放在插件自己的目录里，不污染 plugins/ 根） */
export const SEED_SIDECAR = '.arkwork-seed.json'

/**
 * 本版本（v0.34.2）对随包示例做过的**内容改动**，逐条声明。
 *
 * 用途**仅限**升级判定：把磁盘副本按这张表还原成「本版之前的样子」后，若与
 * 上一版随包内容一致，即可判定「这是没被改动过的旧副本」→ 覆盖升级。
 * **不是**运行时改写（运行时一律以磁盘清单为准 —— 插件作者/用户对内容有最终话语权）。
 *
 * 方向恒定 `[旧, 新]` —— 测试里的「造旧副本」就是把它反过来用，方向写反会让
 * 「旧副本」造不出来（用例会直接红，不会静默失效）。
 *
 * 维护纪律（有护栏）：只要改动随包示例的内容（URL / 文案 / 字段），就必须在这里
 * 加一条，否则 `TC-SMPL-020`（拿上一版官方副本夹具做判定）会红 —— 那条用例就是
 * 「忘了声明迁移 = 存量用户永远收不到修正」这个静默失败模式的把守者。
 */
export const SEED_STRING_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  // ① 数据源主机：push2 在真机实测不可达（net::ERR_EMPTY_RESPONSE）→ push2delay
  ['https://push2.eastmoney.com/', 'https://push2delay.eastmoney.com/'],
  // ② 插件描述：数据源换主机后「实时」措辞不再准确，同步改成「行情」
  [
    '自选股实时行情 + 个股详情 + 日 K 线（东方财富公开接口，真实联网数据）',
    '自选股行情 + 个股详情 + 日 K 线（东方财富公开行情接口，真实联网数据）',
  ],
]

/** 落盘文本序列化口径（唯一真源：2 空格缩进 + 结尾换行） */
export function seedTextOf(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 深走 JSON：按 `SEED_STRING_MIGRATIONS` 还原旧版文案/主机（其余原样） */
function normalizeSeedHosts(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value
    for (const [from, to] of SEED_STRING_MIGRATIONS) out = out.split(from).join(to)
    return out
  }
  if (Array.isArray(value)) return value.map(normalizeSeedHosts)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeSeedHosts(v)
    return out
  }
  return value
}

/** 内容签名（顺序无关性由 JSON.stringify 的对象键序保证：同一份对象字面量 → 同一字符串） */
function contentSignature(value: unknown): string {
  try {
    return JSON.stringify(dropVolatileFields(normalizeSeedHosts(value)))
  } catch {
    return `unserializable:${String(value)}`
  }
}

/**
 * 抹掉「随内容而变、且不构成用户改动证据」的字段。
 *
 * `version` 是随包内容的一部分：**任何**内容修正都会让它 +1，若把它算进比对，
 * 那么「旧版落盘的未改动副本」在每次升级时都会被误判成用户副本 → 修正永远
 * 送不到（v0.34.2 实测踩到过：本机副本 1.0.0 对新包 1.0.1，归一化比对直接失败）。
 */
function dropVolatileFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = { ...(value as Record<string, unknown>) }
  delete out.version
  return out
}

interface SeedSidecar {
  /** 落盘时写入的内容哈希 */
  hash: string
  /** 落盘时该插件的 version（人可读，便于排查） */
  version: string
  seededAt: string
}

function readSidecar(file: string): SeedSidecar | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SeedSidecar>
    if (typeof parsed.hash !== 'string' || parsed.hash.length === 0) return null
    return { hash: parsed.hash, version: String(parsed.version ?? ''), seededAt: String(parsed.seededAt ?? '') }
  } catch {
    // 副文件坏掉 = 无法证明副本未被改动 → 按「用户副本」保守处理（绝不覆盖）
    return null
  }
}

function writeSidecar(file: string, raw: Record<string, unknown>, text: string): void {
  const side: SeedSidecar = { hash: sha256(text), version: String(raw.version ?? ''), seededAt: new Date().toISOString() }
  writeFileSync(file, `${JSON.stringify(side, null, 2)}\n`, 'utf-8')
}

/**
 * 磁盘副本是否「未被用户改动」。
 *
 * 导出以便直接单测判定真值表（三条路径都不依赖文件系统）。
 */
export function isUntouchedCopy(
  onDiskText: string,
  bundledRaw: Record<string, unknown>,
  sidecar: { hash?: string } | null,
): boolean {
  const bundled = seedTextOf(bundledRaw)
  if (onDiskText === bundled) return true
  if (sidecar?.hash && sidecar.hash === sha256(onDiskText)) return true
  try {
    return contentSignature(JSON.parse(onDiskText)) === contentSignature(bundledRaw)
  } catch {
    return false
  }
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
 * 按 id 补写 / 升级随包示例插件。
 *
 * @param pluginDir 插件目录根（`{userData}/arkwork-data/plugins`；由调用方给绝对路径）
 * @returns 写入/升级清单与是否执行（供启动日志与测试断言）
 */
export function ensureSamplePlugins(pluginDir: string): SeedResult {
  // 先清退役示例，再补写 —— 顺序反了会把刚删掉的旧示例又写回来（v0.34.1）
  removeRetiredSamplePlugins(pluginDir)

  try {
    if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true })
  } catch (err) {
    logger.warn('System', `[plugin] 示例插件目录准备失败：${String(err)}`)
    return { written: [], upgraded: [], seeded: false }
  }

  const written: string[] = []
  const upgraded: string[] = []
  for (const raw of RAW_SAMPLE_PLUGINS) {
    const id = String(raw.id)
    const sub = join(pluginDir, id)
    const file = join(sub, 'plugin.json')
    const sideFile = join(sub, SEED_SIDECAR)
    const text = seedTextOf(raw)

    try {
      if (!existsSync(file)) {
        if (!existsSync(sub)) mkdirSync(sub, { recursive: true })
        writeFileSync(file, text, 'utf-8')
        writeSidecar(sideFile, raw, text)
        written.push(id)
        continue
      }

      const onDisk = readFileSync(file, 'utf-8')
      if (!isUntouchedCopy(onDisk, raw, readSidecar(sideFile))) {
        // 用户（或第三方）改过 → 用户副本优先，一字不改
        logger.debug('System', `[plugin] 随包示例 ${id} 的磁盘副本已被修改，跳过升级（尊重用户副本）`)
        continue
      }
      if (onDisk === text) {
        // 内容已是最新：只补齐可能缺失的指纹（存量用户路径），不写 plugin.json
        if (!existsSync(sideFile)) writeSidecar(sideFile, raw, text)
        continue
      }
      writeFileSync(file, text, 'utf-8')
      writeSidecar(sideFile, raw, text)
      upgraded.push(id)
    } catch (err) {
      // 逐插件隔离：单个失败不影响其他插件，也不阻断启动
      logger.warn('System', `[plugin] 示例插件 ${id} 落盘/升级失败：${String(err)}`)
    }
  }

  if (written.length > 0) {
    logger.info(
      'System',
      `[plugin] 已落盘随包示例插件 ${written.length} 个到 ${PLUGIN_DIR_NAME}/（${written.join(', ')}）`,
    )
  }
  if (upgraded.length > 0) {
    logger.info(
      'System',
      `[plugin] 随包示例插件已升级 ${upgraded.length} 个（磁盘副本未被改动过）：${upgraded.join(', ')}`,
    )
  }
  return { written, upgraded, seeded: written.length > 0 || upgraded.length > 0 }
}

/** 目录里是否已有插件子目录（隐藏目录/文件不计）—— 诊断与测试用 */
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
