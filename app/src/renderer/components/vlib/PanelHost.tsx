/* ============================================================
 * ArkWork — 面板宿主（四态渲染 · v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §7.2 / §8.2
 *           03-interaction.md §「Inspector 面板 Tab 规格」
 *
 * 四态（**互斥且穷尽** —— 绝不存在「什么都没显示」的第五态）：
 *   loading  数据拉取中（仅 `file` 源可能出现）
 *   error    形状不合法 / 读文件失败 / `mcp` 未接线 —— **必须给出人话原因**
 *   empty    形状合法但没有内容（rows/points 为空、text 为空）
 *   ready    交给白名单组件渲染
 *
 * 纪律：**降级必须可见**（「永不静默半死」）。任何非 ready 态都要有
 * 图标 + 文案，不允许空白面板。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { EmptyState } from '../ui'
import type { PanelTab } from '@shared/utils/panel-model'
import { isPanelDataEmpty, validatePanelData } from '@shared/utils/vlib-data'
import { resolveVLib } from './index'
import { usePanelData } from './use-panel-data'
// v0.34.0（D54）：正文标题只做「未解析模板串」防御，不做长度截断（见该模块头注释）
import { guardBodyTitle } from '../../utils/label-guard'

export function PanelHost({ tab }: { tab: PanelTab }) {
  const { t } = useTranslation()
  // v0.34.1：tab.params 参与 http 源 URL 的 {{key}} 替换（行点击打开个股详情靠它）
  const state = usePanelData(String(tab.component ?? ''), tab.data, tab.params)
  // 贡献者写的 title 是第三方输入：宿主的展示层不做二次插值，
  // 因此 `{{...}}` 会被原样画出来（用户实测）。此处兜底并留 warn。
  const bodyTitle = guardBodyTitle(tab.title)

  const shell = (children: React.ReactNode, aria?: string) => (
    <div
      className="h-full flex flex-col min-h-0"
      role="tabpanel"
      aria-label={aria ?? bodyTitle}
      data-panel-ref={tab.ref}
      data-plugin-id={tab.pluginId ?? ''}
    >
      {children}
    </div>
  )

  /* ---- 无 component 声明（不该发生：插槽守卫已在解析期拦下） ---- */
  if (!tab.component) {
    return shell(
      <EmptyState
        icon={<Icon.Warning width={22} height={22} />}
        title={t('panel.badShape')}
        hint={t('panel.noComponent')}
      />,
    )
  }

  /* ---- loading ---- */
  if (state.status === 'loading') {
    return shell(
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-tertiary">
        <Icon.Refresh width={18} height={18} className="animate-spin" />
        <span className="text-xs">{t('panel.loading')}</span>
      </div>,
    )
  }

  /* ---- error ---- */
  if (state.status === 'error' || !state.data) {
    return shell(
      <EmptyState
        icon={<Icon.Warning width={22} height={22} />}
        title={t('panel.loadFailed')}
        hint={state.error ?? t('panel.unknownError')}
      />,
    )
  }

  /* ---- 形状校验（源数据可能在 static 里就写错了） ---- */
  const check = validatePanelData(tab.component, state.data)
  if (!check.ok) {
    return shell(
      <EmptyState
        icon={<Icon.Warning width={22} height={22} />}
        title={t('panel.badShape')}
        hint={check.reason}
      />,
    )
  }

  /* ---- empty ---- */
  if (isPanelDataEmpty(tab.component, state.data)) {
    return shell(
      <EmptyState
        icon={<Icon.Box width={22} height={22} />}
        title={t('panel.empty')}
        hint={t('panel.emptyHint', { component: tab.component })}
      />,
    )
  }

  /* ---- ready ---- */
  const Impl = resolveVLib(tab.component)
  if (!Impl) {
    // resolveVLib 与 validatePanelData 的白名单同源，理论不可达；仍留显式分支
    return shell(
      <EmptyState
        icon={<Icon.Warning width={22} height={22} />}
        title={t('panel.badShape')}
        hint={t('panel.unknownComponent', { component: tab.component })}
      />,
    )
  }

  return shell(
    <>
      {/* 归属条：插件贡献的面板标出插件 id（「从哪来的」必须可查） */}
      {tab.pluginId && (
        <div className="flex items-center gap-1.5 px-2.5 h-6 flex-shrink-0 border-b border-border-subtle text-2xs text-text-faint">
          <Icon.Plug width={11} height={11} aria-hidden="true" />
          <span className="truncate" title={tab.pluginId}>
            {t('panel.fromPlugin', { id: tab.pluginId })}
          </span>
          {state.resolvedPath && (
            <span className="ml-auto truncate max-w-[50%]" title={state.resolvedPath}>
              {state.resolvedPath}
            </span>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {/* interact 一并交给组件：行点击 → 浮窗打开另一批面板（插件声明式，无代码） */}
        <Impl data={state.data} title={bodyTitle} interact={tab.interact} />
      </div>
    </>,
  )
}
