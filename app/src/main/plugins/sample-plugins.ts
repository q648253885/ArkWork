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
 *     ark.plugin.stock  股票行情（多面板 · 真实联网数据）
 *       · panel:stock-quotes  侧边栏：自选股实时行情（每 8s 刷新）
 *       · panel:stock-detail  浮窗：个股完整盘口数据
 *       · panel:stock-kline   浮窗：个股日 K 线（原生 Canvas，涨红跌绿）
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
 * 数据来源：东方财富公开行情接口（push2 / push2his），无需鉴权、无需 Key。
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
    schemaVersion: '1.0',
    id: 'ark.plugin.stock',
    name: '股票行情',
    version: '1.0.0',
    author: 'ArkWork',
    description: '自选股实时行情 + 个股详情 + 日 K 线（东方财富公开接口，真实联网数据）',
    kind: 'panel',
    // v0.34.1：真实功能 → 默认启用（假数据示例才默认禁用）
    enabledByDefault: true,
    provides: {
      panels: [
        /* ---------- ① 侧边栏：自选股实时行情 ---------- */
        {
          panelRef: 'panel:stock-quotes',
          title: '自选股',
          icon: 'Graph',
          component: 'DataTable',
          data: {
            kind: 'http',
            http: {
              url: `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${WATCHLIST}&fltt=2&fields=f2,f3,f4,f12,f13,f14,f18`,
              response: 'json',
              // 只取列表数组
              path: 'data.diff',
              columns: [
                { key: 'f14', label: '名称' },
                { key: 'f12', label: '代码' },
                { key: 'f2', label: '最新价', align: 'right' },
                { key: 'f3', label: '涨跌幅%', align: 'right' },
              ],
              // 派生列：把「市场.代码」拼成东方财富的 secid —— 行点击时作为参数传下去
              derive: { secid: '{{f13}}.{{f12}}' },
              pollMs: 8000,
            },
          },
          interact: {
            onRowClick: {
              // 点一只股票 → 浮窗里同时打开「详情」与「K 线」两个 Tab
              panelRefs: ['panel:stock-detail', 'panel:stock-kline'],
              params: { secid: 'secid' },
            },
          },
        },

        /* ---------- ② 浮窗：个股完整盘口 ---------- */
        {
          panelRef: 'panel:stock-detail',
          title: '个股详情',
          icon: 'List',
          component: 'DataTable',
          data: {
            kind: 'http',
            http: {
              // {{secid}} 由行点击参数替换 —— 面板自己不知道被谁打开
              url: 'https://push2.eastmoney.com/api/qt/stock/get?secid={{secid}}&fltt=2&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f168,f170',
              response: 'json',
              // data 是单个对象 → 自动包成一行
              path: 'data',
              columns: [
                { key: 'f58', label: '名称' },
                { key: 'f57', label: '代码' },
                { key: 'f43', label: '最新价', align: 'right' },
                { key: 'f170', label: '涨跌幅%', align: 'right' },
                { key: 'f46', label: '今开', align: 'right' },
                { key: 'f44', label: '最高', align: 'right' },
                { key: 'f45', label: '最低', align: 'right' },
                { key: 'f60', label: '昨收', align: 'right' },
                { key: 'f47', label: '成交量(手)', align: 'right' },
                { key: 'f48', label: '成交额', align: 'right' },
                { key: 'f168', label: '换手率%', align: 'right' },
              ],
              pollMs: 8000,
            },
          },
        },

        /* ---------- ③ 浮窗：日 K 线 ---------- */
        {
          panelRef: 'panel:stock-kline',
          title: '日K线',
          icon: 'Graph',
          component: 'CandleChart',
          data: {
            kind: 'http',
            http: {
              url: 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={{secid}}&klt=101&fqt=1&lmt=120&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
              response: 'json',
              path: 'data.klines',
              // 每行是逗号分隔字符串：日期,开,收,高,低,量,额,振幅,涨跌幅,涨跌额,换手率
              split: ',',
              // split 模式下按**位置**对应：0=日期 1=开 2=收 3=高 4=低
              columns: [
                { key: 'date', label: '日期' },
                { key: 'open', label: '开盘' },
                { key: 'close', label: '收盘' },
                { key: 'high', label: '最高' },
                { key: 'low', label: '最低' },
              ],
              limit: 120,
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
