/* 夹具插件：**apply 抛错** —— 用于验证「绝不半注册」（纪律②）
 *
 * 关键点：抛错**之前**已经登记了一个 effect 与一次 tools.register。
 * 宿主必须把这两样都撤干净（插件侧账逆序撤销），
 * 否则就是「插件没激活成功，却留下了半截注册」。
 */
module.exports = {
  apply(ctx) {
    ctx.effect(() => {
      ctx.ark.log('info', 'thrower 的 effect 被撤销（说明半注册被收回）')
    })
    ctx.ark.tools.register({
      name: 'half_registered',
      description: '不该被真正注册上',
      inputSchema: { type: 'object' },
      handler: () => ({}),
    })
    throw new Error('夹具插件故意炸在 apply 里')
  },
}
