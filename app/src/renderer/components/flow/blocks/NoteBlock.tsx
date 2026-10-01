/* ============================================================
 * ArkWork — NoteBlock（v0.38.0 / D156，第十一个块）
 * 设计文档：docs/versions/v0.38.0/03-interaction.md §三
 *
 * 为什么需要这个块：
 *   现场形态是「模型连续推理 8 轮、界面上一片沉默，然后一次性给最终结果」——
 *   用户无法区分「正在推进」与「已经卡住」。已有的块各有明确分工，没有一个
 *   承载「阶段性结论」：
 *     · reasoning —— 思考过程（默认折叠，是"怎么想"而不是"想到什么"）
 *     · say       —— 过程叙述（来自 step.say，随步骤滚动）
 *     · answer    —— **最终**答复（收尾才出现）
 *   NoteBlock 只承载「结论」：已确认什么、下一步做什么。它是**可见的里程碑**，
 *   不是过程噪音 —— 因此不折叠、不加交互控件、不进入 ProcessFold。
 *
 * 呈现规格（03-interaction §三 3.3 / 3.4）：
 *   · 字号 `text-sm`(13px) —— 小于 answer/say 的 text-base，大于 notice 的 text-xs
 *   · 颜色 `--text-secondary`，左侧 2px `--border-strong`（中性）
 *     —— NoticeBlock 用的是 `--warning`（琥珀），两者一眼可分（V2 原则）
 *   · `select-text`：结论是内容，必须可复制（与全仓可复制纪律一致）
 *   · `via` **不展示为可见文字**，只作 `title` 悬停提示（§3.4：避免噪声）。
 *     这里刻意**不用 i18n**：设计稿把它定为「渲染层常量」，与多数块组件的
 *     本地文案同口径；引入 t() 会要求四语言键集同步（TC-I18N-005），
 *     而这三条文案并不面向本地化需求（它们是元数据，不是界面语汇）。
 *   · `data-via` 属性供契约用例断言来源映射，不影响视觉。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'
import { LinkifiedText } from '../LinkifiedText'

type NoteBlockT = Extract<FlowBlock, { kind: 'note' }>

/** via → 悬停提示（03-interaction §三 3.4 指定文案） */
const VIA_TITLE: Readonly<Record<NoteBlockT['via'], string>> = {
  model: '阶段结论',
  'plan-commit': '计划更新',
  'gate-refusal': '阶段结论（收尾待确认）',
  // v0.38.0（D160）：引擎主动停止（模型未使用工具调用）—— 必须让用户看见原因，
  // 不能只落日志（纪律⑨：静默退化是复合缺陷的粘合剂）。
  'engine-stop': '已停止（引擎说明）',
  // v0.39.0（U2）：规划通道重排 —— 用户必须能看出「清单变了是引擎重新规划的」
  'plan-revision': '重新规划（引擎）',
}

export function NoteBlock({ block }: { block: NoteBlockT }) {
  return (
    <div
      className="flow-note text-sm whitespace-pre-wrap select-text rounded-md pl-2.5 py-1"
      style={{
        color: 'var(--text-secondary)',
        borderLeftWidth: 2,
        borderLeftColor: 'var(--border-strong)',
      }}
      title={VIA_TITLE[block.via]}
      data-via={block.via}
    >
      {/* v0.44.0（R-C）：正文经唯一判据分段链接化（无路径时逐字等同直出） */}
      <LinkifiedText text={block.text} />
    </div>
  )
}
