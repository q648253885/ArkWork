/* ============================================================
 * ArkWork — 插件清单解析与校验（纯函数 · v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §3
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §2–§5
 *
 * 校验规则 **VP1–VP6**（与 profile 的 V1–V6 独立编号，互不干扰）：
 *   VP1 结构 · VP2 provides↔kind 匹配 · VP3 panel 载荷 · VP4 renderer 载荷 ·
 *   VP5 theme 载荷 · VP6 homeModule/action 载荷
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
  PLUGIN_KINDS,
  PLUGIN_SCHEMA_VERSION,
  type PluginIssue,
  type PluginKind,
  type PluginManifest,
  type PluginPanelProvide,
  type PluginParseResult,
  type PluginRule,
} from '@shared/types/plugin'
import { RENDERER_KIND_WHITELIST, VLIB_COMPONENTS, isVLibComponent, PANEL_POLL_MIN_MS } from '@shared/types/vlib'
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
    if (dk !== 'static' && dk !== 'file' && dk !== 'http' && dk !== 'mcp') {
      issues.push(issue('VP3', 'error', `${path}.data.kind`, `未知数据源「${String(dk)}」`, '可选：static / file / http / mcp'))
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
  } else if (raw.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    issues.push(
      issue('VP1', 'error', '$.schemaVersion', `schemaVersion 为 ${String(raw.schemaVersion)}，底座仅支持 ${PLUGIN_SCHEMA_VERSION}`, `改为 "${PLUGIN_SCHEMA_VERSION}"`),
    )
    schemaVersion = String(raw.schemaVersion)
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
    if (!(kind === 'panel' && Array.isArray(raw.provides.panels) && raw.provides.panels.length > 0)) {
      issues.push(
        issue('VP2', 'error', `$.provides.${kind}`, `kind 为 "${kind}" 时 provides.${kind} 必填`, kind === 'panel' ? '补 provides.panel 对象或 provides.panels 数组' : `补一个 provides.${kind} 对象`),
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
      provides,
    },
    issues,
  }
}

/** 人话贡献摘要（列表与诊断页共用） */
export function contributionLabelOf(m: PluginManifest): string {
  switch (m.kind) {
    case 'panel': {
      const list = [m.provides.panel, ...(m.provides.panels ?? [])].filter(Boolean)
      if (list.length <= 1) return `面板 ×1（${m.provides.panel?.component ?? '?'}）`
      return `面板 ×${list.length}（${list.map((x) => x!.component).join(' / ')}）`
    }
    case 'renderer': {
      const exts = m.provides.renderer?.extensions ?? []
      return `渲染器 ×${exts.length}（.${exts.join(' / .')}）`
    }
    case 'action':
      return `动作 ×1（${m.provides.action?.actionId ?? '?'}）`
    case 'homeModule':
      return `首页模块 ×1（${m.provides.homeModule?.module ?? '?'}）`
    case 'theme':
      return `主题 token 覆盖 ×1`
    default:
      return '—'
  }
}
