/**
 * 计划项噪声过滤（v0.19.1）。
 *
 * 计划项（PlanItem.text）必须描述「做什么」——一个可执行的动作句，而不是：
 *   1. LLM 复述的历史清单状态自报（todo_update 结果 / plan_status 投影）；
 *   2. 被截断或顿号/逗号/冒号结尾的残句；
 *   3. 无动作动词的纯名词碎片（如「等待」「碰撞模型基础参数」）。
 *
 * 这些噪声项一旦进入 planItems，会让清单与真实执行严重脱节（v0.19.0 用户反馈）。
 * 与 `isPhaseHeader`（阶段标题型总结条目）互补：本函数过滤「根本不是动作句」的碎片，
 * 阶段标题的识别在 engine.ts 单独处理。
 */

/** 中文动作动词（文档驱动开发 / 通用任务常见动作） */
const CN_ACTION_VERBS =
  '调研|搜索|查询|撰写|编写|写|实现|开发|编码|测试|部署|打包|封装|接入|初始化|创建|搭建|执行|产出|读取|列出|修复|补|跑|运行|完成|确认|导出|下载|配置|设计|生成|绘制|建立|验证|检查|安装|编译|对比|评估|梳理|拆分|整理|分析|调优|重构|迁移|审查|优化|集成|更新|同步|清理|归档|发布|交付|评审|定位|输出|联调|排查|修改'

/** 英文动作动词（避免英文任务计划被「无动作动词」误判为噪声而整体丢弃） */
const EN_ACTION_VERBS =
  'implement|develop|create|build|test|fix|write|add|refactor|design|setup|initialize|initialise|run|deploy|install|configure|update|remove|rename|migrate|analyze|analyse|review|optimize|optimise|integrate|generate|export|download|validate|verify|check|search|research|explore|read|list|complete|finish|deliver|publish|release|document|debug|compile|compare|evaluate|assess|extract|split|organize|organise|sync|clean|archive|wrap|establish|draw|produce|execute|track|inspect|author|package'

/** 计划项动作动词（中英合并，忽略大小写） */
export const PLAN_ITEM_ACTION_VERBS = new RegExp(
  `${CN_ACTION_VERBS}|\\b(?:${EN_ACTION_VERBS})\\b`,
  'i',
)

/** 清单状态自报 / 历史清单投影关键词（含 [x][~][!][-][·] 状态标记） */
const PLAN_STATUS_ECHO = /已更新清单|当前清单|总项数|当前运行|触发点|\[x\]|\[~\]|\[!\]|\[-\]|\[·\]/

/** 以顿号/逗号/冒号结尾的残句（LLM 把一项拆成两半的典型特征） */
const TRAILING_PUNCTUATION = /[、，,：:]\s*$/

/**
 * 判断一条计划项是否为噪声。返回 true 表示应丢弃：
 *   1) 空 / 纯空白；
 *   2) 清单状态自报 / 历史清单投影；
 *   3) 以顿号/逗号/冒号结尾的残句；
 *   4) 无动作动词的碎片。
 */
export function isNoisePlanItem(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (PLAN_STATUS_ECHO.test(t)) return true
  if (TRAILING_PUNCTUATION.test(t)) return true
  if (!PLAN_ITEM_ACTION_VERBS.test(t)) return true
  return false
}
