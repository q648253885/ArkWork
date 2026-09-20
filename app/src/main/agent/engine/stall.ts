/* ============================================================
 * ArkWork — 「零产出轮」判定（v0.34.0 · D52）
 *
 * 背景（Windows 实测）：小参数模型（qwen3.5:0.8b）在任务「看一下这个工作区
 * 的内容」上进入死循环 —— 每轮都成功调用一次只读工具（file-reader，2ms），
 * 日志 30s/轮、内容全空、清单纹丝不动，一直跑到 maxIterations=200（≈100 分钟）。
 *
 * 既有保护为何全部失效：
 *  - `MAX_CONSECUTIVE_NO_TOOL`：要求「无工具调用」→ 每轮都调了工具，永不触发；
 *  - `MAX_PER_SIGNATURE`：要求同参数字面重复 → 小模型每轮参数微变；
 *  - 只读停滞提示（连续 3 轮只读）：只注入提示并清零计数，**没有终局**；
 *  - `MAX_ITERATIONS=200`：唯一兜底，但代价是 100 分钟。
 *
 * 因此新增一个**正交维度**：不管调没调工具，只看这一轮
 * 「有没有产生实质进展」。连续零产出达到阈值即优雅暂停 + ask_user，
 * 把「模型能力不足」这类事实如实交给用户判断，而不是静默烧 100 分钟。
 *
 * 纯函数、零依赖：真值表可穷尽单测（TC-STALL 组）。
 * ============================================================ */

/** 连续零产出轮阈值（Q1 采用值：6 轮） */
export const MAX_STALLED_ROUNDS = 6

export interface StallRoundInput {
  /** 本轮是否调用了工具（collectActionsForIteration().length > 0） */
  hasToolCall: boolean
  /** 本轮调用的工具是否**全部**属于只读类（file-reader / *-search / fetch-url …） */
  allReadonly: boolean
  /** 本轮是否有面向用户的输出（SAY 叙述非空） */
  hasSayOutput: boolean
  /**
   * 本轮是否有**新增**叙述（say/thought/reasoning 任一通道非空且与上一轮不同）。
   * v0.34.x 补口（qwen3.5:9b @ Ollama 真机两次实测误杀）：「分析工作区」类任务的
   * 只读探索**就是任务本体** —— 小模型不遵守 SAY 协议（say 恒空）、也不主动
   * 收口清单（T-01 恒 in_progress），且探索阶段叙述可能**全走 reasoning 通道**
   * （content 恒空，每轮 100 tokens 思考 + 读新文件）。叙述每轮翻新 = 有信息
   * 增益，不算零产出；反之全空或与上一轮**一字不差**的复读（qwen3.5:0.8b
   * 空转、问候循环）仍判零产出。
   */
  hasNewThought: boolean
  /** 本轮清单/图节点是否发生状态推进（任一节点 status 变化） */
  planProgressed: boolean
  /**
   * **本轮请求的工具是否全部被预算守卫拦截**（D64，v0.34.4）。
   *
   * 为什么必须单列：`hasNewThought` 的豁免（见上）在小模型空转时会**反噬** ——
   * 模型每轮都在写"换个办法"的新思考，于是 51 轮**没有一轮**被判零产出，
   * 6 轮终局守卫一次都没到。真机记录：t1 · T-20260919-6c3v48，51 轮 / 86 次调用 /
   * 15 次「同参数调用已达上限（5/5）」/ 4 次上下文压缩 / **零产物** /
   * 终局 task_failed。
   *
   * 判定依据是语义而非情绪：**被守卫拦截 = 这一轮拿不到任何新信息**。
   * 有新思考也只是空想（模型在思考"怎么绕过拦截"），定义上就是零产出。
   * 因此本项为真时**无条件**判零产出，不受 `hasNewThought` / `hasSayOutput` 豁免。
   *
   * 缺省 false：无工具调用的分支（loop.ts 无工具路径）本就没有"被拦截"可言。
   */
  allGuardBlocked?: boolean
}

/**
 * 判定「零产出轮」。
 *
 * 语义：**没有实质进展** = 没有写类/产成性动作、清单没动、
 * 也没有任何叙述（SAY 或新增思考）。
 *
 * | hasToolCall | allReadonly | planProgressed | hasSayOutput | hasNewThought | 判定 |
 * |---|---|---|---|---|---|
 * | false | — | false | false | false | 零产出（哑回合） |
 * | false | — | false | true  | —     | 有产出（正常叙述回合） |
 * | false | — | false | false | true  | 有产出（有新思考的探索，v0.34.x） |
 * | false | — | true  | —     | —     | 有产出（收口推进） |
 * | true  | true  | false | false | false | 零产出（空转只读 / thought 复读） |
 * | true  | true  | true  | —     | —     | 有产出（读后推进） |
 * | true  | true  | false | true  | —     | 有产出（读完有结论） |
 * | true  | true  | false | false | true  | 有产出（探索中每轮有新发现，v0.34.x） |
 * | true  | false | —     | —     | —     | 有产出（含写类/产成性动作） |
 *
 * v0.34.4（D64）追加一条**最高优先**规则：`allGuardBlocked === true` → 零产出
 * （与上表其余各列无关，只看这一件事）。
 */
export function isStalledRound(input: StallRoundInput): boolean {
  // D64：被守卫拦截的轮次无论叙述多新鲜都是零产出（拦截 = 零新信息），
  // 因此必须排在 hasNewThought 豁免之前。
  if (input.allGuardBlocked) return true
  if (input.hasToolCall && !input.allReadonly) return false
  if (input.planProgressed) return false
  if (input.hasSayOutput) return false
  if (input.hasNewThought) return false
  return true
}

/** 计划签名：节点 status 序列（供 loop 对比「本轮清单是否推进」） */
export function planSignature(items: Array<{ status: string }> | undefined): string {
  if (!items || items.length === 0) return ''
  return items.map((p) => p.status).join('|')
}

/* ------------------------------------------------------------
 * 计数器（设计 §2.2：「stalled → +=1，否则 = 0」）
 *
 * 为什么抽成纯函数而不是留在 loop.ts 内联：
 * 只测 `isStalledRound` 而把「怎么用这个判定」留在 loop 里，等于允许
 * 「判定全对、接线接错」照样全绿 —— v0.32.1 D38-a 的教训正是这个
 * （`turn-end.finishViaTaskComplete` 函数本身全对，错的是调用点）。
 * 抽出来之后，计数器语义与终局阈值都由**真实生产代码**把守。
 * ------------------------------------------------------------ */

/**
 * 推进连续零产出计数：本轮零产出 → +1；本轮有产出 → 归零。
 * 归零是必须的：模型偶发的一次实质进展就应当「原谅」此前所有空转。
 */
export function advanceStallCounter(prev: number, stalledRound: boolean): number {
  const base = Number.isFinite(prev) && prev > 0 ? Math.floor(prev) : 0
  return stalledRound ? base + 1 : 0
}

/** 是否达到终局阈值（与 loop 的「暂停 + ask_user」判定同源） */
export function isStallTerminal(counter: number, max: number = MAX_STALLED_ROUNDS): boolean {
  return counter >= max
}
