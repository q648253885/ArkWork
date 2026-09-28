/**
 * 计划项噪声过滤（v0.19.1）。
 *
 * 计划项（PlanItem.text）必须描述「做什么」——一个可执行的动作句，而不是：
 *   1. LLM 复述的历史清单状态自报（todo_update 结果 / plan_status 投影）；
 *   2. 被截断或顿号/逗号/冒号结尾的残句；
 *   3. 无动作动词的纯名词碎片（如「等待」「碰撞模型基础参数」）。
 *
 * 这些噪声项一旦进入 planItems，会让清单与真实执行严重脱节（v0.19.0 用户反馈）。
 * 与 `isPhaseHeader`（阶段标题型总结条目）互补：本函数过滤「根本不是动作句」的碎片，
 * 阶段标题的识别在 engine.ts 单独处理。
 */

/**
 * 中文动作动词（文档驱动开发 / 通用任务常见动作）。
 *
 * v0.38.0（D164）：**补齐高频动词** —— 实机验证（模拟模型 + 真实引擎，计划生成阶段）
 * 发现「检索入口文件」被判为噪声**静默丢弃**，4 项计划只剩 3 项。根因是本白名单缺
 * 「检索」等高频动词：只要一个合法动宾短语的动词不在表内，整项就被当成"无动作动词的
 * 名词碎片"丢掉 —— 且**没有任何诊断输出**（纪律⑨：静默丢弃是复合缺陷的粘合剂）。
 * 抽查 18 条常见动宾短语，17 条被丢（查看 / 收集 / 总结 / 抽取 / 校验 / 上传 /
 * 渲染 / 回滚 / 抓取 / 遍历 / 过滤 / 合并 / 转换 / 训练 / 备份 / 监控 …）。
 *
 * ⚠️ 本表是**唯一事实源**（纪律⑧）：判定只能走 `isNoisePlanItem()`，不得在调用点
 * 自行展开正则。新增动词的取舍标准：**该词出现即表明这是一条"要做的事"**。
 */
const CN_ACTION_VERBS = [
  // —— 原始表（v0.19.1 起）——
  '调研', '搜索', '查询', '撰写', '编写', '写', '实现', '开发', '编码', '测试', '部署', '打包',
  '封装', '接入', '初始化', '创建', '搭建', '执行', '产出', '读取', '列出', '修复', '补', '跑',
  '运行', '完成', '确认', '导出', '下载', '配置', '设计', '生成', '绘制', '建立', '验证', '检查',
  '安装', '编译', '对比', '评估', '梳理', '拆分', '整理', '分析', '调优', '重构', '迁移', '审查',
  '优化', '集成', '更新', '同步', '清理', '归档', '发布', '交付', '评审', '定位', '输出', '联调',
  '排查', '修改',
  // —— v0.38.0（D164）补齐：通用高频动词 ——
  '检索', '查看', '浏览', '收集', '归纳', '总结', '汇总', '校验', '校对', '解析', '抽取', '提取',
  '转换', '上传', '登录', '注册', '注销', '渲染', '训练', '推理', '复现', '回放', '采样', '标注',
  '裁剪', '压缩', '解压', '聚合', '拼接', '分发', '调度', '订阅', '重试', '回滚', '抓取', '遍历',
  '枚举', '匹配', '过滤', '排序', '去重', '埋点', '上报', '克隆', '提交', '合并', '检出', '暂存',
  '演示', '预览', '翻译', '润色', '排版', '备份', '恢复', '监控', '告警', '追踪', '拦截', '注入',
  '挂载', '卸载', '轮询', '熔断', '扩容', '回放', '打磨', '串联', '打通', '对齐', '澄清',
].join('|')

/** 英文动作动词（避免英文任务计划被「无动作动词」误判为噪声而整体丢弃） */
const EN_ACTION_VERBS = [
  // —— 原始表（v0.19.1 起）——
  'implement', 'develop', 'create', 'build', 'test', 'fix', 'write', 'add', 'refactor', 'design',
  'setup', 'initialize', 'initialise', 'run', 'deploy', 'install', 'configure', 'update', 'remove',
  'rename', 'migrate', 'analyze', 'analyse', 'review', 'optimize', 'optimise', 'integrate',
  'generate', 'export', 'download', 'validate', 'verify', 'check', 'search', 'research', 'explore',
  'read', 'list', 'complete', 'finish', 'deliver', 'publish', 'release', 'document', 'debug',
  'compile', 'compare', 'evaluate', 'assess', 'extract', 'split', 'organize', 'organise', 'sync',
  'clean', 'archive', 'wrap', 'establish', 'draw', 'produce', 'execute', 'track', 'inspect',
  'author', 'package',
  // —— v0.38.0（D164）补齐 ——
  'grep', 'clone', 'merge', 'commit', 'push', 'rebase', 'render', 'train', 'retry', 'rollback',
  'fetch', 'scan', 'traverse', 'filter', 'sort', 'dedupe', 'preview', 'translate', 'backup',
  'restore', 'monitor', 'alert', 'schedule', 'dispatch', 'subscribe', 'collect', 'summarize',
  'summarise', 'parse', 'transform', 'upload', 'login', 'logout', 'register', 'mount', 'poll',
  'inject', 'intercept', 'browse', 'query', 'retrieve', 'render',
].join('|')

/** 计划项动作动词（中英合并，忽略大小写） */
export const PLAN_ITEM_ACTION_VERBS = new RegExp(
  `${CN_ACTION_VERBS}|\\b(?:${EN_ACTION_VERBS})\\b`,
  'i',
)

/** 清单状态自报 / 历史清单投影关键词（含 [x][~][!][-][·] 状态标记） */
const PLAN_STATUS_ECHO = /已更新清单|当前清单|总项数|当前运行|触发点|\[x\]|\[~\]|\[!\]|\[-\]|\[·\]/

/** 以顿号/逗号/冒号结尾的残句（LLM 把一项拆成两半的典型特征） */
const TRAILING_PUNCTUATION = /[、，,：:]\s*$/

/**
 * 判断一条计划项是否为噪声。返回 true 表示应丢弃：
 *   1) 空 / 纯空白；
 *   2) 清单状态自报 / 历史清单投影；
 *   3) 以顿号/逗号/冒号结尾的残句；
 *   4) 无动作动词的碎片。
 */
export function isNoisePlanItem(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (PLAN_STATUS_ECHO.test(t)) return true
  if (TRAILING_PUNCTUATION.test(t)) return true
  if (!PLAN_ITEM_ACTION_VERBS.test(t)) return true
  return false
}
