/* 夹具插件：**没有导出 apply** —— 用于验证 E_NO_APPLY 的**人话提示**
 * （纪律⑦：报错必须能让作者直接照做，而不是抛一句 Node 的八股）
 */
module.exports = {
  activate() {
    return '我故意不叫 apply'
  },
}
