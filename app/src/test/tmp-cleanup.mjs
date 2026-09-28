/* ============================================================
 * ArkWork — 测试进程收尾清扫（v0.37.0 · D148）
 *
 * 由 `scripts/run-tests.mjs` 通过 `--import` 注入到每个测试进程。
 *
 * 背景（实测）：全仓 30 处 `mkdtempSync` 的前缀**全部**以 `arkwork-` 开头，
 * 但多数套件只清「最后一个」或完全不清理（`after()` 里的模块级 WS 被
 * `beforeEach` 反复覆盖；或目录在用例内部就地创建）。实测累积：
 * `arkwork-dp-ws-*` 1301 个、`arkwork-pkg-*` 1968 个、`arkwork-*` 合计 7622 个，
 * 所在 TMPDIR 单项数 9420。后果不是「占点磁盘」，而是**目录操作变慢** ——
 * 把「N 秒内必须发生某事」的用例门槛（`waitFor(谓词, 5000)`）推爆，
 * 并每轮全量继续新增约千个，形成**越跑越慢、越跑越红**的自我强化循环
 * （D145 / D147 的共同放大器）。
 *
 * 为什么放在这里而不是逐个改夹具：夹具的建目录点分散在用例内部与 helper
 * 中（如 `join(mkdtempSync(...), 'x.zip')`），逐点改造既易漏又易错；
 * 进程退出时**一次性**清扫是单一收口。
 *
 * 安全约束：前缀写死 `arkwork-` 且名字须匹配 `^arkwork-[A-Za-z0-9._-]+$`，
 * 只删**目录**，失败只跳过不阻断（`process.on('exit')` 内不得抛异常）。
 * `ARKWORK_TEST_KEEP_TMP=1` 可关闭（排查夹具时用）。
 * ============================================================ */
import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
