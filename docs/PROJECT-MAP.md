# ArkWork 项目地图

| 项 | 值 |
|---|---|
| 用途 | **导航地图**：回答「什么代码/文档在哪个目录」。不解释设计，不含代码细节 |
| 何时读 | 每个版本**开场先读**（与 `PROJECT-OVERVIEW.md`、`CHANGELOG.md` 一起），避免每次全量扫描目录 |
| 维护 | 每版收尾**增量更新**（新增/移动目录才改）；大改后跑一次 `find src -maxdepth 2 -type d` 校对 |
| 建立 | 2026-09-25（v0.37.0）—— 在此之前本仓只有「变更日志」与「欠账总账」两份全局文档 |

---

## 一、仓库顶层

| 路径 | 内容 |
|---|---|
| `app/` | **全部源码与构建**（Electron 应用；`npm` 脚本都在这里） |
| `docs/` | 全部文档（见 §五） |
| `bin/` | 机械校验脚本（`validate_version_docs.py` 等，Python，只读不写盘） |
| `products/` | 产品化材料 |
| `README.md` / `README.zh-CN.md` / `README.ja.md` / `README.ko.md` | 四语言项目说明（对外） |
| `LICENSE` | 许可证 |

> ⚠️ `overview.md`（仓库根）是 **v0.17.0 的历史 UI 设计说明**，不是项目总览 —— 项目总览见 `docs/PROJECT-OVERVIEW.md`。

## 二、`app/` 分层（实测 689 个源文件 · 2026-09-29）

> 计数口径：`app/src` 下 `*.ts` / `*.tsx` / `*.mjs` / `*.cjs`，排除 `node_modules`。

| 目录 | 文件数 | 职责 |
|---|---|---|
| `app/src/main/` | 383 | **主进程**：agent 引擎、存储、IPC、插件、记忆、LLM、文件系统 |
| `app/src/renderer/` | 225 | **渲染进程**：React 界面（交互区、面板、工作台、设置） |
| `app/src/shared/` | 67 | **主/渲染共享**：类型定义 `types/` + 纯函数工具 `utils/`（含 v0.41.0 `finish-phrase.ts` 终局短语谓词；无 Electron 依赖） |
| `app/src/preload/` | 3 | 预加载脚本（`window.ark.*` 能力面） |
| `app/src/test/` | 6 | 测试基础设施：`electron-mock-loader.mjs`（统一 ESM loader）+ `electron-stub.mjs` + `logger.stub.mjs` + `repo-scan` 快照 + `tmp-cleanup.{mjs,cjs}`（v0.37.0 新增，由 runner 用 `NODE_OPTIONS --import` 注入，**进程退出时清扫临时工作区**，见 D148/D191） |
| `app/scripts/` | — | 工程脚本：`run-tests.mjs`（统一测试 runner，v0.39.0 起临时目录/日志名带 **PID 命名空间**，见 D191）等 |
| `app/release/` | — | 打包产物（`.app` / dmg / zip） |

## 三、`app/src/main/` 关键模块

| 模块 | 职责 | 备注 |
|---|---|---|
| `main/agent/` | **ReAct 引擎**（reason / act / turn-end / loop / gates / dispatch / messages / prompt） | 核心；子目录见下 |
| ├ `agent/engine/` | 引擎阶段实现（`loop.ts` / `act.ts` / `reason-phase.ts` / `turn-end.ts` / `gates.ts` / `abort.ts` / `run-setup.ts` / `messages.ts`）。**v0.38.0 新增**：`work-class.ts`（本 run 工作性质分类 —— **三份集合 + 三个守卫**：`PLAN_WRITE_TOOLS`「真正落账本」/ `RETIRED_PLAN_TOOLS`「已下架旧名」/ `PLAN_TOOLS`「清单族」；**不可合并**，见 D157）、`gate-channel.ts`（门禁双出口 `refuseViaGate` / `emitTurnNote` / `injectInputJudgement`）、`ledger-guard.ts`（`guardFinish` 纯判定）、`turn-note-policy.ts`（阶段结论节流）、`plan-tree-sync.ts`（陈旧提醒，改调 `isPlanWriteTool` 守卫）。**v0.39.0**：`loop.ts` 无工具分支重排为「伪调用 → 纯答复停滞 → 文本解析」（D179/D182）。**v0.41.0**：`prose-tool-call.ts`（Ollama qwen3.5 正文工具降级通道 —— 提取器/谓词/契约提示，D208）、失败摘要与阈值重排（W2）、`sealLedger` 覆盖五条终态路径（D184）；`stall.ts` / `pseudo-call.ts` 为对应守卫常量 | 引擎已从单文件拆分为目录 |
| ├ `agent/planning/` | **规划通道（v0.39.0 新增）**—— 一条**不带工具、短上下文、独立于 ReAct 轮次**的 LLM 调用，专做「现在该做什么、按什么顺序做」。`types.ts`（`PlannerTrigger` 由 `PLANNER_TRIGGERS` 推导 + 预算/上限常量）/ `policy.ts`（纯函数：预算 / 冷却 / 幂等 / `shouldCommitRegexDraft`）/ `prompt.ts`（契约与模板，**避开 ReAct 模板**）/ `parse.ts`（★核心：5 层降级 JSON→fence→repair→checklist→outline + S1–S5 安全不变量）/ `digest.ts`（失败摘要 + 下一步建议）/ `runner.ts`（`runPlannerPass`，`completeFn` 为测试接缝） | `docs/versions/v0.39.0/04-system-design.md` §3 |
| ├ `agent/planning/ops/` | **清单操作通道 PlanOps（v0.40.0 新增）**—— 规划通道只管「生成」，本模块把清单的 `create` / `update` / `complete` / `cancel` / `replan` **各自做成一次独立的窄 LLM 请求**（无工具 / 低温 / 有界超时 / 2 次尝试），输出复用 `../parse.ts` 五层降级解析，**不依赖 function calling**。`types.ts`（`PLAN_OPS_KINDS` 由数组推导类型 + 预算常量）/ `policy.ts`（`pickPlanOpsKind` 选操作 + `shouldRunPlanOps` 节流三件套，**预算优先于一切豁免**）/ `prompt.ts`（五套窄 prompt **共享同一份输出契约** I-O7）/ `runner.ts`（`runPlanOps`，`completeFn` 测试接缝）。主循环接线在 `agent/engine/plan-ops-tick.ts`（v0.40.0 新增：轮首 tick + 空回合兜底） | `docs/versions/v0.40.0/04-system-design.md` §三–§七 |
| ├ `agent/graph/` | **TaskGraph**（16 文件，富语义任务图）+ `plan-sync.ts` 图↔清单桥 | v0.37.0 起图是**派生镜像层** |
| ├ `agent/ledger/` | **TaskLedger**（v0.37.0 新增）—— 清单**唯一真相源**：`engine.ts`（`mutate` 唯一写入口；`emptyLedger` 含 `round: 1`）/ `ops.ts`（算子表）/ `file.ts`（原子落盘）/ `project.ts`（唯一读出口，`toPlanItems` 带出 `round`）/ `resume.ts`（恢复点）/ `types.ts`。**v0.38.0 新增** `plan-diff.ts`（`diffPlan` 纯函数 —— 模型提交完整清单、引擎算差异；对外 5 态 ↔ 对内 9 态）。**v0.39.0 新增**：`audit.ts`（审计 JSONL 永久双写 + 终态归档快照 + 幂等，D187）、`hint.ts`（`PLAN_TOOL_HINT` —— 模型可见引导文案**唯一事实源**，D186/D189）；`ops.ts` 增 `reopen` 算子与**层级判据唯一执法点**（解析 → 判层级 → 落盘三步，D185）；`plan-diff.ts` 只管引用解析、**不判层级**。**v0.43.0**：`types.ts` 增 `LedgerFile.round`/`LedgerItem.round`/`LedgerFile.goal`；`ops.ts` plan-commit 增**轮次晋升 + goal 落库**与 `setStatus` 第 8 参数（I2 推广为全模式「done 需 artifact」）；`file.ts` `normalizeLedger` **必须保留 `round`**（漏收则读→写回抹平轮次） | `docs/versions/v0.37.0/04-system-design.md` / `v0.38.0` / `v0.39.0` / `v0.43.0` |
| ├ `agent/prompt/` | 提示词分层 sections（L0 静态 / L1 每轮 / L2 契约 / L3 运行期） | |
| ├ `agent/skills/` | 内置 skill（含 `react-core-skills` 阶段门禁） | |
| └ `agent/__tests__/` | agent 相关套件 | |
| `main/store/` | 持久层：`db.ts`（原子写）/ `tasks.ts` / `seed.ts`（内置工具与 profile 种子） | |
| `main/plugins/` | **插件系统**：清单、激活器、能力网关、zip 安装、Host 子进程 supervisor | `utilityProcess` + `iframe sandbox` |
| `main/profile/` | Workbench Profile（垂直工作台） | |
| `main/capability/` | CapabilityRegistry（工具装配唯一入口 `assembleTools`） | |
| `main/memory/` | **L1–L4 记忆**（L1 工作记忆 / L2 会话 / L3 巩固 / L4 合成）+ skill-forge | |
| `main/llm/` | 模型调用、流式、协议归一化、缓存 | |
| `main/fs/` | 文件系统：`workspace.ts` / `guard.ts` / `text.ts` / `write.ts`（自写登记）/ `agent-writes.ts`（agent 写盘登记）/ `watch.ts`（chokidar 监听 + 批次聚合） | |
| `main/ipc/` | 主↔渲染 IPC 入口（`index.ts` 启动链、`task.ts`、`graph.ts`、`plan-items.ts`、`panel.ts`…） | |
| `main/git/` | git 服务与引擎（三级解析链） | |
| `main/pause/` | 暂停/恢复（`manager.ts`）与检查点 | |
| `main/router/` | 请求分类路由 | |
| `main/system/` | 日志、性能模式（`perf-lite`）等系统能力 | |
| `main/kb/` · `main/mcp/` · `main/net/` · `main/browser/` · `main/automation/` · `main/audit/` · `main/checkpoint/` · `main/dev/` · `main/fault-tolerance/` · `main/i18n/` | 知识库 / MCP / 网络 / 内嵌浏览器 / 自动化 / 审计 / 检查点 / 开发辅助 / 容错重试 / 主进程 i18n | |

## 四、`app/src/renderer/` 关键目录

| 目录 | 职责 |
|---|---|
| `renderer/components/` | 全部 React 组件（`flow/` 交互区块、`dock/` 侧栏、`graph/` 任务面板与计划卡、`right/`、`preview/`…）。**v0.38.0 新增块**：`flow/blocks/NoteBlock.tsx`（阶段结论）。**v0.42.0**：`flow/FileLink` chip 化（图标+中性底）、`preview/PreviewWindow` 渲染器下拉退役 → Tab 栏「编辑\|预览」分段控件、`dock/TodoPanel` 产物摘要路径链接化（消费 `renderer/utils/path-links`）。**v0.43.0**：`dock/TaskPanel.tsx` 两 Tab（本轮任务/全部任务，**默认本轮**）+ 标题取 `snapshot.goal` 优先 + 档位独立行 + `TierInfoPopover`（Portal 到 body）+ DagView 退役挂载（文件本体保留）；新增纯函数 `renderer/utils/round-filter.ts`（`buildRoundIndex`：账本 `item.round` 直查 → `T-NN` 序号兜底 → 无命中归历史，供面板分区） |
| `renderer/flow/` | 交互区**投影**（turn/step/block 派生，SAY 剥离）。`project.ts` **必须是纯函数**（无 `window` / `Date.now()`）；v0.38.0 新增两条投影：`turn_note → note`（按 ts 保序插入 `FlowStep.blocks`）、`gate_blocked → notice(noticeKind='gate-blocked')` |
| `renderer/store/` | 渲染层状态（slice 化）。**v0.38.0 新增通道**：`flowEvents`（`taskId → 待投影事件`）+ 唯一写入口 `appendFlowEvent` —— 此前 `TurnList` / `tasksSlice` 硬传 `events: []`，渲染层**从来没有** session 事件通道（接线缺失 + 静默退化的典型） |
| `renderer/styles/` | `globals.css` —— **设计 token 唯一源**（`:root` / `.dark`） |
| `renderer/utils/` | 渲染层纯工具（`label-guard` / `anchored-menu` / `profile-view`…）。**v0.42.0 新增**：`path-links.ts`（自由文本 → 路径分段，清单产物链接化判据层） |
| `renderer/i18n/` | 四语言资源（zh / en / ja / ko）。**v0.39.0**：新增 `const.tool.taskPlan` / `const.tool.turnNote`（当前清单入口的展示文案） |
| `renderer/constants.ts` | 渲染层常量：**`TOOL_DISPLAY`**（工具名 → 中文动词 + 图标 + 参数摘要）。**v0.39.0（D190）**：补当前唯一入口 `task_plan` / `turn_note` 的条目；历史名 `todo-update` / `todo_update` 保留但注明「只为渲染旧会话」 |
| `renderer/keymap/` | 快捷键（逻辑和弦，唯一真源） |
| `renderer/services/` | 编辑器文档、预览 Tab 等服务 |
| `renderer/ipc/` | 渲染侧 IPC 封装 |

## 五、`docs/` 文档地图

| 路径 | 内容 | 何时读 |
|---|---|---|
| `docs/PROJECT-OVERVIEW.md` | **项目总览**（定位 / 架构 / 版本策略） | 开场先读 |
| `docs/PROJECT-MAP.md` | **本文件**（目录导航） | 开场先读 |
| `docs/CHANGELOG.md` | **项目级变更日志**（版本 → 日期 → 主题 → 状态） | 开场先读；收尾必更 |
| `docs/BACKLOG.md` | **跨版本欠账总账** + **纪律区**（每版必读，违反即重复故障） | 开场必读 §纪律区；收尾必更 |
| `docs/versions/<版本>/` | 版本化文档（四件套 + 用例库 + 证据 + 原型） | 见 §六 |
| `docs/ARCHITECTURE.md` | 架构总览（设计视角） | 改架构前 |
| `docs/ARCHITECTURE-ASBUILT.md` | **代码现状实录**（15 章 + 附录：功能清单 / 内置工具 / 阈值速查 / 数据流 / §14 架构债 / §15 重构锚点） | 想知道「现在到底是什么样」 |
| `docs/user-guide.{zh-CN,en,ja,ko}.md` | 四语言用户指南 | 面向用户的文案改动 |
| `docs/browser-redesign-*.md` | 历史（浏览器重构 PRD/设计） | 追溯 |

## 六、`docs/versions/<版本>/` 标准件

| 文件 | 内容 | 门禁 |
|---|---|---|
| `00-release-goal.md` | 发布目标 + 验收标准（A1…）+ Scope Out | ✅ 校验 |
| `01-research.md` | 调研（业界做法 + 差距表） | — |
| `02-prd.md` | 需求（F1…/IR-…） | — |
| `04-system-design.md` | 系统设计（数据模型 / 状态机 / 接线清单 W1… / 兼容降级） | ✅ 校验 |
| `03-interaction.md` | 交互设计（有 UI 变更时） | ✅ 校验 |
| `testcases/00-cumulative-matrix.md` | **累积用例矩阵**（§一规模 / §二新增 / §三缺陷 D** / §四变更记录） | ✅ 校验 |
| `testcases/01-smoke-suite.md` | 冒烟清单 | ✅ 校验 |
| `evidence/NN-*.md` | 实机/实证证据（截图、日志片段） | — |
| `prototype/` | HTML 原型（有**新页面**时才产；纯引擎改动不产） | — |

> **不在版本目录里的**：`docs/versions/**` 被 `.gitignore` 忽略（`git ls-files docs/versions/` = 0），
> 故 commit 只含代码 + `docs/BACKLOG.md` / `CHANGELOG.md` / 本文件 / PROJECT-OVERVIEW。

## 七、常用命令速查（cwd = `app/`）

| 动作 | 命令 |
|---|---|
| 跑全量测试 | `node scripts/run-tests.mjs`（受限环境见下）。**⚠️ 同一时刻只跑一个 runner**（D191：两个 runner 并发会互踩夹具并覆盖 TAP 日志，失败**不可归因**）；要并行跑焦集合请传**多个子串**（单进程内并发池），不要起两个进程 |
| 跑单个/若干套件 | `node scripts/run-tests.mjs <关键词…>`（关键词按**路径子串** OR 匹配） |
| 受限环境降并发 | `TEST_CONCURRENCY=1 node scripts/run-tests.mjs`（D146） |
| 临时工作区清扫 | **自动**：runner 运行前（仅清 300s 前的）/ 运行后清扫 + 每个测试进程退出时清扫本轮遗留（D148）。**v0.39.0（D191）**：slot 目录与 TAP 日志名带 `process.pid` 命名空间（`arkwork-pool-tmp-<pid>-<slot>` / `arkwork-tests-file-<pid>-<n>.log`），`prune` 跳过非本 run 的 slot。排查夹具时用 `ARKWORK_TEST_KEEP_TMP=1` 关闭 |
| 取某文件失败详情 | 从 `$TMPDIR/arkwork-tests-file-<pid>-<n>.log` 里 grep `^not ok` —— 聚合摘要只给文件名，**报错原文在 per-file TAP 日志里** |
| 类型检查（双 tsconfig） | `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json && ./node_modules/.bin/tsc --noEmit -p tsconfig.web.json`（**必须用本地 tsc**，`npx tsc` 会去装假包 `tsc@2.0.4`） |
| 构建（不打包） | `npm run build` |
| 打包 mac `.app` | `npm run build:dir`（产物 `release/mac/ArkWork.app`，**架构 = 宿主架构**；宿主 Intel 时即 x64。**不要**顺手交叉打 arm64：缺 `@napi-rs/canvas-darwin-arm64` 会产出坏包，见 `docs/versions/v0.39.0/evidence/02-package-and-diagnosis.md` §1.1） |
| 交付前核产物白名单 | 解 `app.asar` 列**非 `node_modules` 条目**并与白名单比对（表见上述 evidence §1.2）——`electron-builder` 把 `out/` 整棵收进 asar，而 `electron-vite build` **不清 `out/`**，历史残留会静默随包出货（D194 / 纪律㉟） |
| 出 dmg | `npm run build:mac`（未签名；`.app` 首次打开需在「系统设置 → 隐私与安全性」放行）。**打包前若报 `ENOTEMPTY: release/mac`** → 先 `rm -rf release/mac` 再跑 |
| 打 Windows 绿色 zip | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ ./node_modules/.bin/electron-builder --win zip --x64`。**⚠️ 两个已知坑**：① electron-builder 原生 zip 的**顶层是散开的**（148 个文件直接铺开）→ 交付前用 `ditto win-unpacked <tmp>/ArkWork-<ver>-win-x64` + `zip -r` 重打成**顶层唯一目录**；② **网络**：本机代理不可用时**必须不带代理变量**（否则 `ECONNREFUSED 127.0.0.1:7890`），GitHub 直连不通时走 npmmirror 镜像；`rcedit` 在 macOS 上**不需要 wine** |
| 清理旧产物 | `python3 app/scripts/clean-release.py --dry-run`（先出清单）→ 去掉 `--dry-run` 执行。保留版本**自动读 `app/package.json` 的 version**（唯一真源）；只动 `app/release/` **顶层**、带前缀二次校验；会一并回收 `win-unpacked/`、`_stale-*` 残留与过期 `latest*.yml`。v0.40.0 实测清掉 **1.65 GB 旧安装包 + 2.1 GB `_stale-*` 打包失败残留 + 425 MB 中间产物**（`release/` 1.65 GB → 705 MB） |
| 版本文档门禁 | `python3 bin/validate_version_docs.py <版本>` |
| 实机 UI 探针 | `app/scripts/ui-probe.mjs`（CDP 127.0.0.1:9223） |
