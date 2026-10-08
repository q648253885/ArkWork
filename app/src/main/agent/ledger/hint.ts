/* ============================================================
 * ArkWork — 模型可见的「清单控制面」文案（唯一事实源 · v0.39.0 D186）
 *
 * 为什么要有这个文件：
 *   v0.38.0（D154）把清单控制面收敛成 `task_plan` 单入口、下架了 9 个旧工具，
 *   但**引导文案没有跟着收**：引擎各处 hint 仍在教模型用 `task_update` / `task_list` /
 *   `replan` / `task_block` / `todo_update` —— 模型照做必然拿到「工具不存在」，
 *   于是重试、换名、空转。文案与工具表不一致，是比缺功能更难查的一类缺陷：
 *   代码全对，只是**告诉模型一件做不到的事**。
 *
 * 纪律⑧（白名单/枚举只许一个事实源）在**文本**上的等价物：任何面向模型的
 * 「你该用哪个工具改清单」都必须引这里的常量，不得就地拼字符串。
 * 回归防线：TC-CLEAN-001（全仓扫描，剥离注释后模型可见文案不得含已下架工具名）。
 * ============================================================ */

/** 清单的唯一读写入口名（与控制面收敛后的工具表一致） */
export const PLAN_TOOL_NAME = 'task_plan'

export const PLAN_TOOL_HINT = {
  /** 改清单：提交完整清单，由引擎 diff */
  update: `用 ${PLAN_TOOL_NAME} 提交更新后的**完整清单**（引擎自动比对差异，已完成项不会被回退）`,
  /** 看图：清单快照每轮自动注入，不需要"读" */
  read: `清单快照每轮自动注入；需要确认时用 ${PLAN_TOOL_NAME} 提交与现在相同的清单即可`,
  /** 受阻：状态 + 原因都写在清单里 */
  blocked: `把该项的 status 置为 'blocked'，并在 note 里写明具体问题`,
  /** 陈旧 / 冲突：重新提交完整清单 */
  stale: `请用 ${PLAN_TOOL_NAME} 重新提交完整清单，引擎会按差异重建`,
  /** 顺序 / 依赖：用清单顺序表达，图侧 dependsOn 不接受模型直写 */
  order: `把先后顺序体现在 ${PLAN_TOOL_NAME} 的清单顺序里（按执行顺序排列）`,
  /** 收尾 */
  finish: `全部完成后调用 task_complete 收尾`,
  /**
   * 终局引导（v0.42.1 · D212）。
   *
   * 真机根因（qwen3.8 27b，用户澄清「是因为一直无法结束，才导致到达上限的」）：
   * 弱模型干完活后反复用 task_plan 提交同一份清单当「确认完成」——引擎对零变化
   * 提交只回「清单已检视，无需变化」，同参数预算 5/5 拦截也只说「请改用替代方法」，
   * **两处都没有告诉模型「接下来该结束任务」**。完成门禁只在模型尝试收尾时运行，
   * 模型一直调工具就永远不触发 → 死循环到 stall。
   *
   * 本常量是终局指引的**唯一文案源**，两处消费：① task_plan 成功 observation
   * （act.ts，清单收口/零变化时）；② 同参数/类别预算拦截回执（loop.ts，仅清单族）。
   * 指引指向的是**换层次**的动作（task_complete / 最终答复），不是被拦的那条调用
   * —— 符合纪律⑩。
   */
  endgame:
    '若你判断任务已完成：请调用 task_complete 工具结束任务，或本轮不再调用任何工具、直接输出最终答复 —— 不要重复提交相同的清单',
} as const

/**
 * 形状非法回执的出路后缀（v0.48.0 · D223，真值表用例见 TC-PEM 组）。
 *
 * 真机根因（公司部署 qwen3.8 27b）：模型提交 task_plan({items: []}) 后，引擎回执
 * 只有「items 必须是非空数组。请重新提交完整清单」——三重缺陷：
 *   ① 没说 task_plan 是可选快路径（D202 已降级为可选）；
 *   ② 没附当前清单快照（模型不知道「完整清单」该长什么样）；
 *   ③「请重新提交」恰好驱动**原样重试**（v0.39.0 W2：失败后最忌原样重试）——
 *     同参数签名预算 5/5 耗尽后，模型在「被拦的 task_plan」与「被拦的
 *     task_complete」之间空转，任务无法完成。
 *
 * 分场（与 endgameSuffixOf 同款真值表纪律）：
 *  - 无清单（itemCount <= 0）→ 「可直接开始干活，引擎会自动建清单」——把模型从
 *    重试循环里放出来，清单交给 PlanOps create 兜底；
 *  - 有清单 → 快照 + 「清空不被允许；完成请调 task_complete；修正请交完整清单」。
 *
 * @param itemCount 当前账本项数（act.ts 形状非法分支经 loadLedger 求得）
 * @param snapshot  当前清单快照文本（act.ts 用与成功路径同源的 renderOverview 渲染）
 */
export function invalidShapeSuffixOf(itemCount: number, snapshot: string): string {
  if (itemCount <= 0) {
    return `当前清单为空。请提交包含具体步骤的完整清单（items 非空）；也可以直接开始执行任务 —— 引擎会自动建立并维护清单，${PLAN_TOOL_NAME} 是可选的快路径。`
  }
  const snap = snapshot.trim()
  return `清空清单是不被允许的操作。若任务已完成，请调用 task_complete 结束任务；若需修正清单，请重新提交修正后的完整清单（已完成项不会被回退）。当前清单（${itemCount} 项）：${snap ? `\n${snap}` : '（空）'}`
}

/**
 * 终局后缀纯函数（v0.42.1 · D212，真值表用例 TC-ENDG-001）。
 *
 * @param openCount 在途项数（`openItems(ledger).length`）
 * @param total 清单总项数（0 = 无清单，不引导）
 * @returns 拼进 task_plan observation 的终局句；无清单时返回 ''
 *
 * 两种分场（防误导提前收尾）：
 *  - 全部终态 → 「清单已全部收口 + endgame 指引」（该收尾了）
 *  - 有在途项 → 「无需变化，继续推进在途项」（**不得**此时引导收尾）
 */
export function endgameSuffixOf(openCount: number, total: number): string {
  if (total <= 0) return ''
  if (openCount === 0) {
    return `清单已全部收口（${total} 项全部完成）。${PLAN_TOOL_HINT.endgame}。`
  }
  return `清单无需变化，仍有 ${openCount} 项在途 —— 请继续推进在途项；全部完成后调用 task_complete 收尾。`
}
