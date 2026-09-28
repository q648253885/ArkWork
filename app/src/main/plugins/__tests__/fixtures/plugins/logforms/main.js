/* 两种 ctx.ark.log 调用形态都必须把内容送到主进程（TC-PLG2-027） */
module.exports = {
  apply(ctx) {
    ctx.ark.log('单参日志内容')
    ctx.ark.log('warn', '双参日志内容')
  },
}
