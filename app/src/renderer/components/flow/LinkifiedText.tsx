/* ============================================================
 * ArkWork — LinkifiedText（v0.44.0 · R-C）
 * 纯文本段落里的「工作区路径」链接化：经唯一判据纯函数
 * `linkifyWorkspacePaths`（v0.42.0，真值表用例 TC-PLINK 钉死正/负例）
 * 切分为 text / path 段 —— text 段原样输出（拼接与输入逐字一致），
 * path 段渲染为 FileLink（点击经 useOpenPath → openDoc 既有门面）。
 *
 * 消费面（W8）：NoteBlock（阶段结论）/ SayBlock（过程叙述）——
 * 两处都是纯文本直出（无 markdown 解析），分段渲染零干扰。
 * AnswerBlock（Markdown 分层）刻意不消费 —— 见 v0.44.0 goal §Scope Out。
 *
 * 无损契约：容器类名由调用方透传（select-text / whitespace-pre-wrap
 * 语义留在调用侧）；无路径文本的渲染与直出逐字一致（TC-ART-011）。
 * ============================================================ */
import { linkifyWorkspacePaths } from '../../utils/path-links'
import { FileLink } from './FileLink'

export function LinkifiedText({ text, className = '' }: { text: string; className?: string }) {
  const segments = linkifyWorkspacePaths(text)
  if (segments.length === 0) return <span className={className}>{text}</span>
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.kind === 'path' ? (
          <FileLink key={`${seg.value}:${i}`} path={seg.value} line={seg.line} />
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </span>
  )
}
