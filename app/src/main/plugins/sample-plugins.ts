/* ============================================================
 * ArkWork — 随包示例插件（v0.33.0 引入；v0.34.0 P4 改为**磁盘装载**；
 *                        v0.34.1 P6 收敛为「唯一范例 = 真实股票插件」）
 * 设计文档：docs/versions/v0.34.1/04-system-design.md §5
 *
 * ★ v0.34.1 变更（用户裁决：「其他测试用的内置插件删掉」）：
 *   此前四个示例（插件指南 / 运行时指标 / 工作区数据表 / .kchart 渲染器）
 *   全是**假数据演示件** —— 它们证明了「插件机制能跑」，却也让人误以为
 *   插件就是用来放示例表格的。现全部删除，只保留一个**真实功能插件**：
 *
 *     ark.plugin.stock  股票行情（侧边栏单面板 · 真实联网数据）
 *       · panel:stock-quotes  侧边栏：自选股实时行情（每 8s 刷新）
 *       ★ v0.35.0（D75）：原先的 `panel:stock-detail`（浮窗·个股详情）与
 *         `panel:stock-kline`（浮窗·日K线）已被用户点名为废弃项，本版摘除；
 *         随之摘掉引用它们的 `interact.onRowClick`（否则行点击变成「点了没反应」）。
 *         已装机用户的落盘副本由 `migrate.ts` 做同款外科式迁移。
 *
 *   它同时是**未来插件接入的范例**，覆盖插件格式的全部能力点：
 *     ① `provides.panels` 多面板（一个插件一组面板，同生共死）
 *     ② `data.kind: 'http'` 真实联网取数（主进程发起，规避 CORS）
 *     ③ `interact.onRowClick` 行点击 → 浮窗打开另一批面板（声明式参数传递）
 *     ④ 轮询刷新（宿主夹取下限，防把接口当 DDoS 打）
 *
 * 为什么清单仍以代码字面量为真源（而不是随包 resources 文件）：
 *  ① 代码即真源，避免「打包漏文件 → 示例插件凭空消失」；
 *  ② 落盘动作由代码执行，路径/内容可测（见 seed.ts）；
 *  ③ 用户可自由编辑落盘后的 plugin.json —— 那是**用户副本**，不再回写。
 *
 * 数据来源：东方财富公开行情接口（push2delay / push2his），无需鉴权、无需 Key。
 *
 * ⚠️ v0.34.2（D56-b）**主机选择有硬证据，勿改回 `push2.eastmoney.com`**：
 *   本机实测（Electron 主进程 `net.fetch`，走系统代理 127.0.0.1:7890）：
 *     · `push2.eastmoney.com`  的 ulist.np / stock/get → `net::ERR_EMPTY_RESPONSE`
 *       （连试 3 次全失败；http 明文经代理返回 502 —— 代理上游也到不了）
 *     · `push2delay.eastmoney.com` 同两个接口 → **http=200 且 JSON 合法**（49–187ms）
 *     · `push2his.eastmoney.com` 的 kline → http=200
 *   字段名与响应结构两个主机完全一致（同一套 `f43/f57/f170/...` 口径），
 *   故换主机不牵动 columns / derive / path 的声明。
 *   另有回归用例 TC-SMPL-013 钉死「自选股与详情面板不得再用 push2 主机」。
 * ============================================================ */
import { parsePluginManifest } from '@shared/utils/plugin-manifest'
import type { PluginManifest } from '@shared/types/plugin'

/** 插件目录名（`{userData}/arkwork-data/plugins`，见 store.ts） */
export const PLUGIN_DIR_NAME = 'plugins'

/**
 * 自选股清单（secid = 市场.代码；1=沪市，0=深市）。
 * 用户可直接编辑落盘后的 plugin.json 改这份清单 —— 这就是「用户副本」的价值。
 */
const WATCHLIST = '1.600519,0.000001,0.300750,1.601318,0.002594,1.600036'

const RAW_BUILTINS: Array<Record<string, unknown>> = [
  {
    // v0.35.0：1.0 → 1.1（`order` 字段与代码插件入口同版）
    schemaVersion: '1.1',
    id: 'ark.plugin.stock',
    name: '股票行情',
    // v0.34.2：数据源主机迁移（push2 → push2delay）属内容变更，版本号如实 +1 ——
    // 该字段同时是种子升值的可读凭据（见 seed.ts 的 `.arkwork-seed.json`）
    // v0.35.0（D75）：外科式摘除「个股详情」「日K线」两个废弃面板 → 1.1.0
    version: '1.1.0',
    author: 'ArkWork',
    description: '自选股实时行情（东方财富公开行情接口，真实联网数据）',
    kind: 'panel',
    // v0.34.1：真实功能 → 默认启用（假数据示例才默认禁用）
    enabledByDefault: true,
    provides: {
      panels: [
        /* ---------- ① 侧边栏：自选股实时行情 ----------
         * ★ v0.35.0（D75）：本轮**只剩这一个面板**。
         *   原「② 个股详情」「③ 日K线」两个浮窗面板被用户点名为废弃，已摘除；
         *   连带摘掉它们的唯一入口 —— 本面板的 `interact.onRowClick`
         *   （它的 panelRefs 只指向那两个面板，留着就是「点了没反应」）。
         *   已装机用户的落盘副本由 `migrate.ts` 做同款外科式迁移（A12）。 */
        {
          panelRef: 'panel:stock-quotes',
          title: '自选股',
          icon: 'Graph',
          component: 'DataTable',
          data: {
            kind: 'http',
            http: {
              url: `https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=${WATCHLIST}&fltt=2&fields=f2,f3,f4,f12,f13,f14,f18`,
              response: 'json',
              // 只取列表数组
              path: 'data.diff',
              columns: [
                { key: 'f14', label: '名称' },
                { key: 'f12', label: '代码' },
                { key: 'f2', label: '最新价', align: 'right' },
                { key: 'f3', label: '涨跌幅%', align: 'right' },
              ],
              // 派生列：把「市场.代码」拼成东方财富的 secid（供后续需要个股级数据的视图复用）
              derive: { secid: '{{f13}}.{{f12}}' },
              pollMs: 8000,
            },
          },
        },
      ],
    },
  },
]

/**
 * 随包示例插件（已过 VP1–VP6 校验）。
 * 清单结构非法属于**编程错误** → 模块加载期抛错（有测试在 CI 期把守）——
 * 落盘之后这些插件与用户插件同路径，坏清单会出现在「能力 → 插件」的问题区。
 */
export const SAMPLE_PLUGIN_MANIFESTS: PluginManifest[] = RAW_BUILTINS.map((raw) => {
  const { manifest, issues } = parsePluginManifest(raw)
  if (!manifest) {
    const detail = issues.map((i) => `${i.rule} ${i.path}: ${i.message}`).join('; ')
    throw new Error(`[plugin] 随包示例插件 ${String(raw.id)} 清单非法：${detail}`)
  }
  return manifest
})

/** 原始字面量（供测试直接对落盘结果与字面量做一致性断言） */
export const RAW_SAMPLE_PLUGINS = RAW_BUILTINS

/** 随包示例插件 id 集合 —— 注册表据此判定 `source: 'bundled'`（不可卸载） */
export const SAMPLE_PLUGIN_IDS: ReadonlySet<string> = new Set(
  RAW_BUILTINS.map((raw) => String(raw.id)),
)

/** 是否随包示例插件（按 id 判定；卸载守卫与来源标记共用同一真源） */
export function isSamplePlugin(id: string): boolean {
  return SAMPLE_PLUGIN_IDS.has(id)
}

/** 供 UI 的「导出示例插件模板」用（让作者拿到可编辑的清单） */
export function sampleManifestForExport(id: string): PluginManifest | null {
  return SAMPLE_PLUGIN_MANIFESTS.find((p) => p.id === id) ?? null
}

/** 可编辑副本：落盘用的纯 JSON（剥离解析期派生字段，避免写回冗余） */
export function rawManifestOf(id: string): Record<string, unknown> | null {
  return RAW_BUILTINS.find((r) => String(r.id) === id) ?? null
}
