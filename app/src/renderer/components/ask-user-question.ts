/* ============================================================
 * ArkWork — 「暂停待答」提问的**唯一事实源**（v0.39.0 · D198）
 *
 * 为什么单独抽出这个纯函数：
 *   引擎侧有 **9 处**暂停点会把提问写进 `Task.pendingAskUser`（D52 停滞 / D160
 *   伪工具调用 / D168 无工具答复停滞 / D65 预算耗尽 / D197 空响应用尽 / 计划
 *   闸门 …），并且既有守卫 `loop-stall-guard.test.ts` 早就断言「必须写
 *   pendingAskUser，**否则重开任务时问题丢失**」——即持久化的**目的**就是给
 *   「事后重开」看的。
 *
 *   但渲染层此前只认**活体** `ask_user` 事件（`store.askUserQuestion`，初值
 *   null，切任务时被显式清空），**没有任何一处读 `pendingAskUser`**（D198）。
 *   后果：当场看着它暂停能看到完整提问；**刷新 / 重开 / 切走再回来**就只剩
 *   一句无因由的「已暂停 · 等待你的指令…」，五处暂停点精心写的人话全部丢失。
 *
 *   判定必须是纯函数，才可能用真值表钉死（纪律⑫：载体纪律 —— 真执行 > grep）。
 * ============================================================ */

/** 任务上持久化的待答信息（与 `@shared/types/task` 的字段同形，此处只取需要的一格） */
export interface PendingAskUserLike {
  question?: string
}

/** 判定所需的任务最小形状（避免把整个 Task 拖进纯函数） */
export interface PausableTaskLike {
  status?: string
  pendingAskUser?: PendingAskUserLike | null
}

/* @@ARKWORK-PURE:START@@ */
/**
 * 解析「此刻该展示给用户的提问」。
 *
 * 优先级（先命中先返回）：
 *   1. **活体** `ask_user` 事件 —— 本轮正在发生的提问，最权威；
 *   2. **持久化** `task.pendingAskUser.question` —— 重开 / 刷新 / 切换任务后
 *      仍应看得见的理由（D198 补齐的正是这一格）；
 *   3. 两者皆空 → `null`。调用方据此落回普通暂停态（手动暂停**没有**提问，
 *      不应被误升格为「待答门禁」）。
 *
 * 非字符串（数字 / 对象 / null）一律视为「没有提问」，防止把 `42` 当提问渲染。
 */
export function resolveAskUserQuestion(
  liveQuestion: string | null | undefined,
  task: PausableTaskLike | null | undefined,
): string | null {
  const live = typeof liveQuestion === 'string' ? liveQuestion.trim() : ''
  if (live) return live
  const raw = task?.pendingAskUser?.question
  const persisted = typeof raw === 'string' ? raw.trim() : ''
  return persisted || null
}
/* @@ARKWORK-PURE:END@@ */
