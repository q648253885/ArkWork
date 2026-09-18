/* ============================================================
 * ArkWork — 导入工作台对话框（v0.33.0 · 配置中心）
 * 设计文档：docs/versions/v0.33.0/02-prd.md §3.1 / 03-interaction.md §「导入」
 *
 * 两条入口（都必须先**干跑校验**再落地）：
 *  · 选文件 → `profile:pick-file`（原生选择器，只认 `*.json`）
 *             → `profile:validate` 干跑 → 预览报告 → 确认
 *  · 粘贴   → 同一段干跑链路
 *
 * 纪律：**干跑与落地共用同一条校验管道**（主进程侧 `runImport`），
 * 因此不会出现「预览说能过、导入却失败」。确认时也把 issues 回填，
 * 让 warning 级问题在导入后依然可见（不是导入成功就丢掉）。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { Tooltip } from '../ui'
import { ark } from '../../ipc/client'
import type { ValidationIssue } from '@shared/types/profile'
import { ValidationIssuesView } from './ActivationReportView'

type Stage = 'input' | 'preview'

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> | void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [filePath, setFilePath] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('input')
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [ok, setOk] = useState(false)
  const [report, setReport] = useState<{ profileId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activate, setActivate] = useState(true)

  /** 先干跑校验（两条入口共用） */
  const dryRun = async (raw: unknown) => {
    setBusy(true)
    setError(null)
    try {
      const res = await ark.profile.validate({ raw })
      setIssues(res.issues)
      setOk(res.ok)
      setReport({ profileId: res.profileId })
      setStage('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pickFile = async () => {
    setError(null)
    try {
      const res = await ark.profile.pickFile()
      if (!res.path) return
      setFilePath(res.path)
      setText('')
      if (res.error || res.raw === undefined) {
        setError(res.error ?? t('workbench.import.readFailed'))
        return
      }
      // 真干跑：main 已把 JSON 解析回传，这里走与粘贴完全相同的 validate 链路
      await dryRun(res.raw)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = filePath
        ? await ark.profile.importFile({ path: filePath, activate })
        : await ark.profile.import({ raw: JSON.parse(text), activate })
      setIssues(res.issues)
      if (!res.ok) {
        setOk(false)
        return
      }
      await onImported()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const canDryRun = text.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label={t('workbench.import.title')}>
      <div className="absolute inset-0 bg-bg-overlay" onClick={onClose} />
      <div className="relative w-[560px] max-h-[80vh] rounded-xl border border-border-default bg-bg-base shadow-lg flex flex-col">
        <header className="flex items-center gap-2 h-12 px-4 border-b border-border-subtle flex-shrink-0">
          <Icon.Upload width={15} height={15} className="text-accent flex-shrink-0" aria-hidden />
          <h2 className="text-xs font-medium text-text-primary flex-1">{t('workbench.import.title')}</h2>
          <Tooltip label={t('workbench.editor.close')}>
            <button onClick={onClose} aria-label={t('workbench.editor.close')} className="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-ring">
              <Icon.X width={15} height={15} />
            </button>
          </Tooltip>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {stage === 'input' && (
            <>
              <button
                type="button"
                onClick={() => void pickFile()}
                disabled={busy}
                className="w-full flex items-center gap-2 rounded-lg border border-dashed border-border-default px-3 py-3 text-xs text-text-secondary hover:bg-bg-hover hover:border-accent disabled:opacity-50 focus-ring"
              >
                <Icon.FolderOpen width={16} height={16} className="text-text-tertiary" aria-hidden />
                <span className="flex-1 text-left">{t('workbench.import.pickFile')}</span>
                <span className="text-2xs text-text-faint">{t('workbench.import.onlyJson')}</span>
              </button>
              {filePath && <div className="text-2xs text-text-faint font-mono break-all">{filePath}</div>}

              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border-subtle" />
                <span className="text-2xs text-text-faint">{t('workbench.import.or')}</span>
                <div className="h-px flex-1 bg-border-subtle" />
              </div>

              <div>
                <label className="block text-2xs text-text-tertiary mb-1" htmlFor="wb-paste">{t('workbench.import.paste')}</label>
                <textarea
                  id="wb-paste"
                  rows={10}
                  spellCheck={false}
                  className="w-full rounded-md bg-bg-input border border-border-subtle p-2.5 font-mono text-2xs text-text-primary outline-none focus-ring resize-y"
                  placeholder={'{\n  "schemaVersion": "1.0",\n  "id": "wb.mine",\n  ...\n}'}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
                {t('workbench.import.activateAfter')}
              </label>
            </>
          )}

          {stage === 'preview' && (
            <>
              <div className="flex items-center gap-2 text-xs">
                {ok ? (
                  <Icon.Check width={14} height={14} className="text-success" aria-hidden />
                ) : (
                  <Icon.Warning width={14} height={14} className="text-danger" aria-hidden />
                )}
                <span className="text-text-primary font-medium">
                  {ok ? t('workbench.import.previewOk') : t('workbench.import.previewBad')}
                </span>
                {report && <span className="text-2xs text-text-faint font-mono">{report.profileId}</span>}
              </div>
              <ValidationIssuesView issues={issues} />
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
                {t('workbench.import.activateAfter')}
              </label>
            </>
          )}

          {error && (
            <div className="rounded-md border border-danger bg-danger-soft px-2.5 py-1.5 text-xs text-danger break-words">{error}</div>
          )}
        </div>

        <footer className="flex items-center gap-2 h-14 px-4 border-t border-border-subtle flex-shrink-0">
          <button type="button" onClick={onClose} className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover focus-ring">
            {t('workbench.import.cancel')}
          </button>
          <div className="flex-1" />
          {stage === 'input' ? (
            <button
              type="button"
              disabled={!canDryRun || busy}
              onClick={() => {
                try {
                  void dryRun(JSON.parse(text))
                } catch (err) {
                  setError(t('workbench.import.jsonParseFailed', { detail: err instanceof Error ? err.message : String(err) }))
                }
              }}
              className="h-8 px-3 rounded-md bg-business-primary text-text-inverse text-xs hover:bg-business-primary-hover disabled:opacity-50 focus-ring"
            >
              {t('workbench.import.dryRun')}
            </button>
          ) : (
            <>
              <button type="button" onClick={() => setStage('input')} className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover focus-ring">
                {t('workbench.import.back')}
              </button>
              <button
                type="button"
                disabled={busy || !ok}
                onClick={() => void confirm()}
                className="h-8 px-3 rounded-md bg-business-primary text-text-inverse text-xs hover:bg-business-primary-hover disabled:opacity-50 focus-ring"
              >
                {t('workbench.import.confirm')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
