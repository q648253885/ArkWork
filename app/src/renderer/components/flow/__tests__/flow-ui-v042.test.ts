/* ============================================================
 * ArkWork — v0.42.0 交互区 UI 契约（TC-UI42）
 * 载体：源码契约（readFileSync + stripComments，不 import 渲染层模块）。
 *
 * 背景（用户反馈「交互区蓝色背景有点奇怪，对标 ZCode」）：
 *   v0.41.0 D210 给最终答复加了 bg-accent-soft 浅蓝铺底；v0.42.0 降调为
 *   仅左 2px 主色边线（线 ≠ 面）。本组把守：
 *   001 AnswerBlock 无蓝底铺底，左边线保留（两条腿，反向核验见文件尾注）
 *   002 FileLink chip 化不破坏既有契约（openDoc 唯一门面 / 全路径 / button 语义）
 *   003 PlanBlock 卡片化不回退层级缩进与复合编号（v0.41.0 D209 契约继承）
 *   004 TaskAnchor 标签 chip 化 + live 呼吸点
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs flow-ui-v042
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const ANSWER = stripComments(read('../blocks/AnswerBlock.tsx'))
const FILE_LINK = stripComments(read('../FileLink.tsx'))
const PLAN_BLOCK = stripComments(read('../blocks/PlanBlock.tsx'))
const TASK_ANCHOR = stripComments(read('../TaskAnchor.tsx'))
const TOOL_BLOCK = stripComments(read('../blocks/ToolBlock.tsx'))
const TURN_VIEW = stripComments(read('../TurnView.tsx'))

describe('flow-ui-v042 · TC-UI42', () => {
  it('TC-UI42-001 最终答复去蓝底：AnswerBlock 不含 bg-accent-soft，左主色边线保留（两条腿）', () => {
    // 否定腿：浅蓝铺底不得回归（v0.41.0 D210 的 shell 写法）
    assert.doesNotMatch(ANSWER, /bg-accent-soft/, '最终答复不得再有浅蓝铺底（用户反馈 + 配色纪律：浅色铺底不进交互区正文）')
    // 肯定腿：强调信号仍在 —— 左 2px 主色边线
    assert.match(ANSWER, /border-l-2/, '最终答复必须保留左侧强调边线（「最终答复 = 长轮次唯一强终点」不推翻）')
    assert.match(ANSWER, /border-l-accent/, '左边线用主色（accent）')
  })

  it('TC-UI42-002 FileLink chip 化：openDoc 唯一门面 / 全路径渲染 / button 语义 / 中性底 chip 形态', () => {
    // 既有契约逐项保留（D112：路径唯一展示位；C-20：HoverCard；键盘可达）
    assert.match(FILE_LINK, /useOpenPath/, '点击必须走 useOpenPath（openDoc 唯一门面）')
    assert.match(FILE_LINK, /<button/, '语义必须是 button（键盘可达）')
    assert.match(FILE_LINK, /HoverCard/, '悬停提示走 HoverCard（C-20 禁原生 title）')
    assert.match(FILE_LINK, /\{path\}/, '展示即全路径（不得 basename 化）')
    // v0.42.0 chip 形态：文件图标 + 中性圆角底
    assert.match(FILE_LINK, /bg-fill-secondary/, 'chip 必须有中性底（bg-fill-secondary）')
    assert.match(FILE_LINK, /<svg/, 'chip 必须带文件图标（WorkBuddy 卡片处理）')
    // 反向约束：不得出现工程视角直出的 basename 化（防 D112 路径唯一展示位被拆）
    assert.doesNotMatch(FILE_LINK, /baseNameOf/, 'FileLink 不得引入 basename 化（全路径契约）')
  })

  it('TC-UI42-003 PlanBlock 卡片化：中性底 + 迷你进度条；层级缩进与复合编号不回退（D209 继承）', () => {
    assert.match(PLAN_BLOCK, /bg-bg-surface/, '计划卡必须有中性底（WorkBuddy 卡片处理）')
    assert.match(PLAN_BLOCK, /bg-success/, 'header 必须有迷你进度条（成功色）')
    // v0.41.0 D209 契约继承：子任务缩进与复合编号的唯一实现仍在
    assert.match(PLAN_BLOCK, /planItemNumbering/, '复合编号必须仍从纯函数层引入（D209）')
    assert.match(PLAN_BLOCK, /16 \* depth/, '子任务缩进 16px×depth 不回退（D209）')
    assert.match(PLAN_BLOCK, /plan-step-/, '锚点 id 保留（react:scroll-to-plan-step 滚动契约）')
  })

  it('TC-UI42-004 TaskAnchor：标签 chip 化，「正在做」行带呼吸点（live 信号）', () => {
    assert.match(TASK_ANCHOR, /bg-fill-secondary/, '普通标签必须是中性 chip')
    assert.match(TASK_ANCHOR, /bg-accent-soft/, 'live 标签用主色 chip（强调「正在做」，面积仅一枚小徽标）')
    assert.match(TASK_ANCHOR, /breathe/, 'live 行必须有呼吸点（纯透明度动画，perf-lite 双降级）')
    // 既有契约：三行全空不渲染空卡
    assert.match(TASK_ANCHOR, /if \(!goal && !doing && !intent\) return null/, '空卡不渲染契约不回退')
  })

  it('TC-UI42-005 ★ P5 ToolBlock 去卡片化：无边框无底的 ZCode 行式，状态点保留（C-16 双编码）', () => {
    // 否定腿：卡片形状编码退役（ZCode 过程行无边框无底色，靠行式布局融入背景）
    assert.doesNotMatch(TOOL_BLOCK, /border-border-default/, '工具行不得再有卡片边框（P5 去卡片化）')
    assert.doesNotMatch(TOOL_BLOCK, /borderLeftWidth/, '左侧 2px 状态条随卡片退役（ZCode 无竖条）')
    assert.doesNotMatch(TOOL_BLOCK, /railColor/, '状态条取色函数必须一并删除（死代码，D196）')
    // 肯定腿：三态可区分性不降级 —— 状态点仍在（running/failed/guarded 语义色）
    assert.match(TOOL_BLOCK, /dotColor/, '状态点取色函数保留（C-16 三态可区分）')
    assert.match(TOOL_BLOCK, /hover:bg-bg-hover/, '行式呈现：hover 才浮出轻底（过程行融入背景）')
    assert.match(TOOL_BLOCK, /animate-pulse/, '运行中状态点呼吸保留')
  })

  it('TC-UI42-006 ★ P5 StateRail 退役：文件删除 + TurnView 零引用（反向核验见文件尾注）', () => {
    let exists = true
    try {
      read('../StateRail.tsx')
    } catch {
      exists = false
    }
    assert.equal(exists, false, 'StateRail.tsx 必须已删除（过程组无左侧轨道装饰）')
    assert.doesNotMatch(TURN_VIEW, /StateRail/, 'TurnView 不得再引用 StateRail')
    // 过程组仍由 ProcessFold 承载（折叠条本身已是 ZCode 行式）
    assert.match(TURN_VIEW, /<ProcessFold key=\{seg\.key\} run=\{seg\.run\} \/>/, '过程组平铺渲染（无包裹层）')
  })

  it('TC-UI42-007 ★ P5 TaskAnchor 胶囊化：一行式胶囊 + 「正在做」优先（ZCode 顶部胶囊形态）', () => {
    assert.match(TASK_ANCHOR, /rounded-full bg-fill-secondary/, '锚点必须是胶囊形态（圆角满 + 中性底）')
    assert.match(TASK_ANCHOR, /\(isRunning && doing\) \|\| task\?\.title/, '胶囊文本优先「正在做」，回落任务标题')
    // 展开后三行 LLM 产物仍在（D121 信息零丢失）；胶囊行可折叠
    assert.match(TASK_ANCHOR, /aria-expanded/, '胶囊可折叠（aria 语义）')
    assert.match(TASK_ANCHOR, /rows\.map/, '展开体三行渲染保留')
    // D121 既有契约：真数据来源不回退（TC-D121-006 同源）
    assert.match(TASK_ANCHOR, /pickFocusNode\(/, '焦点节点经纯函数挑选')
    assert.match(TASK_ANCHOR, /userIntentText\(/, '用户意图取首条消息')
  })
})

/* 反向核验记录（纪律㉚）：TC-UI42-001 开发期做过注入核验 —— 在 AnswerBlock 的
 * shell 里临时加回 bg-accent-soft → 用例报红；移除后复绿。其余三条为「必须有 X」
 * 的肯定断言，反向形态 = 删除对应实现即红（结构自明）。 */
