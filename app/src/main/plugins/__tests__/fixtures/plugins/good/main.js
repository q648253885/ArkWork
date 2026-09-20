/* 夹具插件：**正常**（CJS 形态 —— 宿主缺省支持的写法）
 *
 * 它把「Host 半能做的一切」都跑一遍，好让用例按**协议可观测面**断言：
 *   · 两次 ctx.effect  → 卸载时必须**逆序**跑（effect-2 先于 effect-1）
 *   · 一次 ctx.on      → 事件闭集内合法
 *   · 一次 tools.register → 反向能力调用应该出现在主进程侧
 *   · handler 回显入参  → tool-call 链路可断言
 */
module.exports = {
  apply(ctx) {
    ctx.ark.log('info', 'fixture-good applied')
    ctx.effect(() => {
      ctx.ark.log('info', 'revoke effect-1')
    })
    ctx.effect(() => {
      ctx.ark.log('info', 'revoke effect-2')
    })
    ctx.on('workspace:changed', (payload) => {
      ctx.ark.log('info', `ws-changed:${JSON.stringify(payload)}`)
    })
    return ctx.ark.tools.register({
      name: 'ping',
      description: '回显入参',
      inputSchema: { type: 'object' },
      handler: (input) => ({ pong: true, echo: input }),
    })
  },
}
