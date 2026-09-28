/* ============================================================
 * ArkWork — 测试 runner 参数构造（纯函数，v0.38.1 · D164）
 *
 * 为什么抽出来：run-tests.mjs 是脚本（.mjs），不进测试载体；而 D158 的
 * `node --import tsx/esm` 提速方案依赖 **node ≥ 20.6**，用户实机是
 * v18.11.0（Homebrew 唯一 node），实测直接 `bad option: --import`、
 * NODE_OPTIONS 注入也被拒 → **runner 在本机从未跑通过**。
 *
 * 本模块把「按 node 版本选 flag」的全部决策收敛为纯函数（单一事实源，
 * 纪律⑧同型），既被 runner 消费，也被 TC-RUNNER 用例直测：
 *
 *   · TS 转译：node ≥ 20.6 → `--import tsx/esm`（快路径，D158）
 *              node < 20.6 → `--experimental-loader tsx/esm`（loader 链，
 *                            实测 v18.11 单文件 0.7s，3/3 绿）
 *   · tmp-cleanup 注入：≥ 20.6 → NODE_OPTIONS `--import …mjs`
 *                       < 20.6 → NODE_OPTIONS `--require …cjs`
 *                       （`--require` 在 node 18 允许进 NODE_OPTIONS）
 *   · `--test-concurrency`（node ≥ 18.17 才有）与
 *     `--experimental-test-isolation`（node ≥ 20 才有）：
 *     仅在宿主 node 支持时透传，否则**丢弃并提示**（防 bad option 退出）。
 * ============================================================ */

/**
 * 解析 `v18.11.0` / `18.11.0` 形态的版本号。
 * @returns {{ major: number, minor: number, patch: number }}
 */
export function parseNodeVersion(versionString) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionString ?? ''))
  if (!m) return { major: 0, minor: 0, patch: 0 }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/**
 * 宿主 node 的能力位。全部走「最低引入版本」判断：
 *   · tsxViaImport      —— `--import` 自 node v20.6.0 引入
 *   · testConcurrency   —— `--test-concurrency` 自 v18.17.0 引入
 *   · isolationNone     —— `--experimental-test-isolation` 自 v20.x 引入
 */
export function nodeSupport(v) {
  const { major, minor } = v
  return {
    tsxViaImport: major > 20 || (major === 20 && minor >= 6),
    testConcurrency: major > 18 || (major === 18 && minor >= 17),
    isolationNone: major >= 20,
  }
}

/**
 * 构造「让 node 能跑 TS 测试文件」的 loader 参数（置于 `--test` 之前）。
 * 顺序约定：tsx 转译在前，electron-mock 在后（v18 实测该顺序
 * `--experimental-loader tsx/esm --experimental-loader <mock>` 3/3 绿；
 * mock 仅拦截裸 `electron` 解析，与 tsx 的 load 转换互不干扰）。
 *
 * @param {ReturnType<typeof nodeSupport>} support
 * @param {string} mockLoaderUrl pathToFileURL(electron-mock-loader)
 * @returns {string[]} node CLI 参数
 */
export function buildTsLoaderArgs(support, mockLoaderUrl) {
  if (support.tsxViaImport) {
    return ['--import', 'tsx/esm', '--experimental-loader', mockLoaderUrl]
  }
  return ['--experimental-loader', 'tsx/esm', '--experimental-loader', mockLoaderUrl]
}

/**
 * 构造 tmp-cleanup 的 NODE_OPTIONS 注入段。
 * ⚠️ `--import` 接受 file:// URL；`--require` 只接受**文件路径**
 *（v18 实测：传 URL 报 MODULE_NOT_FOUND @ internal/preload）。
 * @returns {{ flag: '--import'|'--require', url: string }}
 */
export function buildCleanupInjection(support, cleanupMjsUrl, cleanupCjsPath) {
  return support.tsxViaImport
    ? { flag: '--import', url: cleanupMjsUrl }
    : { flag: '--require', url: cleanupCjsPath }
}

/**
 * 解析并发池大小（v0.38.1 D164 rev2：取代 resolveShardCount）。
 *   · `TEST_CONCURRENCY`（D146 旋钮，现对全部 node 版本生效）优先
 *   · 其次 `TEST_SHARDS`（D162 旋钮，语义从「分片数」收敛为「池大小」）
 *   · 均未设 → 自动 min(cpu-1, 8)，至少 1
 *   · 非法（NaN/0/负）→ 1（回历史串行口径）
 */
export function resolvePoolSize(testConcurrencyEnv, testShardsEnv, cpuCount) {
  for (const raw of [testConcurrencyEnv, testShardsEnv]) {
    if (raw !== undefined && raw !== '') {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 1) return 1
      return Math.max(1, Math.floor(n))
    }
  }
  return Math.min(Math.max((cpuCount || 2) - 1, 1), 8)
}
