/* ============================================================
 * ArkWork — 测试进程收尾清扫（CJS 版，v0.38.1 · D164）
 *
 * 为什么存在两份（.mjs / .cjs）：node < 20.6 不允许 `--import` 进
 * NODE_OPTIONS（实测 v18.11.0 报 "--import is not allowed in NODE_OPTIONS"），
 * 但允许 `--require`。故：
 *   · node ≥ 20.6 → NODE_OPTIONS `--import tmp-cleanup.mjs`（v0.37.0 D148 原版）
 *   · node < 20.6 → NODE_OPTIONS `--require tmp-cleanup.cjs`（本文件，行为逐行等价）
 * 注入选择逻辑在 `scripts/run-tests-args.mjs`（单一事实源）。
 * ============================================================ */
'use strict'
const { readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const PREFIX = 'arkwork-'
/** 白名单形状：arkwork-<slug>；`pkg-src` / `dp-ws` / `x.y_z` 均匹配 */
const NAME_RE = /^arkwork-[A-Za-z0-9._-]+$/

let done = false
function sweep() {
  if (done) return
  done = true
  if (process.env.ARKWORK_TEST_KEEP_TMP === '1') return
  const dir = tmpdir()
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX) || !NAME_RE.test(e.name)) continue
    try {
      rmSync(join(dir, e.name), { recursive: true, force: true })
    } catch {
      /* 退出阶段不得抛：占用中/无权限一律跳过 */
    }
  }
}

process.on('exit', sweep)
