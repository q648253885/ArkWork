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
import { migratePluginManifest } from './migrate.js'
import { logger } from '../system/logger.js'

export interface SeedResult {
  /** 实际写入的插件 id（首次落盘） */
  written: string[]
  /** v0.34.2：内容被升级覆盖的插件 id（磁盘副本未被用户改动过） */
  upgraded: string[]
  /**
   * ★ v0.36.0（D88）：仅**载荷文件**被同步（清单未动）的插件 id。
   * 与 upgraded 分开报，是因为「清单没变但代码变了」正是旧实现静默漏掉的那一格。
   */
  refreshed: string[]
  /** 本次是否执行了落盘动作（写入 / 升级 / 载荷同步） */
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
 * 维护纪律（护栏与**它的现状**）：只要改动随包示例的内容（URL / 文案 / 字段 /
 * 图标名），就必须在这里加一条 —— 「忘了声明迁移 = 存量用户永远收不到修正」
 * 是个纯静默的失败模式，必须有机器把守。
 *
 *   · 现役把守者 = `TC-SMPL-026`（**冻结的 v0.36.0 官方副本夹具**）：拿一份逐字
 *     冻结的上一版官方清单，断言「无副文件的存量副本」仍被判为未改动 → 会被升级。
 *     改了随包内容却没加迁移条目 → 归一化对不上 → 判成「用户副本」→ 用例红。
 *   · ⚠️ 历史（避免下次退役示例时又悄悄丢把守）：v0.35.0 之前这条把守挂在
 *     **股票插件夹具**上；v0.36.0 股票插件整体退役、夹具一并删除，把守出现空窗
 *     （当时本注释还指向 `TC-SMPL-020`，而该编号早已改作「载荷逐字节落盘」用例）。
 *     v0.36.0 · D91/D92 把空窗补上。
 */
export const SEED_STRING_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  // ① 数据源主机：push2 在真机实测不可达（net::ERR_EMPTY_RESPONSE）→ push2delay
  ['https://push2.eastmoney.com/', 'https://push2delay.eastmoney.com/'],
  // ② 插件描述：数据源换主机后「实时」措辞不再准确，同步改成「行情」
  [
    '自选股实时行情 + 个股详情 + 日 K 线（东方财富公开接口，真实联网数据）',
    '自选股行情 + 个股详情 + 日 K 线（东方财富公开行情接口，真实联网数据）',
  ],
  // ③ ★ v0.35.0（D75）：摘除「个股详情」「日K线」两个废弃面板后，
  //    描述里不该再提它们 —— 这是**纯文案**层面的对称声明。
  //    （面板的**结构性**删除由 `migrate.ts` 的外科式迁移负责，见
  //     `isUntouchedCopy` 的第 4 条判定路径 —— 那种差异不是字符串能表达的。）
  [
    '自选股行情 + 个股详情 + 日 K 线（东方财富公开行情接口，真实联网数据）',
    '自选股实时行情（东方财富公开行情接口，真实联网数据）',
  ],
  // ④ ★ v0.36.0（D91）：竖排栏标签预算收敛为 3 字（44px 栏宽），
  //    官方示例的 view.title 随之从 'Git Manager' 收敛为 'Git'
  ['Git Manager', 'Git'],
  // ⑤ ★ v0.36.0（D92）：渲染层图标集里没有 'GitBranch'（只有 'Branch'），
  //    写错会静默退化成一颗圆点 —— 修正图标名同样属于「随包内容改动」
  ['GitBranch', 'Branch'],
]

/** 落盘文本序列化口径（唯一真源：2 空格缩进 + 结尾换行） */
export function seedTextOf(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`
}

/**
 * v0.36.0：剥离 `files` 后的可落盘清单文本。
 * `files` 是 seed 的**文件载荷**（main.js / panel.html 等随包源码），
 * 不属于 plugin.json —— 写进清单既污染用户副本，也会让 VP 校验白担惊。
 */
function manifestTextOf(raw: Record<string, unknown>): string {
  const { files: _files, ...manifest } = raw
  return seedTextOf(manifest)
}

/** v0.36.0：落盘随包文件载荷（**无条件覆盖** —— 随包代码是本体的组成部分，与 plugin.json 升级同权） */
function writeBundledFiles(sub: string, raw: Record<string, unknown>): void {
  const files = raw.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return
  for (const [name, content] of Object.entries(files as Record<string, unknown>)) {
    if (typeof content !== 'string') continue
    const f = join(sub, name)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, content, 'utf-8')
  }
}

/**
 * ★ v0.36.0（D88）：按指纹**同步**随包文件载荷（「清单已是最新」分支用）。
 *
 * 为什么不能只「补齐缺失文件」（D88 之前的实现）：指纹副文件当时只记了
 * plugin.json 的哈希，载荷（main.js / panel.html）不在指纹里 ⇒ 磁盘文件一存在
 * 就跳过 ⇒ 对随包插件**代码**的修正永远送不到存量用户。实机 B3 冒烟实录：
 * 修好插件源码 → 重建 → 重跑，磁盘副本纹丝不动，同一个 TypeError 反复复现。
 *
 * 逐文件三分支（与清单升级判定同构，顺序有意义）：
 *   ① 磁盘内容 == 新版内容    → 什么都不做；
 *   ② 指纹记录的哈希 == 磁盘   → 官方副本未被改动 → 覆盖（这一步就是「修正送达」）；
 *   ③ 指纹有记录但不命中       → 用户改过 → 一字不改；
 *   ④ 指纹**没有**这个文件的记录（本特性之前的存量副文件 / 本版新增的载荷文件）
 *      → 覆盖。取舍依据：此时无法证明被改动过，而「永不送达」是更坏的失败形态
 *      （v0.34.2 D57「新增可达 ≠ 修正可达」的教训）；且能走到本分支的前提是
 *      **清单已被证明未被改动**，用户只改代码不改清单的情形极罕见。
 *
 * @returns 被同步（写入/覆盖）的文件名，供调用方计入 SeedResult 与日志
 */
function syncBundledFiles(sub: string, raw: Record<string, unknown>, side: SeedSidecar | null): string[] {
  const files = raw.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return []
  const synced: string[] = []
  for (const [name, content] of Object.entries(files as Record<string, unknown>)) {
    if (typeof content !== 'string') continue
    const f = join(sub, name)
    mkdirSync(join(f, '..'), { recursive: true })
    if (!existsSync(f)) {
      writeFileSync(f, content, 'utf-8')
      synced.push(name)
      continue
    }
    const disk = readFileSync(f, 'utf-8')
    if (disk === content) continue
    const recorded = side?.files?.[name]
    if (recorded !== undefined && recorded !== sha256(disk)) continue // ③ 用户副本
    writeFileSync(f, content, 'utf-8')
    synced.push(name)
  }
  return synced
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
 *
 * `schemaVersion` 同理，且它的漂移与「内容改了没」**无关** —— 它声明的是清单
 * **格式**版本，随包整体升级（v0.35.0 把 1.0 → 1.1 以对齐代码插件入口）。若把它
 * 算进比对，则任何一次格式升级都会让**全部**未改动副本被误判成用户副本 ——
 * 失败的形态与 `version` 一模一样，只是触发面更大（涨一次、全盘皆输）。
 * 判据同 `version`：它由包决定，不表达用户的任何编辑意图。
 */
function dropVolatileFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = { ...(value as Record<string, unknown>) }
  delete out.version
  delete out.schemaVersion
  return out
}

interface SeedSidecar {
  /** 落盘时写入的内容哈希（plugin.json 剥离 files 后的文本） */
  hash: string
  /** 落盘时该插件的 version（人可读，便于排查） */
  version: string
  seededAt: string
  /**
   * ★ v0.36.0（D88）：随包**文件载荷**的 sha256，键为文件名（main.js / panel.html…）。
   *
   * 为什么必须单独记：`hash` 只覆盖 plugin.json。代码插件的代码全在载荷里，
   * 而载荷不在指纹内 ⇒ 「清单一字未动 → 走『已是最新』分支 → 文件已存在 → 跳过」
   * ⇒ **对随包插件代码的任何修正永远送不到存量用户**（实机 B3 冒烟实录：
   * 修好插件源码、重建、重跑，磁盘副本纹丝不动，同一个 TypeError 反复复现）。
   * 与 plugin.json 同权：载荷也是随包本体的组成部分。
   */
  files?: Record<string, string>
}

function readSidecar(file: string): SeedSidecar | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SeedSidecar>
    if (typeof parsed.hash !== 'string' || parsed.hash.length === 0) return null
    const files: Record<string, string> = {}
    if (parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
      for (const [k, v] of Object.entries(parsed.files)) if (typeof v === 'string' && v) files[k] = v
    }
    return {
      hash: parsed.hash,
      version: String(parsed.version ?? ''),
      seededAt: String(parsed.seededAt ?? ''),
      files,
    }
  } catch {
    // 副文件坏掉 = 无法证明副本未被改动 → 按「用户副本」保守处理（绝不覆盖）
    return null
  }
}

/** 落盘指纹：plugin.json 文本哈希 + 每个载荷文件的哈希（D88） */
function writeSidecar(file: string, raw: Record<string, unknown>, text: string): void {
  const files = raw.files
  const fileHashes: Record<string, string> = {}
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const [name, content] of Object.entries(files as Record<string, unknown>)) {
      if (typeof content === 'string') fileHashes[name] = sha256(content)
    }
  }
  const side: SeedSidecar = {
    hash: sha256(text),
    version: String(raw.version ?? ''),
    seededAt: new Date().toISOString(),
    files: fileHashes,
  }
  writeFileSync(file, `${JSON.stringify(side, null, 2)}\n`, 'utf-8')
}

/**
 * 磁盘副本是否「未被用户改动」。
 *
 * 四条判定路径（**顺序有意义**：从强到弱）：
 *  ① 逐字节等于新版随包文本 → 未改动；
 *  ② 指纹副文件的 hash 匹配 → 未改动（唯一能在「跨版本语义变更」下仍然成立的凭据）；
 *  ③ 按 `SEED_STRING_MIGRATIONS` 归一化后**语义**等于新版 → 未改动
 *     （覆盖「升级路径上没有副文件的存量用户」）；
 *  ④ ★ v0.35.0：**先做外科式迁移再比对** —— 覆盖「旧官方副本里有本版要摘的废弃面板」
 *     这一情形。这类差异是**结构性**的（删了数组里的两项），字符串迁移表表达不了：
 *     要么在表里塞进整段被删的 JSON（脆、易漂），要么就在这里做一次结构比对。
 *
 * 第 ④ 条的保守性：只有当「迁移后与新版完全一致」才判为未改动 ——
 * 用户哪怕改了自选股清单里的一只股票，迁移后的签名就对不上，仍走「用户副本」分支。
 *
 * 导出以便直接单测判定真值表（四条路径都不依赖文件系统）。
 */
export function isUntouchedCopy(
  onDiskText: string,
  bundledRaw: Record<string, unknown>,
  sidecar: { hash?: string } | null,
): boolean {
  // v0.36.0：files 是落盘**载荷**不是清单字段 —— 磁盘上的 plugin.json 永远没有它。
  // 比对必须以「剥离后的清单」为准，否则所有路径都因多出的 files 而失配（升级永远送不到）。
  const { files: _files, ...bundledManifest } = bundledRaw
  const bundled = seedTextOf(bundledManifest)
  if (onDiskText === bundled) return true
  if (sidecar?.hash && sidecar.hash === sha256(onDiskText)) return true
  try {
    const parsed = JSON.parse(onDiskText) as unknown
    if (contentSignature(parsed) === contentSignature(bundledManifest)) return true
    // ④ 结构级：把废弃面板摘掉后是否等于新版
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const { next, result } = migratePluginManifest(parsed as Record<string, unknown>)
      if (result.changed && contentSignature(next) === contentSignature(bundledManifest)) return true
    }
    return false
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
  // v0.36.0（F3.5）：股票插件被 Git 管理代码插件取代（用户裁决）
  'ark.plugin.stock',
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
    return { written: [], upgraded: [], refreshed: [], seeded: false }
  }

  const written: string[] = []
  const upgraded: string[] = []
  const refreshed: string[] = []
  for (const raw of RAW_SAMPLE_PLUGINS) {
    const id = String(raw.id)
    const sub = join(pluginDir, id)
    const file = join(sub, 'plugin.json')
    const sideFile = join(sub, SEED_SIDECAR)
    const text = manifestTextOf(raw)

    try {
      if (!existsSync(file)) {
        if (!existsSync(sub)) mkdirSync(sub, { recursive: true })
        writeFileSync(file, text, 'utf-8')
        writeBundledFiles(sub, raw)
        writeSidecar(sideFile, raw, text)
        written.push(id)
        continue
      }

      const onDisk = readFileSync(file, 'utf-8')
      const side = readSidecar(sideFile)
      if (!isUntouchedCopy(onDisk, raw, side)) {
        // 用户（或第三方）改过 → 用户副本优先，一字不改
        logger.debug('System', `[plugin] 随包示例 ${id} 的磁盘副本已被修改，跳过升级（尊重用户副本）`)
        continue
      }
      if (onDisk === text) {
        // 清单已是最新：不写 plugin.json，但仍要**同步载荷文件**。
        // ★ D88：旧实现只「补齐缺失文件」，于是「清单没变、代码变了」这一格被
        //   静默吞掉（对随包插件代码的修正永远送不到存量用户）。
        const synced = syncBundledFiles(sub, raw, side)
        if (!existsSync(sideFile) || synced.length > 0) writeSidecar(sideFile, raw, text)
        if (synced.length > 0) {
          refreshed.push(id)
          logger.info('System', `[plugin] 随包示例 ${id} 的载荷文件已同步（磁盘副本未被改动过）：${synced.join(', ')}`)
        }
        continue
      }
      writeFileSync(file, text, 'utf-8')
      writeBundledFiles(sub, raw)
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
  return {
    written,
    upgraded,
    refreshed,
    seeded: written.length > 0 || upgraded.length > 0 || refreshed.length > 0,
  }
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
