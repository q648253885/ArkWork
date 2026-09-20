# ArkWork 架构总览

> 用途：当前实现的**分层地图**与**依赖纪律**，作为后续架构调整的统筹基线。
> 基线版本：v0.35.0 ｜ 更新日期：2026-09-19
> 说明：本文只描述「现在是什么样」，不描述「应该改成什么样」。逐版本设计文档见 `docs/versions/`。

---

## 1. 定位与技术栈

本地优先的 AI Agent 桌面工作台 —— 把 ReAct 推理循环做成**可见、可控、可复用**的头等对象。数据以纯文件落在工作区，无数据库、无云端、无遥测。

| 层面 | 选型 |
|------|------|
| 运行时 | Electron 33 + Node.js（ESM） |
| 构建 | electron-vite 2.3 + Vite 5 + electron-builder 26 |
| 前端 | React 18.3 + TypeScript 5.6 + Tailwind 3.4 + Zustand 5 |
| LLM | `@anthropic-ai/sdk` + `openai`（openai / anthropic / ollama / vllm 四类 kind） |
| 检索 | MiniSearch（本地全文，无向量库） |
| 持久化 | 文件系统（JSON / JSONL / Markdown） |

---

## 2. 进程分层（顶层骨架）

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer（React UI）      src/renderer/                     │
│  三栏骨架 · 对话流 · Inspector Dock · 浮窗 · i18n 四语言       │
└───────────────▲──────────────────────────────┬──────────────┘
                │ window.ark.*（contextBridge）  │ 事件推送
┌───────────────┴──────────────────────────────▼──────────────┐
│  Preload 桥                src/preload/index.ts              │
│  25 个命名空间：invoke 封装 + on 订阅封装，唯一跨进程入口       │
└───────────────▲──────────────────────────────┬──────────────┘
                │ ipcMain.handle / webContents.send
┌───────────────┴──────────────────────────────▼──────────────┐
│  Main（Node 全能力）        src/main/                        │
│  组合根 · IPC 接入 · 领域服务 · 基础能力                       │
└─────────────────────────────────────────────────────────────┘
                    ▲                    ▲
              src/shared/（双端共享类型与纯函数）
```

| 层 | 目录 | 职责 | 纪律 |
|----|------|------|------|
| 主进程 | `src/main/` | 全部业务逻辑、文件系统、LLM 调用、Agent 循环 | 唯一有 Node 能力的地方 |
| 预加载 | `src/preload/index.ts` | 收敛全部 IPC 通道为 `window.ark` API | 不含业务逻辑，只做转发与解包 |
| 渲染进程 | `src/renderer/` | 纯 UI + 交互状态，经 `ark` 访问主进程 | 禁止直接 import `main/` |
| 共享层 | `src/shared/` | 类型定义 + 无副作用纯函数（i18n/路径/解析） | 不得依赖 Electron 或 Node 专有模块 |

依赖方向是**单向**的：`renderer → preload → main`，`shared` 被三方引用但自己零依赖。跨层通信只有 IPC 一条路。

---

## 3. 主进程分层

主进程按「组合根 → 接入 → 领域 → 基础」四层组织。**上层可调下层，下层不得反向 import 上层。**

### 3.1 组合根（启动顺序表）

| 文件 | 职责 |
|------|------|
| [index.ts](../app/src/main/index.ts) | 唯一启动编排：存储 → 工作区 → 残留任务回收 → 种子 → IPC 注册 → Profile 装配 → 插件运行时 → 调度器 → 建窗 |
| [window.ts](../app/src/main/window.ts) | 主窗口创建、平台差异化窗口控制、CDP 调试开关 |

启动顺序含硬约束（写错不报错、只是不生效）：插件协议特权必须在 `app.whenReady()` **之前**注册；插件运行时必须在 Profile 装配**之后**（它要读工作区目录）。

### 3.2 接入层 — IPC

[ipc/index.ts](../app/src/main/ipc/index.ts) 是统一注册点，按领域拆成 26 个 handler 文件：

| 分组 | handler |
|------|---------|
| 核心域 | task / agent / skill / memory / fs / settings / model / theme / window / log |
| 扩展域 | mcp / market / knowledge / automation / browser-tabs |
| 引擎侧 | router（chat/task 分流）/ permission / context / progress / plan-items / tool / bugfix |
| 新体系 | graph（TaskGraph）/ profile（工作台）/ plugin（插件）/ panel（面板取数） |

约定：handler 只做「参数校验 + 调用领域服务 + 返回/广播」，不写业务逻辑。

### 3.3 领域服务层

| 模块 | 职责 | 关键入口 |
|------|------|----------|
| **agent** | ReAct 引擎与 Agent 运行时 | [agent/runner.ts](../app/src/main/agent/runner.ts)（任务运行控制 + AbortSignal） |
| ├ engine | 引擎拆分后的职责模块 | [engine/loop.ts](../app/src/main/agent/engine/loop.ts) 主循环；`run-setup` / `reason-phase` / `turn-end` / `abort` 为接缝 |
| ├ tools | 工具统一抽象与执行管道 | `tool-pipeline.ts`、`registry.ts`（Skill ↔ LlmTool 转换、invokeSkill、风险分级） |
| ├ prompt | 提示词契约层 | `prompt/contract.ts`（契约）/ `sections.ts`（装配）/ `gates.ts`（阶段门禁状态机） |
| ├ skills | 内置工具技能 | file-reader/writer/editor、glob、grep、shell、web-search、fetch-url、browser、kb-search、delegate、abort |
| ├ graph | TaskGraph 任务图 | `store` / `project` / `sync` / `converge` / `replan` / `gate` |
| └ 其他 | 上下文预算、doom-loop、会话日志、权限模式、shell 风险审计、任务标题生成 | — |
| **memory** | 四层记忆体系 | L1 `l1-working`/`l1-repair`、L2 `l2-file`/`l2-memory`、L3 `l3-curated`/`l3-archive`、L4 `l4-profile`，加 `compaction` / `distill` / `search-engine` / `skill-forge` |
| **kb** | 知识库（导入/切块/索引/检索） | `parse` → `store` → `index` |
| **profile** | Workbench 工作台（插槽体系） | `slots`（九类插槽注册）/ `activator` / `builtins` / `prompt-context` |
| **plugins** | 代码化插件运行时 | [bootstrap.ts](../app/src/main/plugins/bootstrap.ts) 接线；`runtime/` 下 supervisor（每插件一进程）→ gateway（权限闸门）→ host-service（组合根）→ protocol（`arkwork-plugin://`） |
| **router** | chat / task 分流判定 | `classify-route` → `route-agent` |
| **automation** | Cron 调度自动起任务 | `scheduler`（30s tick）+ `cron` |
| **browser** | 内置浏览器（WebContentsView 多 Tab） | `view-manager`（单轨）+ `controller`（Agent 驱动：snapshot/click/type/screenshot） |
| **checkpoint** | 每轮检查点存档与回滚 | `store` |
| **pause** | 运行中任务优雅暂停 / 退出落盘 | `manager` |
| **fault-tolerance** | 失败分级、替代技能匹配、影响分析、退避重试 | `run-fault-tolerant` / `classify` / `alternative-skill-matcher` |
| **engine** | 阶段执行器（被内置技能复用） | `phase-runner` |
| **audit** | 路由判定评测样本 | `router-eval.jsonl` |

### 3.4 基础能力层

| 模块 | 职责 |
|------|------|
| [llm/](../app/src/main/llm/) | 适配器注册表 + openai/anthropic 适配器 + 流式管道 + think/say 标记剥离 + token 计数 + 缓存用量 |
| [store/](../app/src/main/store/) | JSON 文件持久化底座（db）+ 各实体仓储：tasks / agents / skills / mcp-servers / automations / seed |
| [fs/](../app/src/main/fs/) | 工作区读写、路径守卫（`guard`）、原子写（`write`）、产物登记（`artifacts`）、chokidar 监听（`watch`）、定时清理（`cleanup`） |
| [mcp/](../app/src/main/mcp/) | 零依赖 JSON-RPC 2.0 stdio 客户端，多 server 并发 + 心跳 + 自动重连 |
| [system/](../app/src/main/system/) | 日志（logger） |
| [i18n/](../app/src/main/i18n/) | 主进程侧文案（messages） |

---

## 4. 渲染进程分层

```
main.tsx
  └─ App.tsx ─────────── 三栏骨架 + 全局快捷键注册 + 主题落地 + 顶层弹层
       ├─ TopBar / Sidebar / CenterStage / Inspector     ← 布局骨架
       │     └─ components/                              ← 领域组件
       ├─ store/                                         ← 状态中枢
       ├─ services/                                      ← 编辑器/预览/保存等有状态服务
       ├─ keymap/                                        ← 键位中央注册表
       └─ utils/                                         ← 无状态派生工具
```

### 4.1 状态中枢 — store

[store/index.ts](../app/src/renderer/store/index.ts) 用 Zustand 把 11 个 slice 合成单一 `AppState`：

| slice | 负责 |
|-------|------|
| uiSlice | 布局折叠、面板 Tab、浮窗、主题、语言 |
| feedbackSlice | toast / 确认弹窗 / 上下文 chip |
| tasksSlice | 任务列表、选中、PlanItem 乐观更新 |
| conversationSlice | 步骤流、流式缓冲、对话派生 |
| kbMemorySlice | 知识库与记忆面板数据 |
| catalogSlice | Agent / 技能 / 模型目录 |
| marketSlice | 技能市场 |
| permissionSlice | 权限模式与规则 |
| fsSlice | 文件树、编辑器文档、冲突 |
| profileSlice | 工作台快照与插槽投影 |
| pluginSlice | 插件注册表与运行期状态 |

两条纪律：
- **`subscriptions.ts` 是 Main → Renderer 事件推送的唯一挂载点**。新增推送在此登记，不在组件里各自 `on`。
- 派生数据（对话流、PlanItem 状态）统一放 `derive-conversation.ts` / `utils/`，组件只读不算。

### 4.2 组件分层

| 目录 | 层次 | 内容 |
|------|------|------|
| `components/`（根） | 布局骨架 | App 级：TopBar、Sidebar、CenterStage、Inspector、Editors、QuickAction、QuickOpen、HelpCenter |
| `components/dock/` | Inspector Dock | TodoPanel、ContextPanel、TaskPanel、TerminalPanel、BrowserPanel、ProgressPanel、BugfixIsland |
| `components/right/` | 任务诊断 | StepList（步骤时间线）、LogsView |
| `components/panels/` | 能力面板 | Agents、Skills、Kb、Memory、Automations、Market、Files、Tasks、Plugins、Abilities |
| `components/preview/` | 浮窗预览 | PreviewWindow + renderers 注册表（markdown/代码/图片/SVG/表格/浏览器） |
| `components/editor/` | 编辑器 | CodeMirror 6 内核 |
| `components/workbench/` | 工作台 Profile | ProfilesView、ProfileEditor、DiagnosticsView、ImportDialog |
| `components/plugins/` | 插件视图宿主 | PluginViewHost |
| `components/flow` · `graph` | 任务图 / 流程可视化 | — |

### 4.3 服务与基础设施

| 目录 | 职责 |
|------|------|
| [services/](../app/src/renderer/services/) | 有状态前端服务：editorSession（会话）、editorDoc（文档模型）、savePipeline（原子保存 + 冲突）、previewTabs |
| [keymap/](../app/src/renderer/keymap/) | 键位中央化：`spec.ts` 声明 / `actions.ts` 处理 / `registry.ts` 消歧。**禁止组件内自行 addEventListener** |
| [ipc/client.ts](../app/src/renderer/ipc/client.ts) | `window.ark` 的渲染侧封装 |
| utils/ | 无状态派生：plan-status、turn-fold、profile-theme、intent-text… |

---

## 5. 核心子系统速览

### 5.1 ReAct 引擎

```
用户输入
  └─ router 分流 ── chat ──→ runChatOnce（直回，不入循环）
                └─ task ──→ runner.runTask
                              └─ runReActLoop
                                   ├─ Phase 0  上下文注入（L1 筛选 / L3 策展 / L4 画像 / KB 召回）
                                   ├─ Phase 1  Reason（LLM 流式 + 思考标记剥离）
                                   ├─ Phase 2  Act（并行工具调用 → tool-pipeline → 权限/门禁）
                                   ├─ Phase 3  决策（终止 / 续跑 / 门禁暂停）
                                   └─ 每轮：checkpoint 存档 · session.jsonl 落盘 · 事件广播
```

关键机制：Turn → Step → Block 三层事件模型；工具调用签名级 + 类别级预算；doom-loop 检测；迭代触顶优雅暂停；token 超阈值分层压缩（微压缩 → 压缩 → 蒸馏）。

### 5.2 四层记忆

| 层 | 内容 | 存储 |
|----|------|------|
| L1 工作记忆 | 单任务对话/推理/工具 observation | `.arkwork/memory/{taskId}/` |
| L2 文件记忆 | 任务产物与超大工具结果 | `.arkwork/tasks/{taskId}/.arkwork/steps/` |
| L3 策展 + 档案 | `memory.md`/`user.md` 笔记 + 已完成任务的完整 L1 | `.arkwork/memory/MEMORY.md`、`.arkwork/archive/` |
| L4 用户画像 | 版本化偏好档案（保留 10 版） | `.arkwork/profile.json` |

### 5.3 技能 / 工具统一抽象

一个 `Skill` 抽象覆盖三类来源：**内置工具**、**MCP 工具**（运行时注入，断连移除）、**指令型技能**（`skill.json` + `SKILL.md`）。加载分层：project > user > bundled > runtime，近层遮蔽远层；`SKILL.md` 渐进披露，仅在调用时载入。指令模式分 always-on / on-demand / hint-only。

### 5.4 插件体系（v0.33–v0.35）

- **插槽先行**：底座只认识九类插槽（`profile/slots.ts`），不认识任何垂直领域。
- **来源三级**：bundled（随包）< global（全局）< workspace（工作区），同 kind 同 id 时高优先来源可覆盖 builtin。
- **进程隔离**：每个插件一个 `utilityProcess`，经 gateway 权限闸门访问宿主能力；视图走 `arkwork-plugin://` 独立源。
- 声明（`plugin.json` 的 provides）与运行期注册（`ctx.ark.tools.register`）**两者必须都齐**才生效。

### 5.5 其他

| 子系统 | 要点 |
|--------|------|
| TaskGraph | 任务图投影、证据链、needs_human、Replan、收敛判定；与 PlanItem 经唯一镜像桥同步 |
| LLM 适配 | 按 model.id 懒初始化适配器；OpenAI 兼容端点全覆盖；Anthropic 支持 prompt caching（≤4 断点）+ extended thinking |
| 知识库 | PDF/DOCX/TXT/MD 导入 → 段落边界切块（~500 tokens + 重叠）→ 本地索引 → 按任务启用 + 启动自动召回 |
| 自动化 | Cron 调度到点起完整 Agent 流程，同分钟去重 + 启动补 tick |
| 权限 | 五级模式（default / auto-approve / accept-edits / plan / bypass）+ allow 规则 + 会话级授权记忆 |

---

## 6. 一次任务的端到端数据流

```
Renderer Composer
  └─ ark.task.start() ──IPC──→ ipc/task.ts
        └─ runner.runTask
              ├─ store/tasks  更新状态 ──广播 task:status──→ subscriptions → tasksSlice
              └─ runReActLoop
                    ├─ llm/registry → adapter → 外部 LLM（流式）
                    ├─ 文本增量 ──广播 task:text-delta──→ conversationSlice 流式缓冲
                    ├─ 每步 ──广播 task:step──→ StepList / 对话流
                    ├─ 工具进度 ──广播 task:progress──→ Dock 进度面板
                    ├─ 需确认 ──广播 confirm:request──→ ToolConfirmLayer
                    └─ 落盘 session.jsonl / checkpoint / L1 / L2
  └─ 用户操作（pause/resume/cancel/确认/回答 ask_user）──IPC──→ 回到 runner
```

**双向契约**：`invoke` 走请求-响应（用户动作），`send` 走事件推送（引擎状态）。所有推送在 `subscriptions.ts` 收口。

---

## 7. 数据持久化布局

```
{userData}/arkwork-data/            ← 应用级（跨工作区）
  ├─ models.json                    模型配置
  ├─ agents.json / skills/          智能体与技能
  ├─ settings.json                  全局设置
  └─ plugins/                       全局插件

{workspace}/                        ← 工作区级（用户打开的文件夹）
  ├─ .arkwork/                      ← 全部内部数据，文件树对其整体隐藏
  │   ├─ tasks.json                 任务索引
  │   ├─ tasks/{taskId}/            任务产物 + steps/
  │   ├─ memory/                    L1 + MEMORY.md
  │   ├─ archive/                   L3 档案
  │   ├─ profile.json               L4 画像
  │   ├─ kb/                        知识库文件与索引
  │   ├─ specs/ · documents/        spec / plan 技能产物
  │   ├─ checkpoints/ · cache/ · logs/ · history/
  │   ├─ skills/                    工作区级技能
  │   ├─ plugins/                   工作区级插件
  │   └─ settings.json · settings.local.json
  └─ （用户业务文件）
```

纪律：**用户产物不放 `.arkwork`**；`.arkwork` 只放 Agent 相关数据与临时产物，临时产物由 `fs/cleanup.ts` 定时清理。

---

## 8. 架构纪律（后续调整时的红线）

| # | 纪律 | 理由 |
|---|------|------|
| 1 | 依赖单向：renderer → preload → main，shared 零依赖 | 越层引用会让进程边界失效 |
| 2 | 跨进程通信只有 IPC 一条路，渲染层禁 import main | 保证安全边界与可测试性 |
| 3 | 主进程内上层可调下层，下层禁反向 import 上层 | 防循环依赖 |
| 4 | IPC handler 只做校验/转发，业务在领域服务 | 便于复用与测试 |
| 5 | 主→渲染推送统一在 `subscriptions.ts` 挂载 | 防订阅散落、内存泄漏 |
| 6 | 键位统一在 `keymap/` 注册表 | 防 `when` 门控与优先级失控 |
| 7 | 派生数据集中在 `derive-*` / `utils` | 组件只读不算 |
| 8 | 插件/Profile 只经插槽与宿主服务接触底座 | 保证「换实现不牵动上层」 |

---

## 9. 后续调整可关注的锚点

按当前实现，以下几处是层次划分中**耦合相对集中**、调整时牵动面较大的位置：

1. **`agent/` 目录体量最大** —— 引擎、工具、提示词、技能、图五类职责同处一层。engine 已做接缝拆分（`loop`/`run-setup`/`reason-phase`/`turn-end`），tools 与 skills 的边界仍值得再梳理。
2. **`ipc/` 与领域服务是一一映射** —— 新增领域会同时加两处文件。若领域数继续增长，可考虑按领域目录聚合（`ipc/task/` 而非平铺）。
3. **三套并行的"任务进展"表示** —— PlanItem、TaskGraph、progress（任务进度摘要）各自有状态与广播。三者已有同步桥，但语义重叠是后续统一的主要候选。
4. **插件 / Profile / 插槽三条线相互依赖** —— profile 提供插槽，plugin 注册进插槽，渲染层消费插槽投影。改任一条都需同时核对另外两条。
5. **`store/`（主进程持久化）同时服务任务、智能体、技能、MCP、自动化** —— 是多数领域的公共底座，任何字段变更影响面广。
6. **`shared/types/` 是事实上的接口契约层** —— 类型改动即跨进程契约改动，需与 preload API 面同步演进。
