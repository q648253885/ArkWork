/* 夹具插件：**私有存储超配额** —— 用于验证 E_STORAGE_QUOTA
 *
 * 配额不是「防坏人」而是「防手滑」：一个循环写 KV 的插件会无限撑大磁盘。
 * 超限必须**抛错**而不是静默截断 —— 静默截断会让作者以为写成功了。
 */
module.exports = {
  async apply(ctx) {
    const big = 'x'.repeat(1024)
    for (let i = 0; i < 400; i += 1) {
      await ctx.ark.storage.set(`k${i}`, big) // 400KB > 256KB 缺省配额
    }
  },
}
