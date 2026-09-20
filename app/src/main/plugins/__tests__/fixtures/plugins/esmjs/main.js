/* 夹具插件：**.js 里写了 ESM 语法** —— 用于验证 E_MODULE_FORMAT 的预检
 *
 * 真实环境里 Node 只会抛 `SyntaxError: Unexpected token 'export'`，
 * 作者拿到这句话根本不知道要改文件名。宿主必须提前拦下并给可照做的指令。
 */
export function apply(ctx) {
  ctx.ark.log('info', '永远不该被跑到')
}
