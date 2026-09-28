/**
 * 取数栈选路（v0.36.0 自 ipc/panel.ts 抽出，供面板与插件网关共用）。
 *
 * 为什么必须是独立模块：插件 `net.fetch` 能力（host-service）与面板取数
 * （ipc/panel.ts）是**同一类需求** —— 都要遵循系统代理/PAC。v0.35.0 的教训
 * （as-built §14.1 P0-2）：插件网关没复用这条选栈，干脆没注入 fetch，
 * 导致插件取数永远拿到空壳响应。抽到这里后两边共用一个真源。
 *
 * **必须优先 `net.fetch`**：它走 Chromium 网络栈 → 遵循系统代理 / PAC / 证书策略；
 * 全局 fetch 走 Node undici → **不读系统代理**（实测证据见 ipc/panel.ts 文件头）。
 * 只在 Electron net 不可用时（如纯 Node 单测）才回落。
 */
import { net } from 'electron'

/** 取数函数签名（便于注入与单测） */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * 选一条取数栈。
 *
 * @param netModule 注入点（缺省取真实 `electron.net`），单测用它断言选栈方向
 */
export function pickFetch(netModule?: { fetch?: unknown }): { impl: FetchLike; via: 'net' | 'global' } {
  const holder = netModule ?? (net as unknown as { fetch?: unknown } | undefined)
  const candidate = holder?.fetch
  if (typeof candidate === 'function') {
    // 绑定到 holder：net.fetch 依赖内部 session 上下文，脱离对象调用会丢上下文
    return { impl: (candidate as FetchLike).bind(holder) as FetchLike, via: 'net' }
  }
  return { impl: fetch as unknown as FetchLike, via: 'global' }
}

/** 插件宿主网关约定的响应形态（host-service `PluginHostServiceOptions['fetch']`） */
export interface GatewayFetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * 把 `pickFetch` 选出的栈适配成插件网关需要的 `{status, headers, body}` 形态。
 *
 * 每次调用都现场选栈（而不是模块加载时选一次）：测试环境（electron-stub）里
 * `net.fetch` 缺失，回落全局 fetch；生产里走 net 栈。选栈留痕 via 进日志，
 * 排查「插件能上网但面板打不开」类问题时先看这行。
 */
export function pluginFetch(): (input: string, init?: Record<string, unknown>) => Promise<GatewayFetchResult> {
  return async (input, init) => {
    const { impl, via } = pickFetch()
    const res = await impl(input, init as RequestInit | undefined)
    const headers: Record<string, string> = {}
    res.headers?.forEach?.((v: string, k: string) => {
      headers[k] = v
    })
    const body = await res.text()
    return { status: res.status, headers, body }
  }
}
