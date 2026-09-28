/* ============================================================
 * ArkWork — 源码守卫的唯一注释剥离器（v0.36.0 · D101）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §8（D101）
 *
 * ★ 为什么必须收敛成一份
 *   契约测试的惯用手法是「读源码 + 正则断言」（本仓没有 jsdom，组件类断言只能如此）。
 *   而**注释里天然会提反面教材** —— 「不要写 console.log」「原 DiagnosticsView 已删除」
 *   「不得再用 Object.keys」…… 不剥注释，守卫就会把注释本身当违规：
 *   断言全对、功能没坏，门禁却红了。这正是纪律⑫（源码守卫断言前必须剥离注释）
 *   的由来。
 *
 *   v0.36.0 普查发现全仓**散落 5 份各自为政的实现**（test-harness / plugin-git-manager /
 *   reason-dual-channel / c1-viewmodes / panel-fetch），其中 panel-fetch 那份是
 *   朴素正则 `.replace(/\/\/.*$/gm, '')` —— 它会把**字符串里的 `//`**（如
 *   `'https://…'`、`'a//b'`）整段删掉，属于「守卫本身在悄悄改变被测对象」。
 *   按纪律⑧（白名单/枚举只许一个事实源），统一到本模块。
 *
 * ★ 契约（与 B7 的 stdout 守卫同口径，已由 TC-HARN-003 自检覆盖）
 *   · 块注释 → 删除内容但**保留换行**（行号可对齐，报错能指到真实行）；
 *   · 行注释 → 删到行尾，保留 `\n`；
 *   · 字符串/模板字面量 → **原样保留**（守卫常要断言字符串字面量，如 i18n 键）；
 *   · 转义 → 原样透传（`\\'` 不会误判为串尾）。
 *
 * ⚠️ 已知边界（诚实备案，不假装完备）
 *   本剥离器**不解析正则字面量**。若被扫源码里出现 `/['"]/` 这类「正则内含引号」的
 *   写法，引号会被误当成字符串起点，导致其后的注释剥离偏移。当前被扫文件均无此形态；
 *   真出现时的失败形态是**假阳性**（守卫报红），不会静默放行 —— 可接受。
 * ============================================================ */

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'tpl'

/**
 * 剥离注释（块注释保留换行以维持行号），字符串/模板字面量**原样保留**。
 *
 * 纯函数、零依赖 —— 因此在 node 与 renderer 两侧 tsconfig 下都能编译，
 * 且不会把 `node:fs` 之类的耦合带进 shared 层（读盘由调用方负责）。
 */
export function stripComments(src: string): string {
  let mode: Mode = 'code'
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line'
        i += 2
        continue
      }
      if (c === '/' && n === '*') {
        mode = 'block'
        i += 2
        continue
      }
      if (c === "'") mode = 'single'
      else if (c === '"') mode = 'double'
      else if (c === '`') mode = 'tpl'
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code'
        i += 2
        continue
      }
      if (c === '\n') out += c // 保行号
      i += 1
      continue
    }
    // 字符串内部：原样保留，处理转义，遇到配对引号回到 code
    if (c === '\\') {
      out += c + (n ?? '')
      i += 2
      continue
    }
    out += c
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'tpl' && c === '`')
    ) {
      mode = 'code'
    }
    i += 1
  }
  return out
}

/**
 * 报告违规时用：把剥离后的偏移映射回**原始行号**。
 * 剥离器保留换行，因此两侧的 `\n` 计数一致（这也是「块注释保换行」的用途）。
 */
export function lineOf(src: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1
  }
  return line
}
