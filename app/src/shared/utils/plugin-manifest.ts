/* ============================================================
 * ArkWork — 插件清单解析与校验（纯函数 · v0.33.0；v0.35.0 扩 VP7–VP10）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §3
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §2–§5
 *           ★ v0.35.0：docs/versions/v0.35.0/04-system-design.md §4.2
 *
 * 校验规则 **VP1–VP10**（与 profile 的 V1–V6 独立编号，互不干扰）：
 *   VP1  结构 · VP2 provides↔kind 匹配 · VP3 panel 载荷 · VP4 renderer 载荷 ·
 *   VP5  theme 载荷 · VP6 homeModule/action 载荷
 *   ★ VP7  代码入口：形状（相对路径、不得 `..`）+ 目标是否为空视图
 *   ★ VP8  代码视图与模型工具载荷（placement 只能是 dock/float、tool 名合法）
 *   ★ VP9  权限名必须在白名单内（**未知权限名即 error，不静默忽略**）；v0.36.0 起命令贡献载荷（provides.commands）同归 VP9
 *   ★ VP10 入口路径的**形状**校验（`..` / 绝对路径 / 空段）
 *
 * ⚠️ **VP7 的「文件真的存在吗」不在这里做**：本文件是**零依赖纯函数**
 *    （shared 层不得碰 fs —— 它同时被渲染层 import）。文件存在性、realpath
 *    是否逃逸、`engines` 是否兼容这三项需要真实磁盘与宿主版本，
 *    由主进程侧 `main/plugins/registry.ts` 的 `verifyPluginEntries()` 完成，
 *    并**沿用同一批规则编号**（VP7/VP8/VP10），保证「作者看到的规则号」唯一。
 *
 * 三条纪律（对齐 `04-system-design.md` §12）：
 *  ① **永不抛错** —— 输入是第三方/磁盘 JSON，坏输入只能是「不注册 + 报问题」；
 *  ② **逐插件隔离** —— 调用方按插件独立 try/catch，一个坏插件不得影响其他插件
 *     或阻断启动（插件是外部输入，不能因它起不来）；
 *  ③ **绝不半注册** —— 有 error 即 `manifest: null`，不存在「一半生效」。
 *
 * 零依赖纯函数（沿用 `shared/utils/profile-manifest.ts` 的同一先例）。
 * ============================================================ */
import {
  PLUGIN_API_VERSION,
  PLUGIN_KINDS,
  PLUGIN_PERMISSIONS,
  PLUGIN_SCHEMA_VERSION,
  SUPPORTED_PLUGIN_SCHEMA_VERSIONS,
  type PluginCommandContribution,
  type PluginIssue,
  type PluginKind,
  type PluginManifest,
  type PluginPanelProvide,
  type PluginParseResult,
  type PluginPermission,
  type PluginRule,
  type PluginToolProvide,
  type PluginViewProvide,
} from '@shared/types/plugin'
import { RENDERER_KIND_WHITELIST, VLIB_COMPONENTS, isVLibComponent, PANEL_POLL_MIN_MS, PANEL_DATA_KINDS, isPanelDataKind } from '@shared/types/vlib'
import type { PanelData as PluginPanelData } from '@shared/types/vlib'
import { sanitizeThemeTokens } from './theme-tokens.js'
import { validatePanelData } from './vlib-data.js'

/** 插件 id：命名空间.名称（命名空间允许多段，reverse-DNS，如 `ark.plugin.watchlist`） */
const PLUGIN_ID_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/
/** 语义化版本 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
/** 面板引用（与 panel-model 的归一同源：小写字母数字起始，其余小写/数字/点/连字符/下划线） */
const PANEL_REF_RE = /^panel:[a-z0-9][\w.-]*$/
/** 首页模块引用 */
const MODULE_REF_RE = /^module:[\w.-]+$/
/** 扩展名（小写字母数字，无点无斜杠） */
const EXT_RE = /^[a-z0-9]+$/
/** ★ v0.35.0 视图引用 */
const VIEW_REF_RE = /^view:[a-z0-9][\w.-]*$/
/** ★ v0.35.0 模型工具名（snake_case，与 ArkWork 工具命名一致） */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/
/**
 * ★ v0.35.0 `engines.arkwork` 版本范围（只支持 `>=x.y.z` / `^x.y.z` / 精确值三种写法）。
 *
 * ⚠️ 运算符**必须是捕获组** `(>=|\^)?`：`satisfiesEngineRange` 靠 `r[1]` 取运算符。
 * 曾经写成非捕获组 `(?:>=|\^)?`，于是 `r[1]` 变成了主版本号数字、运算符恒为 '',
 * 判定一路掉进「精确等值」分支且比较对象是 NaN —— 结果是**任何**声明了
 * engines 的插件都被判不兼容（且因为宿主版本当时也没注入，双重失效）。
 * 回归用例：TC-PMF-ENG-001..008 / TC-PLGR-010..014。
 */
const ENGINE_RANGE_RE = /^(>=|\^)?(\d+)\.(\d+)\.(\d+)$/

/**
 * ★ v0.35.0：入口路径的**形状**校验（VP10 的纯函数部分）。
 *
 * 为什么形状也要查：`main: "../../../etc/passwd"` 在纯函数层拦掉，
 * 作者能立刻拿到规则号；磁盘级 realpath 校验（挡 symlink）在主进程再做一层。
 * **两层都要**，因为纯函数层不知道插件目录在哪。
 *
 * @returns 合法返回 null，否则返回人话原因
 */
export function checkEntryPathShape(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim().length === 0) return '入口路径必须是非空字符串'
  const p = v.trim()
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return '入口路径必须是相对插件目录的相对路径'
  if (p.includes('\\')) return '入口路径必须用 / 分隔（不接受反斜杠）'
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    return '入口路径不得包含空段、"." 或 ".."（防止逃出插件目录）'
  }
  return null
}

/** ★ v0.35.0：`engines.arkwork` 版本范围是否与宿主版本兼容（纯字符串比较，不引 semver 包） */
export function satisfiesEngineRange(range: string, hostVersion: string): boolean {
  const m = /^(>=|\^)?(\d+)\.(\d+)\.(\d+)$/.exec(hostVersion)
  if (!m) return true // 宿主版本读不出来时不阻断（宁可放过，不误杀）
  const host = [Number(m[2]), Number(m[3]), Number(m[4])] as const
  const r = ENGINE_RANGE_RE.exec(range)
  if (!r) return false
  const op = r[1] ?? ''
  const want = [Number(r[2]), Number(r[3]), Number(r[4])] as const
  const cmp = (a: readonly number[], b: readonly number[]): number =>
    a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!
  if (op === '>=') return cmp(host, want) >= 0
  if (op === '^') return host[0] === want[0] && cmp(host, want) >= 0 // 同主版本且不低于
  return cmp(host, want) === 0
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/**
 * v0.34.0（D54）：面向用户的**展示名**（title / label）是否含未解析模板占位符。
 *
 * 为什么这是 warning 而不是 error：`{{...}}` 在 i18n 模板里是合法语法，
 * 作者可能是「先写占位符、之后接自己的渲染管线」。但宿主的展示层**不会**
 * 二次插值，竖排栏会把 `{{titile}}` 原样画出来（用户实测报障）。
 * 因此：**照常注册**（不半注册、不拒绝），但把事实作为告警报给作者。
 */
export function containsTemplatePlaceholder(v: unknown): boolean {
  return typeof v === 'string' && /\{\{[^}]*\}\}/.test(v)
}

function issue(
  rule: PluginRule,
  level: PluginIssue['level'],
  path: string,
  message: string,
  fix?: string,
): PluginIssue {
  return { rule, level, path, message, fix }
}

export { RENDERER_KIND_WHITELIST }

/**
 * 校验并解析**一个**面板条目（VP3）。
 *
 * `provides.panel` 与 `provides.panels[i]` 共用本函数 —— 抽取它的唯一理由
 * 就是防止两条通道的校验强度漂移（v0.34.1 新增多面板时的第一风险）。
 *
 * @param path JSON Path 前缀（问题定位要指到具体那一项，不能都报 $.provides.panel）
 */
function parsePanelSpec(
  p: unknown,
  path: string,
  issues: PluginIssue[],
): PluginPanelProvide | null {
  if (!isObj(p)) {
    issues.push(issue('VP3', 'error', path, '面板条目必须是对象'))
    return null
  }
  if (!isStr(p.panelRef) || !PANEL_REF_RE.test(p.panelRef)) {
    issues.push(issue('VP3', 'error', `${path}.panelRef`, 'panelRef 必填且形如 "panel:<name>"（小写字母/数字/点/连字符）', '例如 "panel:watchlist"'))
  }
  if (!isStr(p.title)) issues.push(issue('VP3', 'error', `${path}.title`, '面板标题 title 必填'))
  else if (containsTemplatePlaceholder(p.title)) {
    // v0.34.0（D54）：宿主不做二次插值 → 占位符会原样出现在竖排栏上
    issues.push(
      issue(
        'VP3',
        'warning',
        `${path}.title`,
        'title 含未解析的模板占位符（{{…}}）—— 宿主不会对其二次插值，界面将原样显示该字样',
        '把 title 改为最终展示文案，占位符请在自己的构建/渲染管线里解析',
      ),
    )
  }
  if (!isVLibComponent(p.component)) {
    issues.push(
      issue('VP3', 'error', `${path}.component`, `未知宿主组件「${String(p.component)}」`, `可选：${VLIB_COMPONENTS.join(' / ')}`),
    )
  }
  if (!isObj(p.data)) {
    issues.push(issue('VP3', 'error', `${path}.data`, '面板必须声明 data（static / file / http / mcp）'))
  } else {
    const dk = p.data.kind
    // D61：统一走单一事实源守卫（此前硬编码四路链表，新增 kind 时必漏）。
    if (!isPanelDataKind(dk)) {
      issues.push(issue('VP3', 'error', `${path}.data.kind`, `未知数据源「${String(dk)}」`, `可选：${PANEL_DATA_KINDS.join(' / ')}`))
    } else if (dk === 'file') {
      if (!isStr(p.data.path)) {
        issues.push(issue('VP3', 'error', `${path}.data.path`, 'file 数据源必须给出 path', '例如 "reports/quotes.json"'))
      }
    } else if (dk === 'http') {
      // v0.34.1：http 源的两条硬约束 —— ① 必须给 url ② 只允许 http/https
      const spec = p.data.http
      if (!isObj(spec)) {
        issues.push(issue('VP3', 'error', `${path}.data.http`, 'http 数据源必须给出 data.http 规格对象', '形如 { "url": "https://…", "path": "data.diff" }'))
      } else {
        if (!isStr(spec.url)) {
          issues.push(issue('VP3', 'error', `${path}.data.http.url`, 'http 数据源必须给出 url'))
        } else if (!/^https?:\/\//i.test(spec.url)) {
          issues.push(
            issue('VP3', 'error', `${path}.data.http.url`, `url 只允许 http/https，收到「${spec.url}」`, '改用 https:// 开头的公开接口'),
          )
        }
        // 轮询下限由宿主硬夹（不是 error —— 夹到 3s 而不是拒绝注册）
        if (typeof spec.pollMs === 'number' && spec.pollMs > 0 && spec.pollMs < PANEL_POLL_MIN_MS) {
          issues.push(
            issue('VP3', 'warning', `${path}.data.http.pollMs`, `轮询间隔 ${spec.pollMs}ms 低于下限，宿主会夹到 ${PANEL_POLL_MIN_MS}ms`, `改为 ≥ ${PANEL_POLL_MIN_MS}`),
          )
        }
      }
    } else if (dk === 'mcp') {
      if (!isStr(p.data.server)) issues.push(issue('VP3', 'error', `${path}.data.server`, 'mcp 数据源必须给出 server'))
      if (!isStr(p.data.method)) issues.push(issue('VP3', 'error', `${path}.data.method`, 'mcp 数据源必须给出 method'))
    } else {
      // static：形状必须与组件需求自洽（这是「组件只认形状」的落地检查）
      const chk = validatePanelData(p.component, p.data)
      if (!chk.ok) {
        issues.push(issue('VP3', 'error', `${path}.data`, `静态数据形状与组件不匹配：${chk.reason}`, '补齐必需字段，或把 kind 改为 file/http/mcp'))
      }
    }
  }
  // v0.34.1：交互声明（行点击 → 浮窗打开面板）。
  // 只校验形状；目标面板是否存在由装配期诊断登记 —— 插件加载顺序不保证，早判会误杀。
  if (isObj(p.interact)) {
    const rc = p.interact.onRowClick
    if (isObj(rc)) {
      const refs = rc.panelRefs
      if (!Array.isArray(refs) || refs.length === 0) {
        issues.push(
          issue('VP3', 'error', `${path}.interact.onRowClick.panelRefs`, 'onRowClick.panelRefs 必须是非空数组', '例如 ["panel:stock-detail"]'),
        )
      } else if (!refs.every((r) => typeof r === 'string' && PANEL_REF_RE.test(r))) {
        issues.push(
          issue('VP3', 'error', `${path}.interact.onRowClick.panelRefs`, 'panelRefs 每项必须形如 "panel:<name>"', '例如 "panel:stock-kline"'),
        )
      }
    }
  }

  // 本条目内是否有 error（有则不产出，绝不半注册）
  const hasError = issues.some((i) => i.level === 'error' && i.path.startsWith(path))
  if (hasError || !isStr(p.panelRef) || !isStr(p.title) || !isVLibComponent(p.component) || !isObj(p.data)) {
    return null
  }
  return {
    panelRef: p.panelRef,
    title: p.title,
    icon: isStr(p.icon) ? p.icon : undefined,
    component: p.component,
    data: p.data as unknown as PluginPanelData,
    interact: isObj(p.interact) && isObj(p.interact.onRowClick)
      ? {
          onRowClick: {
            panelRefs: (p.interact.onRowClick.panelRefs as unknown[]).map(String),
            params: isObj(p.interact.onRowClick.params)
              ? (Object.fromEntries(
                  Object.entries(p.interact.onRowClick.params).map(([k, v]) => [k, String(v)]),
                ) as Record<string, string>)
              : undefined,
          },
        }
      : undefined,
  }
}

/** 解析 + 校验。有 error 即返回 `manifest: null`（绝不半注册）。 */
export function parsePluginManifest(raw: unknown): PluginParseResult {
  const issues: PluginIssue[] = []

  if (!isObj(raw)) {
    issues.push(issue('VP1', 'error', '$', '插件清单必须是一个 JSON 对象', '检查 plugin.json 是否被截断'))
    return { manifest: null, issues }
  }

  /* ---- VP1 结构 ---- */
  let schemaVersion = PLUGIN_SCHEMA_VERSION
  if (!isStr(raw.schemaVersion)) {
    issues.push(
      issue('VP1', 'warning', '$.schemaVersion', `缺少 schemaVersion，按当前版本 ${PLUGIN_SCHEMA_VERSION} 处理`, `补 "schemaVersion": "${PLUGIN_SCHEMA_VERSION}"`),
    )
  } else if (!(SUPPORTED_PLUGIN_SCHEMA_VERSIONS as readonly string[]).includes(raw.schemaVersion)) {
    // v0.35.0：可接受集合扩到 ['1.0','1.1'] —— `1.0` 是「零代码声明式插件」，是一等公民不是遗留
    issues.push(
      issue(
        'VP1',
        'error',
        '$.schemaVersion',
        `schemaVersion 为 ${String(raw.schemaVersion)}，底座支持 ${SUPPORTED_PLUGIN_SCHEMA_VERSIONS.join(' / ')}`,
        `改为 "${PLUGIN_SCHEMA_VERSION}"`,
      ),
    )
    schemaVersion = String(raw.schemaVersion)
  } else {
    schemaVersion = raw.schemaVersion
  }

  let id = ''
  if (!isStr(raw.id)) {
    issues.push(issue('VP1', 'error', '$.id', 'id 必填且为非空字符串', '例如 "ark.plugin.watchlist"'))
  } else if (!PLUGIN_ID_RE.test(raw.id)) {
    issues.push(issue('VP1', 'error', '$.id', `id "${raw.id}" 不符合「命名空间.名称」（小写字母/数字/连字符，命名空间可多段）`, '例如 "ark.plugin.watchlist"'))
  } else {
    id = raw.id
  }

  if (!isStr(raw.name)) issues.push(issue('VP1', 'error', '$.name', 'name 必填且为非空字符串'))
  if (!isStr(raw.version)) {
    issues.push(issue('VP1', 'error', '$.version', 'version 必填且为非空字符串', '例如 "1.0.0"'))
  } else if (!SEMVER_RE.test(raw.version)) {
    issues.push(issue('VP1', 'error', '$.version', `version "${raw.version}" 不是语义化版本`, '例如 "1.0.0"'))
  }

  let kind: PluginKind | null = null
  if (!isStr(raw.kind)) {
    issues.push(issue('VP1', 'error', '$.kind', 'kind 必填', `可选：${PLUGIN_KINDS.join(' / ')}`))
  } else if (!(PLUGIN_KINDS as readonly string[]).includes(raw.kind)) {
    issues.push(issue('VP1', 'error', '$.kind', `未知插件类型「${raw.kind}」`, `可选：${PLUGIN_KINDS.join(' / ')}`))
  } else {
    kind = raw.kind as PluginKind
  }

  /* ---- VP2 provides ↔ kind 匹配 ---- */
  const provides: PluginManifest['provides'] = {}
  if (!isObj(raw.provides)) {
    issues.push(issue('VP2', 'error', '$.provides', 'provides 必填且为对象', '按 kind 提供对应的一项'))
  } else if (kind && !isObj(raw.provides[kind])) {
    // v0.34.1：panel 额外接受 `provides.panels`（多面板）—— 一个插件贡献一组面板
    // v0.35.0：panel 还额外接受 `provides.views`（代码视图）—— 「一个面板插件带自己的界面」
    const panelOk =
      kind === 'panel' &&
      ((Array.isArray(raw.provides.panels) && raw.provides.panels.length > 0) ||
        (Array.isArray(raw.provides.views) && raw.provides.views.length > 0))
    if (!panelOk) {
      issues.push(
        issue('VP2', 'error', `$.provides.${kind}`, `kind 为 "${kind}" 时 provides.${kind} 必填`, kind === 'panel' ? '补 provides.panel 对象，或 provides.panels / provides.views 数组' : `补一个 provides.${kind} 对象`),
      )
    }
  }

  if (isObj(raw.provides)) {
    /* ---- VP3 panel（单面板）+ panels（多面板，v0.34.1）----
     * 两者的校验**共用同一段逻辑**：多面板只是把同一份规格跑 N 遍，
     * 绝不出现「单面板查得严、多面板放水」的双标。
     */
    if (isObj(raw.provides.panel)) {
      const parsed = parsePanelSpec(raw.provides.panel, '$.provides.panel', issues)
      if (parsed) provides.panel = parsed
    }
    if (Array.isArray(raw.provides.panels)) {
      if (raw.provides.panels.length === 0) {
        issues.push(issue('VP3', 'warning', '$.provides.panels', 'provides.panels 是空数组（不贡献任何面板）', '去掉该字段，或至少给一个面板'))
      }
      const list: PluginPanelProvide[] = []
      raw.provides.panels.forEach((rawItem, i) => {
        const parsed = parsePanelSpec(rawItem, `$.provides.panels[${i}]`, issues)
        if (parsed) list.push(parsed)
      })
      if (list.length > 0) provides.panels = list
    }

    /* ---- VP4 renderer ---- */
    if (isObj(raw.provides.renderer)) {
      const r = raw.provides.renderer
      let ok = true
      if (!isStr(r.rendererKind) || !(RENDERER_KIND_WHITELIST as readonly string[]).includes(r.rendererKind)) {
        issues.push(
          issue('VP4', 'error', '$.provides.renderer.rendererKind', `未知渲染器类型「${String(r.rendererKind)}」`, `可选：${RENDERER_KIND_WHITELIST.join(' / ')}`),
        )
        ok = false
      }
      if (!Array.isArray(r.extensions) || r.extensions.length === 0) {
        issues.push(issue('VP4', 'error', '$.provides.renderer.extensions', 'extensions 必须是非空数组（小写扩展名，不含点）', '例如 ["kchart"]'))
        ok = false
      } else {
        const bad = r.extensions.filter((e) => typeof e !== 'string' || !EXT_RE.test(e))
        if (bad.length > 0) {
          issues.push(
            issue('VP4', 'error', '$.provides.renderer.extensions', `非法扩展名：${bad.map(String).join(' / ')}（必须全小写字母数字、不含点）`, '例如 "kchart" 而不是 ".kchart" / "KChart"'),
          )
          ok = false
        }
      }
      if (ok) {
        provides.renderer = {
          rendererKind: String(r.rendererKind),
          extensions: (r.extensions as unknown[]).map(String),
          override: r.override === true,
          labelKey: isStr(r.labelKey) ? r.labelKey : undefined,
        }
      }
    }

    /* ---- VP5 theme ---- */
    if (isObj(raw.provides.theme)) {
      const { tokens, rejected } = sanitizeThemeTokens(raw.provides.theme)
      for (const r of rejected) {
        issues.push(
          issue('VP5', 'error', `$.provides.theme.${r.group}.${r.key}`, `主题 token 不合法：${r.reason}`, '改为已存在的 --token 名 + 十六进制/rgb()/长度值'),
        )
      }
      if (rejected.length === 0) {
        if (Object.keys(tokens.light).length === 0 && Object.keys(tokens.dark).length === 0) {
          issues.push(issue('VP5', 'warning', '$.provides.theme', '主题插件未提供任何 token 覆盖', '至少给出一个 --token'))
        }
        provides.theme = { light: tokens.light, dark: tokens.dark }
      }
    }

    /* ---- VP6 homeModule ---- */
    if (isObj(raw.provides.homeModule)) {
      const h = raw.provides.homeModule
      if (!isStr(h.module) || !MODULE_REF_RE.test(h.module)) {
        issues.push(issue('VP6', 'error', '$.provides.homeModule.module', 'module 必填且形如 "module:<id>"', '例如 "module:market-overview"'))
      } else if (!isStr(h.title)) {
        issues.push(issue('VP6', 'error', '$.provides.homeModule.title', '首页模块标题 title 必填'))
      } else {
        // v0.34.0（D54）：占位符只是「照常注册 + 报事实」，不阻断注册
        if (containsTemplatePlaceholder(h.title)) {
          issues.push(
            issue(
              'VP6',
              'warning',
              '$.provides.homeModule.title',
              'title 含未解析的模板占位符（{{…}}）—— 宿主不会对其二次插值，界面将原样显示该字样',
              '把 title 改为最终展示文案',
            ),
          )
        }
        provides.homeModule = {
          module: String(h.module),
          title: String(h.title),
          icon: isStr(h.icon) ? h.icon : undefined,
        }
      }
    }

    /* ---- VP6 action ---- */
    if (isObj(raw.provides.action)) {
      const a = raw.provides.action
      if (!isStr(a.actionId)) {
        issues.push(issue('VP6', 'error', '$.provides.action.actionId', 'actionId 必填且为非空字符串', '例如 "annotate-trend"'))
      } else if (!isStr(a.label)) {
        issues.push(issue('VP6', 'error', '$.provides.action.label', '动作 label 必填'))
      } else {
        // v0.34.0（D54）：同 homeModule —— 告警不阻断注册
        if (containsTemplatePlaceholder(a.label)) {
          issues.push(
            issue(
              'VP6',
              'warning',
              '$.provides.action.label',
              'label 含未解析的模板占位符（{{…}}）—— 宿主不会对其二次插值，界面将原样显示该字样',
              '把 label 改为最终展示文案',
            ),
          )
        }
        provides.action = { actionId: String(a.actionId), label: String(a.label) }
      }
    }

    /* ---- ★ VP8 代码视图（provides.views）—— 只能进浮窗与右侧侧边栏 ---- */
    if (raw.provides.views !== undefined) {
      if (!Array.isArray(raw.provides.views)) {
        issues.push(issue('VP8', 'error', '$.provides.views', 'provides.views 必须是数组', '形如 [{ "viewRef": "view:x", "title": "…", "placement": "dock" }]'))
      } else if (raw.provides.views.length === 0) {
        issues.push(issue('VP8', 'warning', '$.provides.views', 'provides.views 是空数组（不贡献任何视图）', '去掉该字段，或至少给一个视图'))
      } else {
        const list: PluginViewProvide[] = []
        raw.provides.views.forEach((rawView, i) => {
          const path = `$.provides.views[${i}]`
          if (!isObj(rawView)) {
            issues.push(issue('VP8', 'error', path, '视图条目必须是对象'))
            return
          }
          let ok = true
          if (!isStr(rawView.viewRef) || !VIEW_REF_RE.test(rawView.viewRef)) {
            issues.push(issue('VP8', 'error', `${path}.viewRef`, 'viewRef 必填且形如 "view:<name>"', '例如 "view:my-calc"'))
            ok = false
          }
          if (!isStr(rawView.title)) {
            issues.push(issue('VP8', 'error', `${path}.title`, '视图标题 title 必填'))
            ok = false
          }
          // ★ 边界纪律：插件只能控**浮窗**与**右侧侧边栏**。闭集判定，别的值一律拒。
          if (rawView.placement !== 'dock' && rawView.placement !== 'float') {
            issues.push(
              issue('VP8', 'error', `${path}.placement`, `placement 只能是 "dock"（右侧侧边栏）或 "float"（浮窗），收到「${String(rawView.placement)}」`, '插件不得在其他 UI 区域加挂点'),
            )
            ok = false
          }
          if (rawView.renderer !== undefined) {
            const bad = checkEntryPathShape(rawView.renderer)
            if (bad) {
              issues.push(issue('VP10', 'error', `${path}.renderer`, `renderer 入口不合法：${bad}`, '例如 "renderer.js" 或 "ui/index.html"'))
              ok = false
            }
          }
          if (ok) {
            const size = isObj(rawView.initialSize) ? rawView.initialSize : null
            list.push({
              viewRef: String(rawView.viewRef),
              title: String(rawView.title),
              icon: isStr(rawView.icon) ? rawView.icon : undefined,
              renderer: isStr(rawView.renderer) ? rawView.renderer : undefined,
              placement: rawView.placement as PluginViewProvide['placement'],
              initialSize:
                size && typeof size.w === 'number' && typeof size.h === 'number'
                  ? { w: size.w, h: size.h }
                  : undefined,
            })
          }
        })
        if (list.length > 0) provides.views = list
      }
    }

    /* ---- ★ VP8 模型工具（provides.tools）---- */
    if (raw.provides.tools !== undefined) {
      if (!Array.isArray(raw.provides.tools)) {
        issues.push(issue('VP8', 'error', '$.provides.tools', 'provides.tools 必须是数组', '形如 [{ "name": "calc", "description": "…", "inputSchema": {…} }]'))
      } else if (raw.provides.tools.length === 0) {
        issues.push(issue('VP8', 'warning', '$.provides.tools', 'provides.tools 是空数组（不贡献任何工具）', '去掉该字段，或至少给一个工具'))
      } else {
        const list: PluginToolProvide[] = []
        raw.provides.tools.forEach((rawTool, i) => {
          const path = `$.provides.tools[${i}]`
          if (!isObj(rawTool)) {
            issues.push(issue('VP8', 'error', path, '工具条目必须是对象'))
            return
          }
          let ok = true
          if (!isStr(rawTool.name) || !TOOL_NAME_RE.test(rawTool.name)) {
            issues.push(issue('VP8', 'error', `${path}.name`, 'name 必填且为 snake_case（小写字母开头，仅含小写字母/数字/下划线）', '例如 "calc_indicator"'))
            ok = false
          }
          if (!isStr(rawTool.description)) {
            issues.push(issue('VP8', 'error', `${path}.description`, 'description 必填（模型靠它决定何时调用）'))
            ok = false
          }
          if (!isObj(rawTool.inputSchema)) {
            issues.push(issue('VP8', 'error', `${path}.inputSchema`, 'inputSchema 必填且为 JSON Schema 对象', '形如 { "type": "object", "properties": {…} }'))
            ok = false
          }
          if (ok) {
            list.push({
              name: String(rawTool.name),
              description: String(rawTool.description),
              inputSchema: rawTool.inputSchema as Record<string, unknown>,
            })
          }
        })
        if (list.length > 0) provides.tools = list
      }
    }

    /* ---- ★ v0.36.0 VP9 命令贡献（provides.commands）---- */
    if (raw.provides.commands !== undefined) {
      if (!Array.isArray(raw.provides.commands)) {
        issues.push(issue('VP9', 'error', '$.provides.commands', 'provides.commands 必须是数组', '形如 [{ "id": "my.status", "title": "查询状态" }]'))
      } else if (raw.provides.commands.length === 0) {
        issues.push(issue('VP9', 'warning', '$.provides.commands', 'provides.commands 是空数组（不贡献任何命令）', '去掉该字段，或至少给一个命令'))
      } else if (raw.provides.commands.length > 32) {
        issues.push(issue('VP9', 'error', '$.provides.commands', 'provides.commands 超过上限 32 条', '精简命令数量，或合并为带参数的单条命令'))
      } else {
        const list: PluginCommandContribution[] = []
        const seen = new Set<string>()
        raw.provides.commands.forEach((rawCmd, i) => {
          const path = `$.provides.commands[${i}]`
          if (!isObj(rawCmd)) {
            issues.push(issue('VP9', 'error', path, '命令条目必须是对象'))
            return
          }
          if (typeof rawCmd.id !== 'string' || !/^[\w][\w.-]*$/.test(rawCmd.id)) {
            issues.push(issue('VP9', 'error', `${path}.id`, 'id 必填且仅含小写字母/数字/点/连字符/下划线', '例如 "my.status"'))
            return
          }
          if (seen.has(rawCmd.id)) {
            issues.push(issue('VP9', 'error', `${path}.id`, `命令 id「${rawCmd.id}」在本插件内重复`, '每个命令的 id 必须唯一'))
            return
          }
          seen.add(rawCmd.id)
          if (typeof rawCmd.title !== 'string' || !rawCmd.title.trim()) {
            issues.push(issue('VP9', 'error', `${path}.title`, 'title 必填（QuickAction 与插件详情里直接显示）'))
            return
          }
          list.push({
            id: rawCmd.id,
            title: rawCmd.title.trim(),
            ...(typeof rawCmd.icon === 'string' && rawCmd.icon.trim() ? { icon: rawCmd.icon.trim() } : {}),
          })
        })
        if (list.length > 0) provides.commands = list
      }
    }
  }

  /* ---- ★ VP7/VP9/VP10 顶层：入口、权限、引擎 ---- */
  let mainEntry: string | undefined
  if (raw.main !== undefined) {
    const bad = checkEntryPathShape(raw.main)
    if (bad) issues.push(issue('VP10', 'error', '$.main', `Host 半入口不合法：${bad}`, '例如 "main.js"'))
    else mainEntry = String(raw.main).trim()
  }
  let rendererEntry: string | undefined
  if (raw.renderer !== undefined) {
    const bad = checkEntryPathShape(raw.renderer)
    if (bad) issues.push(issue('VP10', 'error', '$.renderer', `Client 半入口不合法：${bad}`, '例如 "renderer.js"'))
    else rendererEntry = String(raw.renderer).trim()
  }

  // VP9：权限名必须在白名单内。**未知权限名即 error** —— 静默忽略会让作者以为"声明了就有"。
  let permissions: PluginPermission[] | undefined
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) {
      issues.push(issue('VP9', 'error', '$.permissions', 'permissions 必须是字符串数组', '例如 ["fs:workspace-read", "net"]'))
    } else {
      const known: PluginPermission[] = []
      const unknown: string[] = []
      for (const p of raw.permissions) {
        if (typeof p === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(p)) {
          known.push(p as PluginPermission)
        } else {
          unknown.push(String(p))
        }
      }
      if (unknown.length > 0) {
        issues.push(
          issue('VP9', 'error', '$.permissions', `未知权限名：${unknown.join(' / ')}`, `可选：${PLUGIN_PERMISSIONS.join(' / ')}`),
        )
      }
      // 去重（同一权限写两遍无害，但收敛成一份方便诊断展示）
      permissions = Array.from(new Set(known))
    }
  }

  // VP7（形状部分）：声明了代码视图却没有任何入口 → 视图跑不起来，属于作者笔误
  if (provides.views && provides.views.length > 0) {
    const missing = provides.views
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => !v.renderer && !rendererEntry)
    for (const { v, i } of missing) {
      issues.push(
        issue('VP7', 'error', `$.provides.views[${i}].renderer`, `视图「${v.viewRef}」没有 Client 半入口（views[i].renderer 与顶层 renderer 都缺失）`, '补 views[i].renderer，或在清单顶层写 "renderer": "renderer.js"'),
      )
    }
  }

  // VP8：声明了模型工具，但没有 Host 半入口 → 工具无实现
  if (provides.tools && provides.tools.length > 0 && !mainEntry) {
    issues.push(
      issue('VP7', 'error', '$.main', '声明了 provides.tools 却没有 Host 半入口（main）—— 工具无处执行', '补 "main": "main.js"'),
    )
  }

  // VP7：声明了命令，但没有 Host 半入口 → 命令无人处理
  if (provides.commands && provides.commands.length > 0 && !mainEntry) {
    issues.push(
      issue('VP7', 'error', '$.main', '声明了 provides.commands 却没有 Host 半入口（main）—— 命令无人处理', '补 "main": "main.js"，或去掉 provides.commands'),
    )
  }

  // apiVersion：缺省 1；声明了不匹配的值直接报错（契约版本不兼容不是小事）
  let apiVersion = PLUGIN_API_VERSION
  if (raw.apiVersion !== undefined) {
    if (raw.apiVersion !== PLUGIN_API_VERSION) {
      issues.push(
        issue('VP1', 'error', '$.apiVersion', `apiVersion 为 ${String(raw.apiVersion)}，本底座支持 ${PLUGIN_API_VERSION}`, `改为 ${PLUGIN_API_VERSION}`),
      )
    } else {
      apiVersion = PLUGIN_API_VERSION
    }
  }

  // engines.arkwork：只校验**形状**；版本是否兼容由主进程侧按真实宿主版本判定（VP8 的磁盘部分）
  let engines: { arkwork?: string } | undefined
  if (raw.engines !== undefined) {
    if (!isObj(raw.engines)) {
      issues.push(issue('VP8', 'error', '$.engines', 'engines 必须是对象', '形如 { "arkwork": ">=0.35.0" }'))
    } else if (raw.engines.arkwork !== undefined) {
      if (typeof raw.engines.arkwork !== 'string' || !ENGINE_RANGE_RE.test(raw.engines.arkwork)) {
        issues.push(
          issue('VP8', 'error', '$.engines.arkwork', `版本范围「${String(raw.engines.arkwork)}」不合法`, '支持 ">=0.35.0" / "^0.35.0" / "0.35.0" 三种写法'),
        )
      } else {
        engines = { arkwork: raw.engines.arkwork }
      }
    }
  }

  // activation：只认四种事件前缀
  let activation: string[] | undefined
  if (raw.activation !== undefined) {
    if (!Array.isArray(raw.activation)) {
      issues.push(issue('VP1', 'error', '$.activation', 'activation 必须是字符串数组', '例如 ["onWorkspaceOpen", "onView:view:my-calc"]'))
    } else {
      const ok: string[] = []
      const bad: string[] = []
      for (const a of raw.activation) {
        const s = String(a)
        if (s === 'onStartup' || s === 'onWorkspaceOpen' || /^on(?:View|Tool|Panel):/.test(s)) ok.push(s)
        else bad.push(s)
      }
      if (bad.length > 0) {
        issues.push(
          issue('VP1', 'error', '$.activation', `未知激活事件：${bad.join(' / ')}`, '可选：onStartup / onWorkspaceOpen / onView:<ref> / onTool:<name> / onPanel:<ref>'),
        )
      }
      activation = ok
    }
  }

  // kind='tool' 必须真的给工具（否则插件什么都不贡献）
  if (kind === 'tool' && (!provides.tools || provides.tools.length === 0)) {
    issues.push(issue('VP2', 'error', '$.provides.tools', 'kind 为 "tool" 时必须贡献至少一个模型工具', '补 provides.tools 数组'))
  }

  const hasError = issues.some((i) => i.level === 'error')
  if (hasError || !kind) return { manifest: null, issues }

  return {
    manifest: {
      schemaVersion,
      id,
      name: isStr(raw.name) ? raw.name : id,
      version: isStr(raw.version) ? raw.version : '0.0.0',
      author: isStr(raw.author) ? raw.author : undefined,
      description: isStr(raw.description) ? raw.description : undefined,
      kind,
      enabledByDefault: raw.enabledByDefault !== false,
      /* ★ v0.35.0 新增字段（全部可选；缺省即「零代码声明式插件」） */
      apiVersion,
      engines,
      main: mainEntry,
      renderer: rendererEntry,
      activation,
      permissions,
      provides,
    },
    issues,
  }
}

/** 人话贡献摘要（列表与诊断页共用） */
export function contributionLabelOf(m: PluginManifest): string {
  const extra: string[] = []
  if (m.provides.views?.length) extra.push(`视图 ×${m.provides.views.length}`)
  if (m.provides.tools?.length) extra.push(`工具 ×${m.provides.tools.length}`)
  if (m.provides.commands?.length) extra.push(`命令 ×${m.provides.commands.length}`)
  const suffix = extra.length > 0 ? ` ＋ ${extra.join(' ＋ ')}` : ''

  switch (m.kind) {
    case 'panel': {
      const list = [m.provides.panel, ...(m.provides.panels ?? [])].filter(Boolean)
      if (list.length === 0) return `视图插件（无声明式面板）${suffix}`
      if (list.length === 1) return `面板 ×1（${list[0]!.component}）${suffix}`
      return `面板 ×${list.length}（${list.map((x) => x!.component).join(' / ')}）${suffix}`
    }
    case 'renderer': {
      const exts = m.provides.renderer?.extensions ?? []
      return `渲染器 ×${exts.length}（.${exts.join(' / .')}）${suffix}`
    }
    case 'action':
      return `动作 ×1（${m.provides.action?.actionId ?? '?'}）${suffix}`
    case 'homeModule':
      return `首页模块 ×1（${m.provides.homeModule?.module ?? '?'}）${suffix}`
    case 'theme':
      return `主题 token 覆盖 ×1${suffix}`
    case 'tool':
      return `模型工具 ×${m.provides.tools?.length ?? 0}${suffix}`
    default:
      return '—'
  }
}
