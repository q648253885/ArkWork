/* 测试桩：替换 ../system/logger.js，避免传递依赖 electron */
export const logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
}