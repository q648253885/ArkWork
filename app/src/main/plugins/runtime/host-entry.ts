/* ============================================================
 * ArkWork — 插件 Host 半进程入口（v0.35.0 · M6）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §2 / §5.4
 *
 * 这是**唯一**被 `utilityProcess.fork()` 起来的文件。它的全部职责是接线：
 *   ① 取 `process.parentPort`（Electron 给 utility process 的 MessagePort）
 *   ② 装一层端点适配（子进程侧收到的是 `{data}` 包装，主进程侧不是）
 *   ③ 把 `createHostRuntime()` 挂上去，装崩溃上报，然后**什么都不做地等**
 *
 * 刻意保持极薄的理由：一切有判断的逻辑都在 `host-runtime.ts`（可注入端点 →
 * node:test 直接覆盖）。本文件只留「取端口 + 挂钩子」这两件不可测的胶水，
 * 这样「跑起来才发现的缺陷」被压缩到最小面积。
 *
 * 为什么插件代码不在这里 `import`：装载动作发生在收到 `host/prepare` 之后，
 * 由 host-runtime 按清单里的 `main` 精确 `import()` —— 入口文件不猜插件目录。
 * ============================================================ */
import { endpointFromParentPort, RPC_TIMEOUTS, HOST_ENV_FLAG } from './wire.js'
import { createHostRuntime, type HostRuntime } from './host-runtime.js'

/** Electron 在 utility process 里注入的 parentPort（类型不走 electron 包，避免本文件依赖 electron） */
interface ParentPortLike {
  postMessage(msg: unknown): void
  on(event: string, listener: (...args: unknown[]) => void): void
  start?(): void
}

export { HOST_ENV_FLAG }

function getParentPort(): ParentPortLike | null {
  const proc = (globalThis as { process?: NodeJS.Process & { parentPort?: ParentPortLike } }).process
  const pp = proc?.parentPort
  if (!pp || typeof pp.postMessage !== 'function' || typeof pp.on !== 'function') return null
  return pp
}

let runtime: HostRuntime | null = null

/**
 * 启动 Host 半。
 * @returns 运行时句柄（父进程已消失 / 非 utility process 环境时返回 null）
 */
export function bootstrap(): HostRuntime | null {
  const pp = getParentPort()
  if (!pp) return null
  pp.start?.()
  const ep = endpointFromParentPort(pp)
  // 订阅由 createHostRuntime 自己完成（工厂拥有端点，避免调用方漏挂）
  const rt = createHostRuntime({ endpoint: ep })
  rt.installCrashHooks()
  rt.startHeartbeat(RPC_TIMEOUTS.heartbeatMs)
  runtime = rt
  return rt
}

/** 已在运行的运行时（测试/诊断用；未启动为 null） */
export function currentRuntime(): HostRuntime | null {
  return runtime
}

/* 被 utilityProcess 直接 fork 时的自动启动路径。
 *
 * 判据取**显式环境变量**而非「parentPort 是否存在」：后者在 node:test 里
 * 也常常为真（tsx 有自己的 worker 端口语义），会让单测被一段无关的
 * bootstrap 噪音污染。显式标记让「谁启动了 Host 半」这件事可追。 */
function isHostChildProcess(): boolean {
  const proc = (globalThis as { process?: NodeJS.Process }).process
  return proc?.env?.[HOST_ENV_FLAG] === '1'
}

if (isHostChildProcess()) {
  const rt = bootstrap()
  if (!rt) {
    // 这条消息是「插件没反应」时唯一能不靠调试器看懂线索的地方
    // eslint-disable-next-line no-console
    console.error('[arkwork-plugin-host] 已按 Host 半启动，但拿不到 parentPort')
  }
}
