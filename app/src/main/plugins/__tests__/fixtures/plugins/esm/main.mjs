/* 夹具插件：**ESM 形态（.mjs）** —— 宿主必须同样支持
 *
 * 为什么两种格式都要验：作者群体是分裂的（一个社区写 CJS、另一个写 ESM），
 * 只支持一种等于把一半作者挡在门外；而「两种都支持」必须有用例把守，
 * 否则很容易在某次重构里把 import() 的兼容分支删掉而没人发现。
 */
export function apply(ctx) {
  ctx.ark.log('info', 'fixture-esm applied')
  ctx.effect(() => {
    ctx.ark.log('info', 'esm revoke')
  })
  return ctx.ark.tools.register({
    name: 'esm_echo',
    description: 'ESM 形态的工具',
    inputSchema: { type: 'object' },
    handler: (input) => ({ from: 'mjs', input }),
  })
}
