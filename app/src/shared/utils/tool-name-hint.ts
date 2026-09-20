/* ============================================================
 * ArkWork — 未知工具名的「你是不是想用 X」（v0.34.4 · D67）
 *
 * 病：`act.ts` 对未注册工具只回一句 `Tool not found: todo-write`。
 * 错误回执不含任何恢复信息 → 模型只能再猜一个名字 → 再失败（纪律⑩同族）。
 *
 * 真机证据（t1 · T-20260919-6c3v48 · I25）：
 *   -> CALL todo-write {...}
 *      RESULT {"error":"Tool not found: todo-write"}
 * 而当时**真实注册的工具**是 `todo_update`（seed.ts:653）。两者只差一个词根。
 *
 * 设计口径：
 *  - **纯函数、零依赖**：可在 node:test 里穷尽真值表（TC-THINT 组）。
 *  - 归一化先做「词根化」：`todo-write` / `todo_write` / `todoUpdate` 都拆成
 *    [todo, write] / [todo, update]，只要**首词根相同**就算近似 —— 这比单纯
 *    编辑距离稳（`todowrite` 与 `todoupdate` 的 Levenshtein 距离达 4，
 *    会被距离阈值漏掉，但它们显然是同一个工具族）。
 *  - 排序稳定（同分按名字字典序），保证用例可断言、提示可复现。
 * ============================================================ */

/** 把工具名拆成小写词根：camelCase / snake_case / kebab-case / 空格 一律拆 */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
}

/** 把词根拼回去（用于"完全同名但写法不同"的最高优先判定） */
function normalize(name: string): string {
  return tokenize(name).join('')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * 相似度分值（越小越像）。Infinity = 不像，不入选。
 *
 * | 情形 | 分 |
 * |---|---|
 * | 归一化后完全相同（`todo-update` vs `todo_update`） | 0 |
 * | 首词根相同（`todo-write` vs `todo_update`） | 1 |
 * | 互为子串（`search` vs `web-search`） | 2 |
 * | 编辑距离 ≤ 2 | 3 |
 * | 其它 | ∞ |
 */
function similarity(requested: string, candidate: string): number {
  const rn = normalize(requested)
  const cn = normalize(candidate)
  if (rn === '' || cn === '') return Infinity
  if (rn === cn) return 0
  const rt = tokenize(requested)
  const ct = tokenize(candidate)
  if (rt[0] && ct[0] && rt[0] === ct[0]) return 1
  if (rn.includes(cn) || cn.includes(rn)) return 2
  if (levenshtein(rn, cn) <= 2) return 3
  return Infinity
}

/**
 * 给定模型请求的工具名与当前**真实可用**的工具名列表，返回最像的若干个。
 *
 * @returns 已按相似度排序的候选名（最多 max 个）；无相似项时返回空数组，
 *          调用方据此退化为「不带候选」的报错文案（不得瞎猜）。
 */
export function suggestToolNames(
  requested: string,
  available: readonly string[],
  max = 3,
): string[] {
  const scored = available
    .map((name) => ({ name, score: similarity(requested, name) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
  return scored.slice(0, Math.max(0, max)).map((x) => x.name)
}

/** 拼装给模型看的报错文案（含候选；无候选时保持旧文案，不编造） */
export function unknownToolError(requested: string, available: readonly string[]): string {
  const base = `Tool not found: ${requested}`
  const candidates = suggestToolNames(requested, available)
  if (candidates.length === 0) return base
  return (
    `${base}（该工具不存在）。` +
    `你是不是想用：${candidates.map((c) => `\`${c}\``).join('、')}？` +
    `请改用上述**已注册**工具名重试，不要自造工具名。`
  )
}
