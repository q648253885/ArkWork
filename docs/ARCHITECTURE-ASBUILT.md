# ArkWork 现状实录：架构设计与功能全景

> **文档定位**：本文是**当前代码的实际形态**（as-built）完整实录，供后续重构整个 Agent 系统架构与功能时作为**唯一基线**使用。
> 本文只回答「现在是什么样、为什么是这样、哪里是断点」；不回答「应该改成什么样」——那是重构设计文档的事。
>
> - 基线版本：`app/package.json` = **0.35.0**
> - git 状态：`HEAD = 0c4b45a (tag: v0.34.2)`，**v0.34.3 / v0.34.4 / v0.35.0 三版改动均未 commit**，工作树有大量未提交修改（逐版归因已不可复原）
> - 代码规模：生产代码 **135,659 行 / 562 个 TS·TSX 文件**；测试 **30,882 行 / 135 个文件**
> - 普查日期：2026-09-19
>
> **与既有文档的关系**：`docs/ARCHITECTURE.md` 是分层地图（约 19KB，偏骨架）；本文在其基础上补全了**全部功能子系统、关键阈值、消费链路与断裂点**，可作为重构时的唯一参考。

---

## 目录

| § | 章节 | 重构时的用途 |
|---|---|---|
| 1 | 产品定位与功能总览 | 判断「要保留/砍掉/重做」哪些能力 |
| 2 | 工程现状与技术栈 | 评估迁移成本 |
| 3 | 进程与分层架构 | 顶层切分依据 |
| 4 | 主进程组合根与启动顺序 | 启动链路的硬约束 |
| 5 | 领域服务全景 | 模块边界划分 |
| 6 | Agent 引擎（核心） | **重构主战场** |
| 7 | 记忆体系 | 记忆→技能链路 |
| 8 | 扩展体系（Profile/插件/技能/MCP） | 能力接入模型 |
| 9 | 渲染层架构 | UI 重构范围 |
| 10 | IPC 与跨进程契约 | 接口收敛 |
| 11 | 数据持久化布局 | 数据迁移 |
| 12 | 端到端数据流 | 主链路验证 |
| 13 | 关键阈值速查表 | 参数调优 |
| 14 | **架构债与断裂点** | **重构优先级清单** |
| 15 | 重构锚点建议 | 切分方案参考 |

---

# 1. 产品定位与功能总览

## 1.1 定位

本地优先的 AI Agent 桌面工作台。核心命题：**把 ReAct 推理循环做成可见、可控、可复用的头等对象**。

三条产品底线：
1. **无云端** —— 对话、记忆、索引全部以纯文件落在用户工作区，无数据库、无向量服务、无遥测。
2. **可介入** —— 任意时刻可暂停/继续/取消；引擎在关键节点主动停下询问，而非一路跑到底。
3. **可复用** —— 执行经验通过蒸馏与 skill-forge 沉淀为技能，而不是随会话蒸发。

## 1.2 功能清单（按用户可感知的能力分组）

| 能力域 | 功能 | 实现要点 | 成熟度 |
|---|---|---|---|
| **任务执行** | ReAct 循环（Reason→Act→Observation） | `agent/engine/loop.ts` 主循环，200 轮上限 | ✅ 核心 |
| | chat / task 双通道分流 | 纯规则 ≤5ms 判定（`router/classify-route.ts`） | ✅ |
| | 暂停 / 继续 / 取消 | AbortController + 1s 宽限 + checkpoint | ✅ |
| | 检查点回滚 | 按 iteration 粒度截断 L1 | ⚠️ 只截断记忆，不回滚文件 |
| **可见性** | 实时步骤时间线 | Turn→Step→Block 三层事件模型 | ✅ |
| | 并行工具组进度 | groupId 聚合 + per-requestId 进度 | ✅ |
| | 上下文占比下钻 | 7 分类拆解，可按类清空 | ✅ |
| | 任务图（TaskGraph） | 11 态节点 + DAG + 证据链 + 收敛判定 | ✅ 重头戏 |
| **工具能力** | 内置 29 个工具 | 文件/搜索/网络/shell/浏览器/委派/图 | ✅ |
| | MCP 工具 | stdio JSON-RPC，多 server 并发 | ✅ |
| | 指令型技能 | SKILL.md 渐进披露 | ✅ |
| | 插件工具 | `plugin__<id>__<name>`（v0.35.0） | ⚠️ 声明已通，运行期见 §14.1 |
| **安全防护** | 五级权限模式 | default/autoApprove/acceptEdits/plan/bypass | ✅ |
| | shell 风险分级 | 黑名单 + 3/5 级评估 + 审计日志 | ⚠️ 两套风险模型并存 |
| | 签名级+类别级预算 | 防工具调用失控 | ✅ |
| | doom-loop 检测 | 60s 窗口同命令 3 次 | ✅ |
| | 路径守卫 | realpath 双校验挡 symlink 逃逸 | ✅ |
| **记忆** | L1 工作记忆 | 逐条可勾选/编辑/归档 | ✅ |
| | L2 文件记忆 | 工具大结果落盘 + 实体去重合并 | ✅ |
| | L3 策展 + 档案 | memory.md/user.md + 任务档案全文检索 | ✅ |
| | L4 用户画像 | 版本化档案，保留 10 版可回滚 | ✅ |
| | 上下文压缩 | 四级阈值 + 两阶段（prune/summarize） | ⚠️ 三套阈值并存 |
| | 蒸馏 → 技能 | skill-forge 五阶段管线 + 九项闸门 | ✅ 设计完整 |
| **知识库** | PDF/DOCX/TXT/MD 导入 | 段落边界切块 1800 字符 + 150 重叠 | ✅ |
| | 本地全文检索 | MiniSearch，`prefix:true` + `fuzzy:0.2` | ✅ |
| | 按任务启用 + 自动召回 | 启动 top-3 注入 L1 | ✅ |
| **工作台 Profile** | 九类插槽体系 | 与领域无关的注册/解析 | ✅ |
| | 三个内置工作台 | wb.base / wb.coding / wb.research | ✅ |
| | 导入/导出/克隆/校验 | V1–V6 校验规则 | ✅ |
| | 诊断视图 | 插槽实况 + 降级报告 | ✅ |
| **插件** | 声明式插件（零代码） | 白名单组件库 10 个 | ✅ |
| | 代码插件（v0.35.0） | utilityProcess + iframe 沙箱 | ⚠️ 见 §14.1 |
| | 三级作用域 | bundled < global < workspace | ✅ |
| | 可逆 effect 账本 | 取代「按来源清槽」 | ✅ |
| **内置浏览器** | 多 Tab WebContentsView | dock ↔ 浮窗迁移 | ✅ |
| | Agent 自主驱动 | 17 种操作，ref 定位 | ✅ |
| | 人机协同 | 用户点击即夺权，Agent 得明确错误 | ✅ |
| **编辑器** | CodeMirror 6 | 13 种语言，原子保存 + CAS 冲突 | ✅ |
| | 文件树 + 监听 | chokidar 200ms 批次 + 来源归因 | ✅ |
| **其他** | 自动化 Cron | 五段 cron，同分钟去重 | ✅ |
| | 技能市场 | 搜索/安装/收藏/多源 | ✅ |
| | 四语言 i18n | zh/en/ja/ko，各 2971 行 | ✅ |
| | 浮窗预览 | 8 种渲染器 + 拖拽缩放最小化 | ✅ |

---

# 2. 工程现状与技术栈

## 2.1 技术栈

| 层面 | 选型 | 备注 |
|---|---|---|
| 运行时 | Electron 33 + Node.js（ESM） | 主进程 ESM |
| 构建 | electron-vite 2.3 + Vite 5 + electron-builder 26 | |
| 前端 | React 18.3 + TypeScript 5.6 + Tailwind 3.4 + Zustand 5 | |
| 编辑器 | CodeMirror 6 | 全仓仅 `renderer/components/editor/` 可 import |
| LLM SDK | `@anthropic-ai/sdk` + `openai` | 4 类 kind：openai/anthropic/ollama/vllm |
| 检索 | MiniSearch | 无向量库 |
| 持久化 | 文件系统 JSON/JSONL/Markdown | 无数据库 |

## 2.2 代码规模分布

| 区域 | 文件数 | 行数 | 说明 |
|---|---:|---:|---|
| `src/main/` | 291 | 74,264 | 全部业务逻辑 |
| `src/renderer/` | 211 | 47,516 | 纯 UI |
| `src/shared/` | 57 | 13,120 | 双端共享类型与纯函数 |
| `src/preload/` | 3 | 759 | 唯一跨进程桥 |
| **生产合计** | **562** | **135,659** | |
| 测试（`__tests__/`） | 135 | 30,882 | 测试/生产 ≈ 1:4.4 |

**main 内部二级分布**（按行数降序）：

| 目录 | 文件 | 行数 | 性质 |
|---|---:|---:|---|
| `agent/` | 125 | 34,415 | **Agent 引擎，最大单体** |
| `plugins/` | 23 | 8,437 | 插件运行时 |
| `ipc/` | 29 | 5,009 | 接入层 |
| `memory/` | 21 | 4,659 | 四层记忆 |
| `store/` | 12 | 4,048 | 持久化 |
| `fs/` | 14 | 3,280 | 文件与路径守卫 |
| `llm/` | 16 | 2,858 | LLM 适配 |
| `profile/` | 8 | 2,243 | 工作台 |
| `fault-tolerance/` | 9 | 2,094 | 容错 |
| `skills/` | 12 | 1,640 | 内置技能 |
| `browser/` | 2 | 1,333 | 内置浏览器 |
| 其余（kb/router/engine/checkpoint/pause/automation/mcp/system/i18n） | ~17 | ~3,288 | |

**测试分布**：`main/agent` 45 · `renderer` 32 · `shared` 16 · `main/plugins` 8 · `main/llm` 8 · `main/memory` 6 · `main/fs` 5 · `main/store` 4 · 其余 ~11。

## 2.3 验证与交付状态

- 测试：`node scripts/run-tests.mjs`（cwd=`app/`），v0.35.0 终态 **1667 用例 0 fail**
- 类型：双 tsconfig 校验（`tsconfig.node.json` + `tsconfig.web.json`）零错
- 打包：`npm run build:dir`（mac .app 579MB / win zip）
- **git 欠账**：三版未 commit → 无法用 `git status` 分离 v0.34.3 / v0.34.4 / v0.35.0 的改动归属

---

# 3. 进程与分层架构

## 3.1 顶层骨架

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer（React UI）        src/renderer/                     │
│  三栏骨架 · 交互流 · Inspector 竖排栏 · 浮窗 · i18n 四语言       │
└──────────────▲─────────────────────────────┬─────────────────┘
               │ window.ark.*（contextBridge）│ 事件推送
┌──────────────┴─────────────────────────────▼─────────────────┐
│ Preload 桥                  src/preload/index.ts              │
│  25 个命名空间 + 1 标量；唯一跨进程入口                          │
└──────────────▲─────────────────────────────┬─────────────────┘
               │ ipcMain.handle / webContents.send
┌──────────────┴─────────────────────────────▼─────────────────┐
│ Main（Node 全能力）         src/main/                         │
│  组合根 → IPC → 领域服务 → 基础能力                            │
│  ├─ 附加进程：utilityProcess × N（每代码插件一个）              │
│  └─ 附加视图：WebContentsView × N（浏览器 Tab）                │
└──────────────────────────────────────────────────────────────┘
                    ▲
              src/shared/（双端共享类型与纯函数，零依赖）
```

## 3.2 分层纪律

| 层 | 目录 | 职责 | 红线 |
|---|---|---|---|
| 主进程 | `src/main/` | 全部业务逻辑、文件系统、LLM 调用、Agent 循环 | 唯一有 Node 能力的地方 |
| 预加载 | `src/preload/` | 收敛全部 IPC 为 `window.ark` | 不含业务逻辑，只转发解包 |
| 渲染进程 | `src/renderer/` | 纯 UI + 交互状态 | **禁止 import `main/`** |
| 共享层 | `src/shared/` | 类型 + 无副作用纯函数 | 不得依赖 Electron / Node 专有模块 |

**依赖单向**：`renderer → preload → main`；`shared` 被三方引用但自己零依赖。主进程内部：**上层可调下层，下层不得反向 import 上层**（实际有多处用动态 import 绕开循环，见 §14.3）。

---

# 4. 主进程组合根与启动顺序

## 4.1 启动顺序（`main/index.ts`）

### A. `app.whenReady()` **之前**（同步，模块顶层）

| 步 | 行 | 内容 | 硬约束 |
|---|---:|---|---|
| A1 | 30-32 | CDP 调试端口（`ARK_CDP_PORT` → `remote-debugging-port`） | 必须在任何窗口创建之前 |
| A2 | 41-45 | `ARK_FORCE_GPU=1` → GPU 相关开关 | |
| A3 | 49-63 | 非打包：userData → `.dev-data`；`--no-sandbox` | |
| A4 | 64-80 | 打包：`app.setName('ArkWork')`；`{userData}/.debug-cdp` 存在则开 CDP | |
| A5 | 83-90 | 单实例锁 | |
| **A7** | **103** | **`registerPluginSchemePrivileges()`** | ★ **必须在 `whenReady()` 之前**，否则协议特权被静默忽略 → 插件 iframe 无独立源、fetch 被 CORS 挡 |
| A8 | 163-169 | `web-contents-created` → 外链走系统浏览器 | |

### B. `whenReady()` 内

| 步 | 行 | 内容 | 为什么在这个位置 |
|---|---:|---|---|
| B1 | 109 | `initStore()` | 存储先于一切 |
| B2 | 110 | `ensureWorkspace()` | 工作区目录 |
| B3 | 112 | `reconcileStaleTasks()` | 上次意外退出的 running/paused → cancelled |
| B4 | 114 | `seedDefaults()` | 写默认 Agent/Skill/Model（不覆盖） |
| B5 | 116 | `seedBuiltinSkillsToFolders()` | 内置技能元数据落盘 |
| B6 | 119 | `registerIpcHandlers()` | 26 个领域 handler |
| **B7** | **123** | **`bootstrapIpcSideEffects()`**（= `bootstrapProfile()`） | **必须在建窗之前**，否则首屏 Dock/首页模块是未装配形态 |
| **B8** | **128-132** | **`bootstrapPluginRuntime({ mainDir })`** | ★ **必须在 B7 之后**：要读工作区级插件目录，而工作区路径由 B7 确定。整体 try/catch 只 warn |
| B9 | 135 | `startAutomationScheduler()` | |
| B10 | 138 | `scheduleCleanup()` | .arkwork 临时文件 24h 清理 |
| B11 | 141 | `createMainWindow()` | 必须在 B7/B8 之后 |
| B12 | 146 | `logger.info('ArkWork ready')` | |

### C. 退出（`before-quit`）

```
① stopAutomationScheduler()
② shutdownPluginRuntime()      ← ★ 在 MCP 断开之前
                                  （插件工具可能持有 MCP 连接；反序会让插件 cleanup 拿到已断会话）
③ await pauseAll()
④ await disconnectAllMcp()
```

## 4.2 插件运行时接线（`plugins/bootstrap.ts:45-95`）

```
⓪ setHostVersion(app.getVersion())                   ← 必须早于 ④
① registerPluginProtocol({ dirOf, logger })
② initPluginHostService({ entryPath, broadcast })
③ setPluginTeardownHook(id => teardownPlugin(id))    ← 拔插连通（不接则禁用后进程仍在跑）
③.5 setPluginViewOpenEmitter(→ 广播 view-open-request)
④ refreshPluginsAndIndex()                           ← 首次扫描，不启进程（懒激活）
⑤ activatePersistentPlugins('startup')               ← 只拉起命中 onStartup 的
```

**另两个出口**：切工作区 `onWorkspaceSwitchedPluginRuntime()`（先逐个 teardown workspace 来源 → 重扫 → 激活）、退出 `shutdownPluginRuntime()`。

> ⚠️ 这些顺序约束**写错不报错，只是全部不生效**。历史上已因此类问题产生 D78/D79 两个缺陷（详见 §14.1）。

---

# 5. 领域服务全景

## 5.1 主进程四层

```
组合根（index.ts / window.ts / plugins/bootstrap.ts）
   ↓
接入层（ipc/，26 个 handler）
   ↓
领域服务（agent / memory / kb / profile / plugins / router / automation /
         browser / checkpoint / pause / fault-tolerance / engine / audit）
   ↓
基础能力（llm / store / fs / mcp / system / i18n）
```

## 5.2 领域服务索引

| 模块 | 职责 | 关键入口 | 行数 |
|---|---|---|---:|
| **agent** | ReAct 引擎与运行时 | `agent/runner.ts`（运行控制 + AbortSignal） | 34,415 |
| ├ engine | 主循环与接缝模块 | `engine/loop.ts` | 6,286 |
| ├ graph | TaskGraph 任务图 | `graph/store.ts` / `plan-sync.ts` | 7,096 |
| ├ skills | 内置技能实现 | `skills/*.ts` | 3,129 |
| ├ prompt | 提示词契约层 | `prompt/contract.ts` / `sections.ts` / `gates.ts` | 675 |
| └ tools | 工具呈现 + 插件控制 | `tools/present.ts` / `plugins.ts` | 710 |
| **memory** | 四层记忆 + 压缩 + 蒸馏 + skill-forge | `memory/skill-forge.ts` | 4,659 |
| **plugins** | 代码化插件运行时 | `plugins/bootstrap.ts` | 8,437 |
| **profile** | 工作台插槽体系 | `profile/activator.ts` | 2,243 |
| **fault-tolerance** | 失败分级/替代技能/退避重试 | `run-fault-tolerant.ts` | 2,094 |
| **browser** | 内置浏览器（多 Tab + Agent 驱动） | `view-manager.ts` / `controller.ts` | 1,333 |
| **kb** | 知识库（导入/切块/索引/检索） | `kb/index.ts` | 649 |
| **router** | chat/task 分流 + Agent 选择 | `classify-route.ts` | 636 |
| **engine** | 阶段执行器（Phase 0~3 骨架） | `phase-runner.ts` | 550 |
| **checkpoint** | 每轮存档与回滚 | `store.ts` | 187 |
| **pause** | 优雅暂停 / 退出落盘 | `manager.ts` | 199 |
| **automation** | Cron 调度 | `scheduler.ts` / `cron.ts` | 169 |

## 5.3 基础能力层

| 模块 | 职责 | 要点 |
|---|---|---|
| `llm/` | 适配器注册表 + openai/anthropic 适配器 + 流式管道 + think/say 剥离 + token 计数 + 缓存用量 | 2,858 行 |
| `store/` | JSON 持久化底座 + 各实体仓储 + 种子 | `db.ts` 三种原语：`JsonCollection` / `JsonDoc` / `JsonlCollection` |
| `fs/` | 工作区读写、路径守卫、原子写、产物登记、chokidar 监听、定时清理 | 3,280 行 |
| `mcp/` | 零依赖 JSON-RPC 2.0 stdio 客户端 | 单文件 413 行 |
| `system/` | 日志 | 71 行 |
| `i18n/` | 主进程侧文案 | 722 行 |

---

# 6. Agent 引擎（重构主战场）

## 6.1 ReAct 主循环（`engine/loop.ts`）

入口 `runReActLoop(opts)` — `loop.ts:268`。

### 每轮的阶段划分

```
while (iteration < startIter + maxIterations) {
  ① 中断检查（signal.aborted → handleAbort）
  ② 清单同步（每轮从 store 重读 planItems，防过期）
  ③ Reason  ← runReasonPhase()：装配消息/工具 → 流式 LLM → 落 L1 → 广播
  ④ 叙述签名比对（thought||reasoningContent 与上一轮比，判 freshNarrative）
  ⑤ 无工具分支 → 终止判定
  ⑥ task_complete 分支 → finishViaTaskComplete（可能被拦截）
  ⑦ ask_user 分支 → pauseViaAskUser
  ⑧ Act     ← 两层预算检查 → 并行执行 → 广播 → 写 L1 → 图写回
  ⑨ 只读停滞注入（连续 3 轮纯只读）
  ⑩ 零产出守卫（isStalledRound / advanceStallCounter）
  ⑪ 存 checkpoint（fire-and-forget）
  ⑫ 自动压缩（maybeAutoCompress）
  ⑬ 中断再查
}
```

### 预算常量

| 常量 | 默认 | 位置 | 含义 |
|---|---:|---|---|
| `MAX_ITERATIONS` | **200** | `loop.ts:156` | 最大迭代轮数（⚠️ `loop.ts:141` 注释仍写「默认 25」，与实际不符） |
| `MAX_PER_SIGNATURE` | 5 | `:165` | 同「工具+参数签名」最大调用次数（key = MD5） |
| `MAX_PER_TOOL_DEFAULT` | 400 | `:166` | 非只读工具类别总预算 |
| `MAX_PER_TOOL_READONLY` | 600 | `:167` | 只读工具类别总预算 |
| `MAX_ALL_EXHAUSTED_ROUNDS` | 3 | `:179` | 连续 3 轮所有工具被拦截 → 优雅暂停 |
| `MAX_CONSECUTIVE_NO_TOOL` | 2 | `:183` | 连续无工具调用 → 自愈提示升级为强指令 |
| `MAX_STALLED_ROUNDS` | 6 | `stall.ts:22` | 连续零产出轮 → 暂停 |
| `MAX_COMPLETE_REFUSALS` | 2 | `turn-end.ts:42` | 清单有未收口项时拒收尾，超限则先收 cancelled |
| `READONLY_TOOLS` | 7 个 | `loop.ts:184-192` | file-reader/glob/grep/web-search/fetch-url/session-search/kb-search |

### 终止条件总表

| 终止形态 | 判定位置 | 结果状态 |
|---|---|---|
| 模型未调工具 + 清单已清空 | `loop.ts:416/427/477` | `done` |
| 模型调 `task_complete` | `loop.ts:516` → `turn-end.ts:92` | `done`（可能被验证门禁/未收口项拦截） |
| 模型调 `ask_user` | `loop.ts:538` → `turn-end.ts:284` | `paused` + `pendingAskUser` |
| 计划闸门（submit_plan 成功） | `loop.ts:839-849` | `paused` |
| 阶段门禁（写出阶段产物） | `loop.ts:801-935` | `paused` |
| 类别预算触顶（首次） | `loop.ts:576-601` | `paused` + ask_user |
| 连续 3 轮全被拦截 | `loop.ts:628-640` | `paused` |
| 连续 6 轮零产出 | `loop.ts:968-998` | `paused` |
| 迭代上限 | `loop.ts:1030-1049` | `paused` + ask_user（继续/结束） |
| 用户中断 | `loop.ts:359/1021` | `cancelled` 或 `paused` |
| 异常 | `loop.ts:1050-1077` | `failed` |

> **设计取向**：几乎所有异常终局都是 `paused` + 询问，而非 `failed`。这是「可介入」产品底线的直接体现。

## 6.2 engine/ 接缝模块

| 模块 | 行数 | 职责 |
|---|---:|---|
| `run-setup.ts` | 474 | 运行前置：system_prompt 注入、startIter 推导、always-on 契约、门禁消费、首轮 Plan 生成、TaskGraph 迁移/建图 |
| `reason-phase.ts` | 407 | Reason 主体：消息装配 + 流式 LLM（双通道 text/reasoning + SAY 剥离）+ 空响应补试 + 长度截断提额重试 + Reactive Fallback |
| `act.ts` | 967 | Act 执行段：动作收集、观察摘要（含失败替代建议）、阶段写守卫、todo_update 拦截、插件工具分发、图写回 |
| `turn-end.ts` | 382 | `task_complete` / `ask_user` 两个终止分支的收尾 |
| `abort.ts` | 117 | 中断处理 + 部分内容落盘 + continuation 注入判定 |
| `stall.ts` | 121 | 零产出轮判定（纯函数，真值表可穷尽） |
| `gates.ts` | 423 | 回合收口 / 重开图 / 计划推进判定 / 失败标记 |
| `messages.ts` | 554 | 消息装配 + **工具面组装**（`assembleTools` 是能力接入模型的唯一装配点） |
| `context.ts` | 280 | 上下文体量评估 |
| `memory-hooks.ts` | 354 | 记忆六钩子：注入 / KB 召回 / 自动压缩 / run done 归档·画像·蒸馏·skill-forge |
| `skills.ts` | 166 | 技能指令注入（L1 `skill_instruction`，按 skillId 去重） |
| `plan.ts` | 330 | 计划生成（三套 prompt + 三级降级链） |
| `dispatch.ts` | 281 | chat/task 双通道路由（**Turn 模型骨架，见 §14.4**） |
| `broadcast.ts` | 157 | 广播叶子模块 |
| `hints.ts` | 33 | 瞬时提示通道标签（单一真源） |

## 6.3 事件模型：Turn → Step → Block

### Step（`shared/types/react.ts:37-109`）

```ts
ReActStepType   = 'plan' | 'reason' | 'act' | 'observation'
ReActStepStatus = 'success' | 'failed' | 'cancelled' | 'running'
```

字段分组：
- 通用：`id / taskId / iteration / type / startedAt / durationMs / status`
- reason 侧：`thought`（剥离 SAY 后的剩余）、`reasoning`（原生思考通道）、`say`（阶段叙述）
- act 侧：`toolName / toolArgs / intent / intentKey / intentParams / result / resultSummary`
- observation 侧：`summary / rawL2Path`
- token 账目：`tokensIn / tokensOut / cacheHitTokens / cacheMissTokens`
- 语义标记：`softFail`（门禁/预算拦截 → 橙色非红色）、`truncated`

> ⚠️ **`thought` 与 `reasoning` 语义高度耦合但分散在 12 处消费者**（`react.ts:46-58` 自述），是「语义脆弱点」。

### Event（`shared/types/react.ts:112-289`，共 33 种）

- 生命周期：`task_started / reason_start / reason_end / act_start / act_end / observation / task_complete / ask_user / task_failed / task_paused / max_iterations_reached / log`
- 计划：`plan_start / plan_end / plan_adjusted`
- 记忆/上下文：`memory_compressed / context_compacted / profile_updated / distill_completed / context_size_report`
- 进度：`task_progress / task_step_complete / task_milestone`
- 图（10 种）：`graph_created / graph_patch / graph_status / graph_evidence / graph_needs_human / graph_replan_proposed / graph_converge_report / graph_drift / graph_notice / graph_plan_gate`

### 广播通道（`agent/events.ts`）

| 通道 | 函数 |
|---|---|
| `task:step` | `broadcastStep` |
| `task:status` | `broadcastTaskStatus` |
| `task:event` | `broadcastReActEvent` |
| `task:text-delta` | `broadcastTextDelta` |
| `task:progress` / `task:progress:clear` | `broadcastToolProgress` / `clearToolProgress` |
| `task:plan-item-status-changed`（带 `planListVersion` 单调自增） | `broadcastPlanItemStatus` |
| `task:plan-list-snapshot` | `broadcastPlanListSnapshot` |
| `graph:update`（9 种 kind） | `broadcastGraphStatusChanged` / `toGraphUpdatePayload` |
| `tool:confirm` / `tool:confirm:respond` | `makeRendererConfirm` / `respondToolConfirm` |

### Turn 层

Turn 实体**不在 agent 目录**（在 `main/engine/types.ts`）。agent 侧只提供 turn 语义基础设施：`inbox.ts`（进程内存队列 + continuation）、`turn-stopping.ts`（停止候选监听器）。

> ⚠️ **continuation 通道实际恒空**——无生产代码注册监听器，见 §14.4。

## 6.4 工具系统

### 统一抽象

`Skill` 一个抽象覆盖三类来源：**内置工具** / **MCP 工具** / **指令型技能**。

| 概念 | 位置 |
|---|---|
| `SkillContext` | `registry.ts:69-104` |
| `ToolRiskLevel`（5 级） | `registry.ts:130-135` |
| `skillToLlmTool` | `registry.ts:345-354` |
| 三段流水线 `runToolPipeline` | `tool-pipeline.ts:51`（pre 校验 → execute → post 摘要） |

### 工具来源（4 类）

1. **内置 builtin** —— `store/seed.ts` 的 `BUILTIN_SKILLS`（20 条 + 9 个图工具）
2. **MCP** —— `listSkills` 动态注入已连接 server 的 tools，id 形如 `M-{ns}.{toolName}`
3. **指令型技能** —— `discoverSkills` 三层扫描（project > user > bundled）
4. **插件**（v0.35.0）—— 插件自带工具 `plugin__<id>__<name>` + 宿主控制工具 4 个

### `assembleTools` 装配顺序（`messages.ts:468-554`）

```
agent.defaultSkillIds ∪ task.skillIds
  → 叠加 profile 工作台声明技能（只加不减，只取 kind==='skill' && found）
  → 合并 MCP server 对应技能
  → 过滤 enabled !== false
  → 追加插件工具 + 插件控制工具
  → 按工具名 localeCompare 排序（为 prompt cache 前缀确定性）
```

> 这是**能力接入模型的唯一装配点**，重构时是核心枢纽。

### 执行管道 11 步

① 动作收集 → ② 引擎侧预算拦截 → ③ 阶段写入守卫 → ④ `todo_update` 特殊处理 → ⑤ 工具名解析 → ⑥ 指令体渐进披露 → ⑦ 权限校验（pre）→ ⑧ 执行 → ⑨ 结果摘要/截断 → ⑩ 大结果落盘 L2 → ⑪ 写 L1 observation → ⑫ 图写回 → ⑬ 广播

### 内置技能完整清单（29 个工具）

| # | 工具名 | 能力 | 风险等级 |
|---:|---|---|---|
| 1 | `file-reader` | 读文件/目录，cat-n 行号 + 分页 | workspace-readonly |
| 2 | `file-writer` | 写文件（默认不覆盖） | workspace-light-write |
| 3 | `file-editor` | 搜索替换编辑 | workspace-light-write |
| 4 | `glob-search` | glob 找文件（上限 1000） | workspace-readonly |
| 5 | `grep-search` | 正则搜索，三态 output_mode | workspace-readonly |
| 6 | `web-search` | 百度/Bing/DDG 三源 race（单源 8s，全局 12s） | external-readonly |
| 7 | `fetch-url` | 抓 URL 正文（默认 20000 字符，12s） | external-readonly |
| 8 | `shell` | 工作区内执行命令（默认 30s，上限 5min） | 走 `assessCommandRisk` 5 级 |
| 9 | `browser` | 浏览器自主驱动（17 种操作） | medium |
| 10 | `task_complete` | 任务收尾（summary + suggestions） | workspace-readonly |
| 11 | `ask_user` | 提问 + 2~4 建议选项 | workspace-readonly |
| 12 | `todo_update` | 更新清单项状态 | workspace-readonly |
| 13 | `delegate-agent` | 委派子 Agent（仅回收摘要） | workspace-light-write |
| 14 | `session-search` | 检索 L3b 历史档案（limit 1~20） | workspace-readonly |
| 15 | `kb-search` | 检索知识库切块 | workspace-readonly |
| 16 | `kb-enable` | 为任务启用知识库条目 | workspace-readonly |
| 17 | `spec` | 生成 spec/tasks/checklist 三件套 | medium |
| 18 | `plan` | 生成 plan.md + PlanItem 列表 | medium |
| 19 | `bugfix` | 目标驱动多轮修缺陷 | medium |
| 20 | `react-core-skills` | 文档驱动开发准则 | medium |
| 21-29 | `task_create/update/get/list/evidence/block/request_plan/submit_plan/replan` | TaskGraph 工具集 | workspace-readonly |

**支撑库**：`skills/abort.ts`（超时与用户中止合并）、`skills/file-tool-safety.ts`（受保护路径 13 条正则）、`skills/read-repeat-guard.ts`（重复读检测：第 3 次 warn，第 4 次 block）。

## 6.5 权限与安全

| 机制 | 位置 | 要点 |
|---|---|---|
| 五态权限模式 | `permission-mode.ts:30-79` | `default` / `autoApprove` / `acceptEdits` / `plan` / `bypassPermissions` |
| ModePolicy 六策略位 | `:21-28` | workspaceReadonly / externalReadonly / workspaceLightWrite / highRisk / reject / protectedPaths |
| 会话覆盖层 | `session-mode.ts` | session > settings.defaultMode > 'default' |
| 四级配置 | `settings-loader.ts:111-152` | managed → local → project → user |
| shell 黑名单 | `permissions.ts:51-66` | rm -rf /、fork bomb、mkfs、dd of=/dev、shutdown、chmod 777 / |
| 受保护路径 | `permissions.ts:183-198` | 13 条正则 |
| 3 档风险分级 | `shell-risk.ts:15` | HIGH 9 条 / MEDIUM 10 条 |
| 审计日志 | `shell-audit.ts` | 落 `.arkwork/logs/shell-audit.jsonl`，5MB 轮转 ×3，30 天清理 |
| doom-loop | `doom-loop.ts` | 60s 窗口同命令+cwd ≥3 次 |
| 交互式确认 | `registry.ts:966-1001` | 推 `tool:confirm` 浮层，60s 超时**不算拒绝** |
| 轻写确认记忆 | `light-confirm-memory.ts` | TTL 30 分钟，5 分钟 prune |

## 6.6 提示词层（`prompt/`，675 行）

### `contract.ts`（112 行）
- `ContentStability`：`static | agent-static | run-static | volatile`
- `InjectSlot`：`{kind:'system'} | {kind:'message-tail'} | {kind:'standalone-message'}`
- 硬约束：**volatile 段进 system 槽位直接 throw**（会破坏前缀缓存）
- `owner`：`core | agent | skill | memory | kb | user`

### `sections.ts`（308 行）— 内容段注册表

| 段 | order | stability | owner | maxTokens |
|---|---:|---|---|---:|
| `workspace-context` | -100 | run-static | core | 4000 |
| `core-rules` | 0 | static（required） | core | 8000 |
| `personality` | 100 | agent-static | agent | 400 |
| `skill:{id}`（always-on） | 150 | agent-static | skill | 16000 |
| `profile-context` | 180 | run-static | core | 180 |
| `workspace` | 200 | run-static | core | 200 |
| `memory` | 300 | run-static | memory | 3000 |
| `narration-protocol` | 490 | static | core | 220 |
| `plan-constraint` | 500 | run-static | core | 300 |

装配：`assembleSystemPrompt(ctx, extras)` — `sections.ts:270-308`，逐段 build → 预算断言 → order 排序 → `'\n\n---\n'` 连接。

### `gates.ts`（255 行）— 门禁状态机

**门禁不是阶段，而是「产出某物 → 必须向用户确认」的声明**，来自 SKILL.md frontmatter：

```yaml
---
instructionMode: always-on
gates:
  - id: prd-confirmed
    after: 产出 01-prd.md
    ask: PRD 要点总结 + 待确认项
---
```

- `GateState.status`：`pending | passed | skipped`
- 三条落地路径：① `todo_update` 标 done 被拦 → ② 下一轮 run 启动时消费 `pendingGateBlock` → ③ 阶段产物写出后自动 ask_user
- ⚠️ **另有两套并行门禁需注意区分**：`graph/gate.ts` 的 I1–I7 不变量门禁、`react-core-skills/stage-gates.js` 的阶段产物文档门禁

## 6.7 TaskGraph（`graph/`，7,096 行）

v0.30.0 引入，**图是真源，planItems 已降级为派生镜像**。

### 节点状态（11 态，`shared/types/graph.ts:31-57`）

```
draft → proposed → approved → ready → in_progress → verifying → blocked → needs_human
      → completed / cancelled / failed
                     （终态仅 completed / cancelled）
```

### 模块职责

| 模块 | 行数 | 职责 |
|---|---:|---|
| `store.ts` | 1000 | 落盘 + 快照 + Revision + **唯一 planItems 镜像写入点** + 索引 |
| `sync.ts` | 589 | Sync 编排：S1 Project、act 后 S2→S5、模型声明同步、收敛同步 |
| `replan.ts` | 636 | 重规划：buildPatch / computeImpact / decideApprovalLevel / applyPatch |
| `tools.ts` | 956 | 9 个图工具的 schema 与 handler |
| `invariants.ts` | 463 | I1–I7 不变量（I2 降级、I7 仅 warn） |
| `plan-sync.ts` | 466 | **planItem ↔ graph 唯一桥** |
| `migrate.ts` | 439 | v0.29 扁平清单 → 图迁移 |
| `converge.ts` | 357 | 收敛：AC 覆盖 / 未建模工作 / 僵尸任务 / 失效假设 |
| `write.ts` | 464 | 写原语 |
| `events.ts` | 300 | E1–E9 九类触发条件判定 |
| `drift.ts` | 305 | 漂移评分（NORMAL 0.7 / SOFT 0.4 / HARD_STREAK 2） |
| `gate.ts` | 280 | 图写入门禁（hook 注册 + I1–I7） |
| `project.ts` | 326 | 活跃窗口投影三档（锚点 200 / 窗口 800 / 工具后 60，总计 1200） |

### 与 PlanItem 的唯一桥（`plan-sync.ts`）

```
planItemId ──(隐式不变量 planItemId === nodeId)──▶ nodeId
  → applyStatusChange()（唯一状态写入原语，含 I1–I7）
  → persist()（唯一副作用出口：落盘 + 广播 + 重算镜像）
```

11 态 → 6 态映射（`store.ts:471-492`）：`verifying`/`needs_human`/`in_progress` 都映射为 `running`（**绝不让镜像显示成 done**）。

---

# 7. 记忆体系

## 7.1 四层

| 层 | 实现 | 存储 | 写入时机 |
|---|---|---|---|
| **L1 工作记忆** | `l1-working.ts` / `l1-repair.ts` | `.arkwork/memory/{taskId}/l1.jsonl` | 每轮 Reason/Act/observation |
| **L2 文件记忆** | `l2-file.ts` / `l2-memory.ts` | 产物 `{taskDir}/.arkwork/steps/{stepId}.json`；压缩态 `l2-memory.json` | 工具结果 >4KB 落盘 |
| **L3a 策展** | `l3-curated.ts` | `.arkwork/memory.md` / `user.md` / `memory.pending.jsonl` | 「记住：…」进 pending，**run 启动时合并生效** |
| **L3b 档案** | `l3-archive.ts` | `.arkwork/archive/items.jsonl` + `index.json` | 任务 done 时归档完整 L1 |
| **L4a 画像** | `l4-profile.ts` | `.arkwork/profile.json` | 任务 done 时合成，保留 10 版 |

**L2 去重**：实体集合 **Jaccard > 0.3** 即合并。
**L3b 检索**：MiniSearch，`fields=['content','taskTitle']`，权重 `{content:2, taskTitle:3}`，snippet 截断 500 字符。

## 7.2 上下文压缩（`compaction.ts`，611 行）

对齐 Claude Code 的「四级阈值 + 两阶段」：

| 常量 | 值 |
|---|---:|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 |
| `WARNING_BUFFER_TOKENS` | 20,000 |
| `BLOCKING_BUFFER_TOKENS` | 3,000 |
| `KEEP_TOKENS` | 15,000 |
| `PRUNE_PROTECT` | 40,000 |
| `PRUNE_MINIMUM` | 20,000 |
| `MAX_SUMMARY_TOKENS` | 4,000 |

两阶段：
1. **pruneStage**：倒序扫描，保护最近 40k tokens 的工具输出；只有节省 ≥20k 才执行
2. **sliceRecentContext**：保留最近 15k，**切片边界回退到轮次边界**；`user_message` 永不归档
3. **summarizeStage**：六段式模板（Objective / Important details / Completed and active work / Blockers / Next moves / Relevant files），LLM 失败降级为本地抽取式摘要

熔断：连续失败 3 次 → `autoCompactDisabled=true`。

> ⚠️ **三套压缩阈值并存**，见 §14.5。

## 7.3 蒸馏 → 技能（skill-forge）

v0.25.0 F3 后：**L1 不再是蒸馏源，L2 步骤产物是唯一合法候选证据**（必须 ≥1 条）。只在 **task-done** 时机评估。

### 五阶段管线（`skill-forge.ts:548-597`）

| 阶段 | 函数 | 行为 | 失败出口 |
|---|---|---|---|
| ① 候选发现 | `discoverSkillCandidates` | `listRawL2(taskId)`，无产物 → null | 终止 |
| ② 价值评估+起草 | `judgeSkillValue` | **一次 LLM 调用**同时产出双条件判定与 SKILL.md 全文 | 终止 |
| ③ 完整性校验 | `verifySkillIntegrity` | 9 项闸门（纯函数 + 一次 discovery） | 进隔离区 |
| ④ 注册 | `registerForgedSkill` | 落盘 `{arkworkDir}/skills/{id}/` | 进隔离区 |
| ⑤ 隔离区 | `quarantineSkill` | `skills-quarantine/{id}/`，保留最新 20 条 | — |

**双条件**（缺一不可）：`reusable`（跨任务可复用）+ `effective`（证据含闭环信号）。

**九项闸门**：frontmatter-valid / body-nonempty（≥200字）/ structure-complete / discoverable / no-conflict / no-near-duplicate（Jaccard ≥0.6 拒）/ not-generic / no-refusal / forge-budget（上限 **12** 个蒸馏技能）。

### 触发门槛（`distill.ts:36-45`）

```
topicObservations: 10 条     l2Count: 50      l2Bytes: 1MB      ttlDays: 7
```

## 7.4 各层阈值汇总

| 阈值 | 值 | 位置 |
|---|---:|---|
| L3a memory.md 字符预算 | 2200 | `l3-curated.ts:27` |
| L3a user.md 字符预算 | 1375 | `l3-curated.ts:28` |
| L3a+L4a 注入硬顶 | ≤2000 tokens | `memory-hooks.ts:117` |
| L4a synthesis 字符预算 | 1800 | `l4-profile.ts:37` |
| L4a 历史版本保留 | 10 | `l4-profile.ts:39` |
| L2 合并 Jaccard | 0.3 | `l2-memory.ts:24` |
| L3b 索引落盘防抖 | 800ms | `l3-archive.ts:37` |
| 蒸馏技能上限 | 12 | `skill-forge.ts:242` |

---

# 8. 扩展体系

## 8.1 四套扩展机制并存

| 机制 | 是什么 | 能否给模型能力 | 作用域 |
|---|---|---|---|
| **Skill** | 内置工具 / MCP 工具 / 指令型技能 | ✅ | project > user > bundled > runtime |
| **MCP** | 外部 stdio server 的工具 | ✅（转 Skill） | 全局（app 级） |
| **Profile** | 工作台配置（Agent + 能力 + UI 声明） | ✅ 仅 skill 类能力 | 全局激活一个 |
| **Plugin** | 声明式面板 / 代码插件 | ✅（v0.35.0 起） | bundled < global < workspace |

> 这四套机制**语义高度重叠**——都能「给 Agent 加能力」，但接入路径、作用域、生命周期各不相同。这是重构时的核心收敛候选（见 §15）。

## 8.2 Profile / 插槽体系

### 九类插槽（`shared/types/profile.ts:22-43`）

```
agent | tool | ui.panel | ui.renderer | ui.action | ui.homeModule | ui.theme | data | auto
```

`SlotEntry`：`{ id, kind, label, source?:'builtin'|'profile'|'plugin', payload, position? }`

### 注册规则（`profile/slots.ts:71-122`）

- 同来源同 id 重复 → **throw**（不静默覆盖）
- 已有 builtin + 新来 profile/plugin → **允许覆盖**并触发 `notifyConflict`；dispose 时恢复 builtin
- 已有非 builtin → throw

### 激活流程（`activator.ts:514-662`）

```
① 取 manifest → ② 解析继承链（extends，深度 ≤2，禁环）
→ ③ 合并（根到叶逐层 mergeProfile）
→ ④ 引用闭合校验（V1–V6）
→ ⑤ 五层装配（agents / tools / ui / data / auto）
→ ⑥ 任一 blocking 降级 → 激活失败
→ ⑦ 提交（清 profile 来源槽 → 注册 → 存快照 → 写 activeProfileId）
   └─ 事务回滚：提交阶段抛错 → 把上一个 profile 重新装配挂回
```

### 三个内置工作台

| id | 名称 | Agent | 关键差异 |
|---|---|---|---|
| `wb.base` | 通用工作台 | `@default` | 无能力声明，命名空间 `default` |
| `wb.coding` | 代码开发 | `@coder` | spec/plan/bugfix/grep；dockTabs=[files,terminal,todos,context,browser]；chips ['继续任务','修 bug','写测试'] |
| `wb.research` | 研究工作台 | `@researcher` | web-search/fetch-url/kb-search；homeModule='kb' |

### Profile → 模型工具的串联

```
activateProfile → saveLastSnapshot（layers.tools[] 含 {kind, ref, found, required}）
  → assembleTools（只取 kind==='skill' && found，叠加不删减）
  → skillToLlmTool → LlmTool
```

> ⚠️ Profile 的 `mcp` 能力**只登记不汇入**；`auto` 层**只登记不注册**（恒产一条降级记录）。

## 8.3 插件体系（v0.35.0 重头戏）

### 架构：三层 + 两半

```
registry（磁盘态：扫描/校验/启停/贡献点转插槽）
   ↓
host-service（组合根：唯一知道「插件进程」存在的地方）
   ↓
supervisor + gateway（进程态：utilityProcess + 能力网关）
   ↕ 线协议 wire.ts
Host 半（utilityProcess 子进程）     Client 半（iframe sandbox）
```

### 进程模型与生命周期

- 每插件一个 `utilityProcess.fork(entryPath, [], { serviceName: 'arkwork-plugin:<id>' })`
- 阶段：`host/prepare`（5s）→ `host/activate`（5s）→ `host/tool-call`（30s）→ `host/dispose`（3s）
- **无自动重启**：未捕获异常第 1 次只置 `phase='error'`，≥2 次才 kill；一次成功调用即清零
- **事实上的按需重建**：进程条目被删后，下次调用会重新 spawn
- 心跳 3s，连续缺失 3 次判死（有在途调用时跳过）

### 能力网关（17 个 cap）

| cap | 需要权限 | 语义 |
|---|---|---|
| `log` / `workspace.root` | 无 | 日志 / 路径 |
| `fs.read` / `fs.list` | `fs:workspace-read` | 工作区内读 |
| `fs.write` | `fs:workspace-write` | 工作区内写 |
| `net.fetch` | `net` | 主进程代发 HTTP |
| `shell.run` | `shell` | execFile，30s / 4MB |
| `tools.register` / `unregister` | `tools.register` / **无** | 注册模型工具（须先声明） |
| `views.register` / `unregister` | `views.register` / **无** | 注册 iframe 视图 |
| `panels.register` / `unregister` | `panels.register` / **无** | 注册面板 |
| `storage.get/set/delete` | `storage` | 插件私有 KV（256KB 配额） |
| `renderer.post` | 无 | 往自己 Client 半推消息 |

三条规则：① **默认拒绝**（permissions 缺省 = 什么都不给）；② **撤销永远放行**（否则关权限后卸载卡死）；③ **路径永远经工作区断言**。

### 视图隔离

- 自定义协议 `arkwork-plugin://`，两条边界：**目录收口**（realpath 双向校验，越界回 404 不回 403）+ **CSP `connect-src 'none'`**（Client 半拿不到直连网络，必须回 Host 半走网关）
- iframe `sandbox="allow-scripts"` —— **刻意不给 `allow-same-origin`**，有回归测试钉死

### 三级作用域

| 来源 | 目录 |
|---|---|
| `global` | `{userData}/arkwork-data/plugins/<dir>/plugin.json` |
| `workspace` | `<workspace>/.arkwork/plugins/<dir>/plugin.json` |
| `bundled` | **无独立目录** —— 落盘在 global 目录内，按 `isSamplePlugin(id)` 判定 |

**覆盖规则**：`PLUGIN_SOURCE_ORDER = ['bundled','global','workspace']`，**同 id 整份覆盖，不做字段级 merge**（对齐 dsh patch 的 last-write-wins）。

### 可逆 effect 账本（取代旧机制）

v0.34.x 的卸载是「`refreshPluginSlots()` 清 plugin 来源 → 重注册」——**靠枚举来源撤销，而不是记住自己注册过什么**，漏一种来源就留静默残留。

新机制两份账：插件侧账（`host/dispose` 时逆序撤）+ 宿主侧账（`revokeAll(pluginId)` 逆序撤）。`kind` 取值：`slot` / `tool` / `view` / `view-session`。

**`kinds` 过滤是关键**：`refreshPluginSlots` 只撤 `'slot'`，否则会造成「插件进程以为注册着、宿主侧已忘了」的状态分叉。

### 插件贡献的真实消费矩阵 ⭐

| 贡献 | 真实消费者 | 结论 |
|---|---|---|
| `provides.panel` / `panels` | `PanelHost` → Inspector | ✅ **真消费** |
| `provides.views` | `PluginViewHost` → Inspector / 浮窗 | ✅ **真消费** |
| `provides.tools` | `declaredTools()` → `assembleTools` → 模型工具表 | ✅ **真消费（双向打通）** |
| `provides.theme` | `themeOverrides` → `applyResolvedTheme` | ✅ **真消费** |
| `provides.renderer` | 仅 `DiagnosticsView` 展示（`detectRenderer` 三处调用都不传） | ⚠️ **只登记** |
| `provides.homeModule` | `CenterStage` 诚实占位不渲染 | ⚠️ **只登记** |
| `provides.action` | 仅 `DiagnosticsView` 列举 | ⚠️ **只登记** |
| 运行期 `panels.register` | `this.panels` **只写不读** | ❌ **写入即丢弃** |
| 权限 `model.invoke` | 白名单里有，无任何实现 | ❌ **声明未实现** |

### 插件 ↔ 模型：双向已打通（v0.35.0 D73）

**方向 A：插件给模型提供工具** —— 用**清单声明**而非运行期注册。理由：插件懒激活，用运行期注册会造成「看不见 → 不调用 → 不激活 → 仍看不见」的死锁。照抄 VS Code 分工：**看见靠声明，能调靠激活**。

**方向 B：模型控制插件** —— 4 个宿主工具 `plugin_list / plugin_detail / plugin_set_enabled / plugin_open_view`，在插件坏了/没激活/被禁用时**照样能用**（这是诊断的前提）。

## 8.4 技能分层与渐进披露

```ts
SkillLayer = 'project' | 'user' | 'bundled' | 'runtime'
LAYER_PRECEDENCE = ['bundled', 'user', 'project', 'runtime']   // 近层遮蔽远层
```

| 层 | 目录 |
|---|---|
| project | `{workspace}/.arkwork/skills/` |
| user | `{arkworkDir}/skills/` |
| bundled | 代码内置 |
| runtime | 非磁盘 —— 已连接 MCP server 的 tools |

**渐进披露**：列表阶段不读 SKILL.md（只读 `skill.json`）；invoke 时按需加载全文写入 `ctx.additionalSystemHint`。

**指令模式三态**：取值优先级 `frontmatter.instructionMode ?? skill.instructionMode ?? 'on-demand'`

| 模式 | 处理 |
|---|---|
| `always-on` | run 启动时读全文包成 **agent-static** 契约段（命中前缀缓存）；invoke 时跳过注入 |
| `on-demand` | invoke 时注入 L1 `skill_instruction`，**持续生效至任务结束** |
| `hint-only` | **不注入指令体**，仅 description 进工具列表 |

## 8.5 MCP

零依赖 JSON-RPC 2.0 stdio 客户端（不引 `@modelcontextprotocol/sdk`）。

| 常量 | 值 |
|---|---:|
| `HEARTBEAT_INTERVAL_MS` | 30,000 |
| `REQUEST_TIMEOUT_MS` | 30,000（callTool 用 ×2 = 60s） |
| `INIT_TIMEOUT_MS` | 15,000 |

- 协议版本 `2024-11-05`
- 多 server 并发，每个一个子进程 + 独立心跳；心跳失败 → 尝试重连一次
- 进程退出：`SIGTERM` → 500ms 后 `SIGKILL`
- 连接/断开都 `invalidateSkillCache()`，让 `listSkills()` 重新注入

---

# 9. 渲染层架构

## 9.1 骨架

```
App.tsx
├─ TopBar（48px：工作区识别 / 居中搜索 / 工作台切换 / 设置）
├─ Sidebar（240px，64–320 可拖）| CollapsedSidebar（64px 图标栏）
├─ CenterStage（模块页 / 首页模块 / 打招呼 / 任务对话 四路分流）
├─ Inspector（44px 竖栏 + 280–480 面板）
├─ PreviewWindow（浮窗：拖拽 + 8 向缩放 + 最小化胶囊）
├─ QuickAction / QuickOpen / ToastLayer / ConfirmDialog / ToolConfirmLayer
├─ Editors / OnboardingLayer / HelpCenter / StatusBar
└─ EscPauseDialog（条件）
```

**Inspector 是插件面板的正确宿主**（历史上 `RightDock.tsx` 曾是死组件，现已移除）。竖栏三层拼接：`builtinTabsOf(visibleBuiltin)` → `mergePanelOrder(profilePanels)` → `mergePanelOrder(pluginViews)`。高度不足时折叠进「更多」Portal 弹层。

## 9.2 组件清单

| 目录 | 数量 | 内容 |
|---|---:|---|
| `components/`（根） | 33 | TopBar / Sidebar / CenterStage / Inspector / Composer / Markdown / HelpCenter / RunConsole … |
| `components/flow/` | 25 | 交互区：TurnList / TurnView / StepView / 9 个 Block / 6 种工具卡 |
| `components/dock/` | 7 | TaskPanel / TodoPanel / ContextPanel / BrowserPanel / TerminalPanel / BugfixIsland / ProgressPanel |
| `components/panels/` | 10 | Abilities / Skills / Agents / Automations / Kb / Memory / Plugins / Files / Tasks / Market |
| `components/graph/` | 8 | TaskPanel 子组件：DagView / NodeRow / EvidenceDrawer / ActionCards / PlanApprovalCard |
| `components/preview/` | 9 | PreviewWindow + 8 种渲染器 |
| `components/editor/` | 8 | CodeMirror 6 内核 |
| `components/workbench/` | 6 | ProfilesView / ProfileEditor / DiagnosticsView / ImportDialog / ActivationReportView |
| `components/right/` | 2 | LogsView / StepList |
| `components/plugins/` | 1 | PluginViewHost |
| `components/vlib/` | — | 白名单组件库（10 个）+ PanelHost |
| `components/BrowserChrome/` | 5 | 浏览器 chrome |

## 9.3 状态中枢（store/，24 文件）

单 Zustand store，11 个 slice 平铺 + `init` + `subscribeAll`：

| slice | 负责 |
|---|---|
| `uiSlice` | 布局折叠、面板 Tab、浮窗、主题、语言、交互区视图偏好 |
| `feedbackSlice` | toast / 确认弹窗 / 上下文 chip |
| `tasksSlice` | 任务列表、选中、PlanItem 乐观更新、工作区 |
| `conversationSlice` | 步骤流、流式缓冲、对话派生、日志 |
| `kbMemorySlice` | 知识库、记忆、自动化、上下文用量 |
| `catalogSlice` | Agent / 技能 / MCP / 模型目录 |
| `marketSlice` | 技能市场 |
| `permissionSlice` | 权限模式与规则 |
| `fsSlice` | 文件树、编辑器文档、冲突 |
| `profileSlice` | 工作台快照与插槽派生 |
| `pluginSlice` | 插件注册表与运行期状态 |

**`subscriptions.ts` 是 Main → Renderer 事件推送的唯一挂载点**（18 条 unsub）。通道包括：`permission:mode-changed` / `task:step` / `task:text-delta` / `task:status` / `task:plan-item-status-changed` / `task:plan-list-snapshot` / `browser:load` / `task:progress` / `task:progress:clear` / `task:event`（14 种 type 内部分发）/ `tool:confirm` / `memory:changed` / `log:append` / `profile:changed` / `plugin:changed` / `plugin:runtime-changed` / `plugin:view-open-request` / `theme:system-changed`。

> ⚠️ **混合模式**：`graph:update`（3 处）、`kb:changed`、`bugfix:progress`、`browser:tab-host-changed` 由组件各自订阅；`fs:batch` **无任何订阅者**。

## 9.4 对话流渲染

```
ConversationItem[]（derive-conversation.ts 产出）
  + ReActStep[] + SessionEvent[] + streamBuffers + planItems + viewMode
  → flow/project.ts（618 行纯函数，投影）
  → FlowTurn[] → TurnView → StepView → BlockRenderer → 9 种 Block
```

**四种展示层次**（D21 交互区层次纪律）：

| 层次 | Block | 视觉规格 |
|---|---|---|
| 主内容 | user / say / answer / plan / approval | 14px，`--text-primary`，可选中 |
| 思考 | reasoning | 13px，`--text-tertiary` + 左侧 2px 竖线 |
| 工具 | tool（6 种卡） | 12px，卡片 + 左 2px 状态条；六态（guarded 琥珀 ≠ failed 红） |
| 元信息 | notice / error + TurnHeader/Footer | 11px；notice 用**中性色非红色** |

## 9.5 编辑器（CodeMirror 6）

- **全仓仅 `components/editor/` 可 import `@codemirror/*`**，且必须懒加载
- 13 种语言注册名（v0.31.1 起**静态 import**，Windows asar 下动态 import 会静默失败导致全语言退化）
- 两个 Compartment：`languageCompartment`（语言热替换）、`readOnlyCompartment`（原位 reconfigure 不重建实例）
- **保存管线**：CAS 冲突检测（`expectedDiskHash`）+ 编码三件套原样回传 + tmp+rename 原子写
- **绝不自动合并 / 绝不自动覆盖**（J3），由 `ConflictBanner` 三选一
- 七种只读原因：`deleted / outside-workspace / binary / too-large / permission / agent-writing / non-utf8`
- **文本不进 store**（J12）：存模块级 Map，切 Tab 时恢复撤销栈

## 9.6 键位系统（三层）

```
spec.ts（声明层，25 条，零 import，可入 node:test）
   ↓
actions.ts（处理层，依赖 store/IPC；Record<KeymapId,…> 让「声明了没实现」在 typecheck 失败）
   ↓
bindings.ts（装配）→ registry.ts（分发：when 全满足 + priority 降序 + 返回 false 继续冒泡）
```

- 调用点**只有一处**：`App.tsx:80-97`（禁止组件内自行 addEventListener）
- 已注册 25 条：global 17 / inspector 6 / help 2
- **Esc 9 级优先级关闭链**（priority `-100`）
- 预留 `RESERVED_CHORDS` 33 条；新增键位撞表 → 测试当场失败

## 9.7 i18n

4 语言（zh/en/ja/ko），各 **2971 行** JSON，**54 个顶层命名空间**，静态打包（离线可用）。
纪律：**label 常量只存 i18n key**，渲染处 `t(label)` 取值（模块级急切翻译会导致语言切换后不更新）。

---

# 10. IPC 与跨进程契约

## 10.1 `window.ark` API（25 个命名空间 + 1 标量）

| # | 命名空间 | 主要方法 |
|---:|---|---|
| 1 | `task` | list/get/create/update/delete/run/pause/resume/cancel/appendMessage/listSteps + 8 个订阅 + PlanItem 操作 |
| 2 | `bugfix` | onProgress / getMode / setMode |
| 3 | `agent` | CRUD + manualOverride |
| 4 | `skill` | CRUD + toggle + import/export + readInstruction |
| 5 | `mcp` | CRUD + connect/disconnect/callTool |
| 6 | `market` | 16 个（search/install/uninstall/detail/review/收藏/多源/CLI） |
| 7 | `permission` | getMode/setMode/resolveRules/addRule/onModeChanged |
| 8 | `model` | CRUD + test |
| 9 | `automation` | CRUD + run |
| 10 | `kb` | list/add/remove/import/search/setEnabled + 订阅 |
| 11 | `memory` | 25 个（L1–L4 全操作 + 蒸馏转化 + 档案检索） |
| 12 | `context` | estimate/getBreakdown/removeItem/clearCategory |
| 13 | `fs` | 26 个（读写/监听/探针/产物目录） |
| 14 | `log` | list + onAppend |
| 15 | `graph` | 17 invoke + 1 订阅（全部 `GraphResult<T>` 包络） |
| 16 | `browser` | onLoadRequest / resolve |
| 17 | `browserTabs` | create/close/activate/navigate/setBounds/list/detach/attach |
| 18 | `settings` | get/set/getSecret/setSecret/pickWorkspace/activateWorkspace |
| 19 | `profile` | 13 个（list/activate/snapshot/validate/import/export/slots…） |
| 20 | `panel` | fetch |
| 21 | **`plugin`** | 插拔 7 + 运行期 3 + 视图桥 6 + 作者工具 2（见下） |
| 22 | `theme` | apply / getSystemTheme / onSystemChange |
| 23 | `platform` | **标量** `process.platform`（`IS_MAC` 唯一判定源） |
| 24 | `confirm` | onRequest / respond |
| 25 | `window` | minimize/toggleMaximize/close/isMaximized |
| 26 | `route` | classify |

### `ark.plugin.*` 控制面（四组）

| 组 | 方法 |
|---|---|
| 插拔 | `list` / `setEnabled` / `uninstall` / `rescan` / `openDir` / `exportSample` / `onChanged` |
| 运行期 | `runtimeStatus` / `views` / `onRuntimeChanged` |
| 视图桥 | `viewOpen` / `viewClose` / `viewCall` / `viewEvent` / `onViewPost` / `onViewOpenRequest` |
| 作者工具 | `scaffold` / `migrateCheck` |

> `viewCall` 在 preload 先过白名单 `PLUGIN_VIEW_METHODS` 给作者早期反馈，但注释明说**这不是安全边界**（沙箱 Client 半可绕过 preload 直发 IPC），真正边界在 main 侧。

## 10.2 IPC handler（26 个领域 + 1 注册入口）

| 分组 | handler |
|---|---|
| 核心域 | task(11) / agent(6) / skill(8) / memory(25) / fs(26) / settings(6) / model(5) / theme / window / log |
| 扩展域 | mcp(8) / market(16) / knowledge(9) / automation(5) / browser-tabs(11) |
| 引擎侧 | router / permission(4) / context(4) / progress(2) / plan-items(4) / tool / bugfix |
| 新体系 | graph(18) / profile(13) / plugin(14) / panel(1) |

**约定**：失败不抛（除编程错误），一律返回 `{ok:false, reason}`；handler 只做「参数校验 + 调用领域服务 + 返回/广播」。

---

# 11. 数据持久化布局

```
{userData}/arkwork-data/              ← 应用级（跨工作区）
  ├─ models.json                      模型配置
  ├─ agents.json / skills/            智能体与技能
  ├─ automations.json                 自动化
  ├─ mcp-servers.json                 MCP 配置
  ├─ profiles.json                    工作台
  ├─ settings.json                    全局设置
  ├─ plugins.json + plugins/          插件（启停 + 全局插件）
  └─ plugin-storage/<id>.json         插件私有 KV

{workspace}/                          ← 工作区级
  ├─ .arkwork/                        ← 全部内部数据，文件树整体隐藏
  │   ├─ tasks.json                   任务索引
  │   ├─ tasks/{taskId}/              任务产物 + steps/
  │   ├─ memory/{taskId}/l1.jsonl     L1 工作记忆
  │   ├─ memory.md · user.md          L3a 策展
  │   ├─ archive/                     L3b 档案
  │   ├─ profile.json                 L4 画像
  │   ├─ kb/                          知识库（kb.json + chunks.jsonl + files/ + index.json）
  │   ├─ checkpoints/{taskId}.json    检查点（≤30）
  │   ├─ skills/ · plugins/           工作区级技能与插件
  │   ├─ specs/ · documents/          spec/plan 产物
  │   ├─ logs/ · history/ · cache/ · temp/
  │   └─ settings.json · settings.local.json
  └─ （用户业务文件）
```

**持久化底座（`store/db.ts`）三种原语**：

| 原语 | 用途 | 并发保护 |
|---|---|---|
| `JsonCollection<T>` | 单文件 JSON 数组 | **互斥 Promise 链**串行化 read-modify-write |
| `JsonDoc<T>` | 单文件 JSON 对象 | read/write/patch |
| `JsonlCollection<T>` | JSONL 行存储 | 互斥链 + `mutate(fn)` 锁内读-改-写 |

**原子写**：`writeFile(tmp = path.{4字节hex}.tmp)` → `rename`（POSIX rename 原子）。

> ⚠️ **无文件锁、无 WAL** —— 并发保护只在单进程内有效，跨进程/跨窗口无效。

---

# 12. 端到端数据流（一次任务）

```
Composer 输入
  → route:classify（纯规则 ≤5ms 分流 chat / task）
  → runner.runTask（AbortController + generation 防旧循环污染）
      → runReActLoop
          ① run-setup：注入 system_prompt / 记忆 / 建图 / 消费门禁
          ② 每轮：
             ├─ assembleTools（agent ∪ task ∪ profile ∪ mcp ∪ plugin，按名排序）
             ├─ assembleMessages（L1 投影 + 降噪 + 预压缩）
             ├─ llm/registry → 适配器（流式）→ 增量泵（40/80ms 自适应窗口）
             │    → task:text-delta → 渲染层流式缓冲
             ├─ 工具调用：tool-pipeline（pre 权限 → execute → post 摘要）
             │    → 失败 → fault-tolerance 五档链路
             │    → 大结果 → persistRawL2
             ├─ appendL1（每轮）
             ├─ 超阈值 → compaction（prune + summarize）
             └─ saveCheckpoint + maybeAutoCompress
          ③ 终止 → sealGraph → 落盘 → 广播
      → runDoneMemoryHooks
           ├─ L3b archiveTaskL1
           ├─ L4a synthesizeFromTaskL1
           ├─ distill.evaluateDistillTrigger → autoPromoteDistill
           └─ skill-forge.runForSkillForge
```

**双向契约**：`invoke` 走请求-响应（用户动作），`send` 走事件推送（引擎状态）。所有推送在 `subscriptions.ts` 收口。

---

# 13. 关键阈值速查表

| 类别 | 常量 | 值 | 位置 |
|---|---|---:|---|
| 循环 | MAX_ITERATIONS | 200 | `loop.ts:156` |
| | MAX_PER_SIGNATURE | 5 | `loop.ts:165` |
| | MAX_PER_TOOL_DEFAULT / READONLY | 400 / 600 | `loop.ts:166-167` |
| | MAX_ALL_EXHAUSTED_ROUNDS | 3 | `loop.ts:179` |
| | MAX_STALLED_ROUNDS | 6 | `stall.ts:22` |
| | MAX_COMPLETE_REFUSALS | 2 | `turn-end.ts:42` |
| 上下文 | MAX_REASONING_CONTENT | 1500 字符 | `context.ts:98` |
| | MAX_OBSERVATION_CONTENT | 8000 字符 | `context.ts:101` |
| | contextBudget | `min(128000, cw??64000) × 0.85`，clamp [24000, 64000] | `context.ts:77-80` |
| | outputReserve | 4096 | `context.ts:83` |
| | RECENT_TOOL_TURNS | 3 | `context.ts:110` |
| 压缩 | AUTOCOMPACT / WARNING / BLOCKING buffer | 13k / 20k / 3k | `compaction.ts:32-42` |
| | KEEP_TOKENS | 15k | `compaction.ts:37` |
| | PRUNE_PROTECT / PRUNE_MINIMUM | 40k / 20k | `compaction.ts:38-39` |
| | 手动压缩预算 / 告警比例 | 16000 / 0.8 | `compaction-hook.ts:39-42` |
| LLM | 调用超时 | 120s | `llm-call.ts:86` |
| | 重试退避 | [500, 2000] | `llm-call.ts:14` |
| | 影响分析超时 | 10s | `impact-analyzer.ts:20` |
| | Router LLM 超时 | 8s（双保险） | `route-agent.ts:73-75` |
| 容错 | 退避 / 最大尝试 | [1000,2000,4000] / 3 | `retry-with-backoff.ts:16-17` |
| | 决策注册清理 | 30 分钟 | `notify.ts:85` |
| MCP | 心跳 / 请求 / 握手 | 30s / 30s(×2) / 15s | `mcp/client.ts:44-46` |
| 文件 | 只读上限 | 20MB | `fs/text.ts:40` |
| | 监听批次窗口 / ready 超时 | 200ms / 15s | `fs/watch.ts:35,47` |
| | 自写抑制 TTL | 500ms | `fs/write.ts:34` |
| | 清理周期 / 保留天数 | 24h / 7 天 | `fs/cleanup.ts` |
| 浏览器 | 元素快照上限 / 打开超时 | 200 / 20s | `controller.ts:42-47` |
| 插件 | prepare / activate / tool-call / dispose | 5s / 5s / 30s / 3s | `wire.ts:292-299` |
| | 心跳间隔 / 判死 | 3s / 缺失 3 次 | `wire.ts:303-304` |
| | 崩溃容忍 | 第 2 次才 kill | `supervisor.ts:442-455` |
| | 存储配额 | 256KB | `host-runtime.ts:159` |
| 记忆 | L2 合并 Jaccard | 0.3 | `l2-memory.ts:24` |
| | 蒸馏技能上限 | 12 | `skill-forge.ts:242` |
| | 近似重复 Jaccard | 0.6 | `skill-forge.ts:239` |
| | 路由：chat 长度上限 | 80 字符 | `classify-route.ts:86` |
| | 路由：判定延迟目标 | 5ms | `classify-route.ts:88` |

---

# 14. 架构债与断裂点 ⭐

> 这一章是重构的**优先级清单**。每条都带证据。

## 14.1 🔴 P0：代码插件运行期的三处断点

### P0-1：Host 半启动标志从未注入 → 代码插件很可能跑不起来

**证据链**：
1. `wire.ts:320` 定义 `HOST_ENV_FLAG = 'ARKWORK_PLUGIN_HOST'`
2. `host-entry.ts:65-70` —— `isHostChildProcess()` 判 `process.env[HOST_ENV_FLAG] === '1'`，为真才 `bootstrap()`
3. `supervisor.ts:53-56` —— `utilityProcess.fork(entryPath, [], { serviceName, stdio:'pipe' })`，**未传 `env`**
4. `supervisor.ts:26` import 了 `HOST_ENV_FLAG` 但**全文件仅出现 1 次**（即 import 行，从未使用）
5. 全仓 `grep ARKWORK_PLUGIN_HOST` **只有 `wire.ts:320` 一处**，无任何赋值点

**推论**：子进程继承父进程 env（父进程从未设置该变量）→ `isHostChildProcess()` 恒 false → Host 半不 bootstrap → `host/prepare` 5s 超时 → **所有有 `main` 的代码插件 `activation-failed`**。

**与既有记录的关系**：`docs/BACKLOG.md` L-35-01 记录实机冒烟「插件面板渲染真实行情」已通过——这与本条**不矛盾**：示例插件 `ark.plugin.stock` 是**声明式面板**（走 `PanelHost` + 白名单组件，不需要 Host 进程）。**代码插件路径从未被实机验证过**。

**这是典型的「函数全对、接线缺失」** —— 与 v0.35.0 已修的 D79（`setHostVersion()` 只有定义无调用点）**完全同型**，说明接线契约的验证方式仍存在系统性盲区。

### P0-2：插件 `net.fetch` 是空壳

- `host-service.ts:546-552`：`deps().fetch = this.opts.fetch ?? (async () => ({ status: 0, headers: {}, body: '' }))`
- `bootstrap.ts:65-68` 调 `initPluginHostService({ entryPath, broadcast })` —— **未传 `fetch`**
- 后果：插件 `ctx.ark.net.fetch` 与 Client 半 `data.request` **永远返回 status 0 / 空 body 且「成功」**（静默）
- 讽刺点：`ipc/panel.ts:70 pickFetch()` 已修好选栈（必须走 `net.fetch`，Node 全局 fetch 不读系统代理），**插件网关没复用这条选栈，而是干脆没注入**

### P0-3：看门狗与空闲回收从未启动

- `supervisor.ts:529 startWatchdog()` / `:407 startIdleSweeper()` —— 调用点**只在测试文件**
- 后果：Host 半照发心跳、supervisor 照记 `lastBeatAt`，但**没有任何定时器去判死**；插件死循环不会被回收

### 其他插件侧断点

| 项 | 状态 |
|---|---|
| `supervisor.emit()`（host/emit） | 无生产调用点 → 插件 `ctx.on('workspace:changed', …)` 注册成功但**永不被调用** |
| `host-service.this.panels` | **只写不读** → 运行期 `panels.register` 是黑洞 |
| 权限 `model.invoke` | 白名单里有，无任何实现 |
| `PluginHostService.shutdown()` | 未撤宿主侧账本（与 `disposePlugin` 不对称） |

## 14.2 🟠 插件/Profile 插槽：4 类贡献只登记不消费

| 插槽 | 状态 | 证据 |
|---|---|---|
| `ui.renderer` | 派生了 `rendererOverrides`，但 `detectRenderer(path)` 三处调用都不传 | `uiSlice.ts:318` / `fsSlice.ts:168` / `PreviewWindow.tsx:181` |
| `ui.homeModule` | `CenterStage.tsx` 诚实占位不渲染（显示「仅登记」提示） | `CenterStage.tsx:428-440` |
| `ui.action` | 仅 `DiagnosticsView` 列举，UI 上无处可点 | — |
| profile `mcp` 能力 | 声明不产生任何工具（只进降级报告） | `activator.ts:264-284` |
| profile `auto` 层 | **只登记不注册**，恒产一条降级记录 | `activator.ts:477-494` |
| `profileDockTabs` | 死字段，写入后无读取 | `profileSlice.ts:181` |

> 另有 `data.kind === 'mcp'` 面板数据源**未接线**（诚实报「未接线」，绝不回落 static 假数据 —— 这点做得对）。

## 14.3 🟠 结构性问题

| # | 问题 | 证据 |
|---|---|---|
| 1 | **四套扩展机制语义重叠** | Skill / MCP / Profile / Plugin 都能「给 Agent 加能力」，但接入路径、作用域、生命周期各异 |
| 2 | **三套并行的「任务进展」表示** | PlanItem（6 态派生镜像）、TaskGraph（11 态真源）、progress（进度摘要）各自有状态与广播 |
| 3 | **两套压缩阈值** | `compaction.ts` 用模型窗口公式；`compaction-hook.ts` 用固定 16000 + 80%；`maybeAutoCompress` 又读 `getMemoryConfig().compressThreshold` |
| 4 | **两套重试退避** | `fault-tolerance`（1s/2s/4s，3 次）vs `agent/llm-call.ts`（500ms/2s，2 次），错误分类正则不同 |
| 5 | **两套 shell 风险模型** | `permissions.ts:51-66`（5 级）vs `shell-risk.ts:31-48`（3 级） |
| 6 | **受保护路径正则两份** | `permissions.ts:183-198` 与 `skills/file-tool-safety.ts:22-36` 手工复制，注释称「保持一致」 |
| 7 | **循环依赖靠动态 import 绕** | `registry → graph/tools → graph/store → store/tasks → agent/events → window → runner → registry`；只能用延迟注册绕开 TDZ |
| 8 | **记忆命名空间只建目录未改落盘路径** | `profile/namespace.ts` 建了 `core/` 与 `ns/<name>/`，但 L3/L4 落盘仍是单一 `.arkwork/`（模块注释自己标注） |
| 9 | **KB 索引双重编码** | `kb/index.ts:197` 对 `engine.toJSON()`（已是字符串）又 `JSON.stringify` 一次 |
| 10 | **跨进程并发无保护** | `JsonlCollection`/`JsonCollection` 的锁只在单进程内有效 |
| 11 | **广播实现 3 份** | `window.ts:241-249`（规范）、`ipc/knowledge.ts:30-34`、`ipc/plugin.ts:52-57` |
| 12 | **桥方法白名单 3 份** | `shared/types/ipc.ts` / `plugin-view-bridge.ts` / `host-service.ts` 内联 |
| 13 | **rendererOverrides 同名不同义** | 插槽派生（key=扩展名）vs `PreviewWindow` 局部 state（key=tab.id），**极易误改** |

## 14.4 🟡 死代码与半成品

| 项 | 状态 |
|---|---|
| `engine/dispatch.ts` 的 Turn 模型 | 头注释自述是「可选分流薄层」，`faultTolerant` 是 stub，**无生产调用点** |
| `engine/phase-runner.ts` | 最小骨架：`invokeSkill`/`faultTolerant` 是 stub，`deriveSkillIdFromPlanItem` 硬编码返回 `'file-reader'` |
| `graph/migrate.sealGraphAtTurnEnd` | 被注释点名为**死代码**（只有测试调用） |
| `inbox.hasPendingContinuation` / `turn-stopping.onTurnStopping` | 无生产注册监听器 → **continuation 通道实际恒空** |
| `applyMicroCompact` | 生产路径已弃用但保留（每轮滑动改写历史 → 前缀缓存命中率仅 ~50%） |
| `session-log.deriveMessages` | 「日志为真源」的双轨切换未落地，仅测试使用 |
| 渲染层 **8 个死组件** | `ArtifactCard` / `CommandPalette` / `LeftNav` / `MessageActions` / `MarketPanel` / `SettingsDialog` / `ProgressPanel` / `StepList` |
| `AgentChip` | 被 `Composer.tsx` import 但**从未渲染**（死 import + 死组件） |
| `main/audit/router-eval.jsonl` | 0 字节，无写入方 |
| `fs/cleanup.ts scheduleCleanup` | 注释称「启动后立即清理一次」，代码只有 `setInterval` |

## 14.5 巨型文件与注释漂移

| 文件 | 行数 |
|---|---:|
| `styles/globals.css` | 2,451 |
| `components/Composer.tsx` | 1,345 |
| `components/panels/MemoryPanel.tsx` | 1,241 |
| `components/panels/SkillsPanel.tsx` | 1,147 |
| `components/preview/PreviewWindow.tsx` | 1,134 |
| `components/dock/TaskPanel.tsx` | 1,006 |
| `graph/store.ts` / `graph/tools.ts` | 1,000 / 956 |
| `engine/act.ts` | 967 |
| `store/seed.ts` | 993 |
| `shared/types/ipc.ts` | 1,692 |

**注释与实现不符（已实测）**：
- `loop.ts:141` 注释「默认 25」vs 实际 `MAX_ITERATIONS = 200`
- `runner.ts:92` 注释「20s 超时」vs 实际 `TITLE_TIMEOUT_MS = 45_000`
- `keymap/spec.ts:10` 注释「24 条声明」vs 实际 25 条
- `agent/engine/` 下 9 个文件有**几乎逐字相同的 ~100 行 import 块**，其中 `loop.ts` 有约 39 个导入符号仅出现在 import 行（未使用）

## 14.6 应保留的正确设计（重构时勿丢）

这些是踩过坑才沉淀下来的，**重构时容易误删**：

| 设计 | 理由 |
|---|---|
| 工具面**按名确定性排序** | 为 prompt cache 前缀稳定（v0.23.2 教训：滑动改写历史让命中率掉到 ~50%） |
| `volatile` 段禁止进 system 槽位 | 会破坏前缀缓存（`contract.ts` 直接 throw） |
| 11 态 → 6 态映射中 `verifying`/`needs_human` 都映射 `running` | **绝不让镜像显示成 done** |
| 权限撤销**不需要权限** | 否则「用户关掉 net 权限后插件卸载卡在权限检查」 |
| 插件 `tools` 用**清单声明**而非运行期注册 | 懒激活下用运行期注册会造成死锁 |
| `kinds` 过滤的 effect 撤销 | 否则造成「进程以为注册着、宿主已忘了」的状态分叉 |
| 面板 `mcp` 数据源**诚实报「未接线」**而非回落假数据 | 静默退化是复合缺陷的粘合剂 |
| `user_message` 永不归档 | v0.23.2 修「用户输入被吞」 |
| 路径守卫**单一实现**（`fs/guard.ts`） | 禁止另写 `startsWith` 判定 |
| 插件 iframe **不给 `allow-same-origin`** | 有回归测试钉死 |
| 目录越界**回 404 不回 403** | 避免把「目录里有什么」变成可探测信息 |
| 权限确认 60s 超时**不算用户拒绝** | v0.14.0 修误报 |
| 几乎所有异常终局都是 `paused` 而非 `failed` | 产品底线「可介入」 |

---

# 15. 重构锚点建议

按「牵动面 × 收益」排序，供切分时参考。

| # | 锚点 | 现状 | 建议方向 |
|---:|---|---|---|
| 1 | **能力接入模型** | 四套机制（Skill/MCP/Profile/Plugin）各自汇入 `assembleTools` | 收敛为**单一能力注册表** + 统一来源/作用域/生命周期模型；`assembleTools` 退化为纯投影 |
| 2 | **任务进展表示** | PlanItem（派生）+ TaskGraph（真源）+ progress（摘要）三套 | 保留 Graph 为唯一真源，PlanItem 与 progress 明确为**只读投影**，删除反向写入 |
| 3 | **扩展执行体** | 插件 Host/Client 两半 + 线协议 wire.ts | 保留（设计合理），但**先补三处接线断点**（§14.1）再谈扩展 |
| 4 | **插槽体系** | 9 类插槽，4 类只登记不消费 | 要么补消费端，要么**从契约里删掉**——声明能过校验却不生效，是最伤作者信任的坑 |
| 5 | **engine 接缝** | loop + 14 个接缝模块，但有 ~100 行重复 import 块 | 抽 `EngineContext` 单一上下文对象，消灭重复 import；`dispatch.ts` 的 Turn 模型要么做实要么删 |
| 6 | **上下文与压缩** | 三套阈值 + 两套压缩路径 | 统一为**单一预算模型**（模型窗口驱动），删除固定值分支 |
| 7 | **渲染层状态** | 11 slice 扁平耦合 + 事件订阅混合模式 | 按领域聚合 slice；把 6 类组件自订阅收口进 `subscriptions.ts` |
| 8 | **持久化** | 三种原语 + 单进程内锁 | 引入跨进程保护（文件锁或单写者进程），或明确「单实例」为硬约束 |
| 9 | **记忆命名空间** | 目录建了，落盘路径没改 | 要么做完（L3/L4 路径改写 + 存量迁移），要么**从契约里删掉** |
| 10 | **巨型文件** | 10 个 >950 行文件 | 优先拆 `Composer.tsx`(1345) / `MemoryPanel.tsx`(1241) / `SkillsPanel.tsx`(1147) / `globals.css`(2451) |

## 15.1 重构前必须先处置的三件事

1. **补插件运行期三处接线**（§14.1）—— 否则「代码插件」这条能力线是纸面上的。
2. **建立「接线契约」验证** —— 本次普查发现的 P0-1 与已修的 D78/D79 完全同型，说明现有测试体系**无法发现「函数正确但没被调用」**。建议引入「调用点存在性 + 顺序」的静态/动态双重断言。
3. **落 git** —— 三版未 commit 已使逐版归因不可复原，重构前务必先打基线 tag。

---

## 附录 A：与既有文档的关系

| 文档 | 内容 | 本文的关系 |
|---|---|---|
| `docs/ARCHITECTURE.md` | 分层地图 + 依赖纪律（19KB） | 本文在其基础上补全功能子系统、阈值、消费链路与断裂点 |
| `docs/BACKLOG.md` | 跨版本欠账总账（L-33-xx / L-34-xx / L-35-xx）+ 纪律区 | 本文 §14 与其互补：BACKLOG 是版本维度，本文是结构维度 |
| `docs/CHANGELOG.md` | 逐版本变更 | 历史考古用 |
| `docs/versions/v0.35.0/` | 当版设计四件套 + 证据 + 用例矩阵 | 设计意图（should-be），本文是实际形态（as-is） |
| `docs/versions/v0.32.2/00-asbuilt-audit.md` | v0.32.2 的 as-built 审计 | 历史快照，其 8 条偏差多数已修 |

## 附录 B：本次普查的方法与已知局限

- **方法**：4 路并行源码普查（agent 引擎 / 记忆与扩展子系统 / 渲染层 / 插件与共享契约），每条结论带 `文件:行号` 证据；P0 结论经独立命令复核（`grep` + 源码直读）。
- **局限**：
  1. §14.1 的 P0-1/P0-2 是**静态分析推论**，未经实机运行验证。建议以「创建一个带 `main` 的最小插件并观察 `runtimeStatus`」作为复验动作。
  2. 未逐条运行测试套件确认 1667 用例（沿用 v0.35.0 记录值）。
  3. 未覆盖 `docs/versions/` 下 53 个历史版本目录的全部细节，仅取最新 v0.35.0 与 BACKLOG 交叉验证。
  4. 死组件判定基于「无 import 引用」的静态分析，未排除动态 `React.lazy` 路径（已排除 editor 与 vlib 两个已知懒加载点）。
