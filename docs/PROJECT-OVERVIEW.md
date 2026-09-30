# ArkWork 项目总览

| 项 | 值 |
|---|---|
| 用途 | **项目总览**：定位、技术栈、核心架构、版本与工程约定。回答「这是什么、怎么组织、按什么规矩改」 |
| 何时读 | 每个版本开场（与 `PROJECT-MAP.md`、`CHANGELOG.md`、`BACKLOG.md` 一起） |
| 建立 | 2026-09-25（v0.37.0）—— 此前本仓只有「变更日志」与「欠账总账」两份全局文档 |
| 当前版本 | 见 `CHANGELOG.md` 发布索引末行（唯一版本真源 = `app/package.json` 的 `version`） |

---

## 一、这是什么

**ArkWork** 是一个 **agent 工作台**（本地优先桌面应用）：用户用自然语言下达任务，模型以 **ReAct** 循环自主执行（读写文件、跑命令、调工具、操控插件面板），并在执行过程中维护一份**可见、可干预、可续聊**的任务清单。

三个设计取向：

1. **把过程摊开**：思考 / 工具调用 / 结论分层呈现，用户随时能看到「正在做什么、做到哪」。
2. **把控制权给模型**：任务模式（对话 / 计划 / 规格）由**模型自选**，UI 只显示只读徽标；不提供 T2/T3/T4 之类的人工档位下拉。
3. **本地优先**：数据落在本机（`~/Library/Application Support/ArkWork/`），插件可离线运行，模型可接局域网端点。

## 二、技术栈

| 层 | 选型 |
|---|---|
| 桌面容器 | Electron（主进程 + 渲染进程 + preload） |
| 语言 | TypeScript（严格；**双 tsconfig**：`tsconfig.node.json` / `tsconfig.web.json`） |
| 构建 | electron-vite（`npm run build` / `build:dir` / `build:mac` / `build:win`） |
| 渲染层 | React + Tailwind（token 全部来自 `renderer/styles/globals.css`） |
| 测试 | `node:test` + tsx（统一入口 `app/scripts/run-tests.mjs`；electron 走 `src/test/electron-mock-loader.mjs` 桩） |
| 文件监听 | chokidar（批次聚合 + 自写/agent 写盘双登记表） |
| 插件运行时 | Host 侧 `utilityProcess` 子进程 + Client 侧 `iframe sandbox` |
| 打包 | electron-builder（mac dmg/zip、Windows 免安装 zip） |

## 三、核心架构（四块）

### 3.1 引擎：ReAct 循环（`main/agent/`）

```
Reason（含子阶段） → Act（工具执行） → 阶段门禁 / 完成门禁 → 下一轮
```

- 阶段实现拆分在 `agent/engine/`（`loop` / `reason-phase` / `act` / `turn-end` / `gates` / `abort` / `run-setup` / `messages`）。
- **统一完成门禁 `guardFinish()`**（v0.37.0）：覆盖 `task_complete` / 最终答复 / 超迭代 / 用户中止四条收尾路径 —— 此前只挂 `task_complete`，模型不调它就完全绕过。
- **规划通道（Planner Pass，v0.39.0 · `agent/planning/`）**：一条**不带工具、短上下文、独立于 ReAct 轮次**的 LLM 调用，专做「现在该做什么、按什么顺序做」。四个接线点：开局 / 连续失败达阈值 / 清单陈旧 ≥10 轮 / 用户新指令；**全部失败静默回落既有链**，不影响正常模型。配套**统一解析器**（5 层降级 JSON→fence→repair→checklist→outline）兜住「模型不会 tool calling」的弱模型场景。
- **正文工具降级通道（v0.41.0 · `agent/engine/prose-tool-call.ts`）**：Ollama 形态 + qwen3.5 模型不发原生 tool_calls 时（把工具调用 JSON 写进正文），引擎开启请求级 think（ollama 原生通道，思考走独立字段）+ 从正文提取工具调用 JSON（扁平键/白名单防幻觉/去重）**代为真实执行**；谓词默认关闭，其余模型零变化（D208）。
- **清单操作通道（PlanOps，v0.40.0 · `agent/planning/ops/`）**：规划通道只管「清单怎么**生成**」，而修改 / 完成确认 / 取消 / 重新规划仍只能靠模型在主循环里顺手发一个 `task_plan` 原生 tool_call —— 一旦模型的 tool_call 能力不可用，清单**永久停摆**（实测：21 轮空转 / 连续空响应）。PlanOps 让这四类操作各自成为一次**独立的、不带工具的、短上下文**窄请求，输出走既有五层降级解析器，**不依赖 function calling**。节流三件套：每 run 预算上限 10 · 同类操作轮间隔 ≥3 · 清单指纹未变不落库；**预算判定优先于一切豁免**。
  - 主循环两处接线：**轮首 tick**（每轮依据上一轮客观事实判定）+ **空回合兜底**（`pauseForEmptyResponses` 之前先给清单一次推进机会）。
  - `task_plan` 工具**保留但降级为可选快路径**（模型可见文案不再要求「必须调用」）——强模型继续用效果好，弱模型不用它清单照样推进。
- **提示词四层**：L0 静态不变量 · L1 每轮注入（清单快照 + 恢复点）· L2 输出层次契约 · L3 运行期瞬时提示。

### 3.2 任务：TaskGraph + **TaskLedger**（v0.37.0 分界）

| | TaskGraph（`agent/graph/`，v0.30.0 引入） | **TaskLedger**（`agent/ledger/`，v0.37.0 新增） |
|---|---|---|
| 定位 | 富语义任务图（节点 / 依赖 / 验收 / 证据），tier ≥ 2 的能力层 | 清单（planItems）的**唯一真相源** |
| 写 | 由账本经 `mirror` 算子**单向下推** | **唯一写入口** `ledger.mutate()`（per-task 串行锁 + `revision` 乐观锁 + tmp+rename 原子落盘） |
| 读 | 图视图 | `project.ts` 投影为 `planItems`（**UI 与提示词都从这里读**） |
| 落盘 | `graph.json` | `.arkwork/ledger/{taskId}.json` |

**状态机 9 态**：`pending / running / paused / blocked / verifying / done / failed / cancelled / skipped`。
**关键不变量**：最多一项 running（spec 除外）· 缺验收降级 `verifying`（**v0.43.0 推广为全模式：done 需 artifact，缺则降级**）· 终态不可逆 · 父 `done` 需子全终态 · `blocked` 必带人话理由。

**v0.43.0 轮次与本轮目标**：账本增 `round`（当前轮次）+ `item.round`（所属轮次）+ `goal`（本轮目标简介）；**plan-commit 含新建项且账本原有项 → 轮次 +1**（首次建计划不晋升），`goal = reason` 并经 `reconcilePlanItemsToGraph` 下推 `graph.goal` → 面板标题与「本轮任务 / 全部任务」两 Tab 据此分区；状态变更/replan 缺理由被门禁拒绝，replan 依据发 `turn_note` 入交互区。

**v0.39.0 在全生命周期上补齐的四件事**：

| 环节 | 能力 | 关键点 |
|---|---|---|
| 子任务 | `parent` 引用（`#序号` / id / 文本前缀三种写法） | 层级**最多两层**；判据唯一执法点在 `ops.ts`（解析 → 判层级 → 落盘三步，D185） |
| 重做 | `reopen` 算子 | 终态 → 进行中，`log` 留 `from`/`to`/`by`/理由四项；非终态项拒绝（「没做成过谈不上重做」） |
| 失败后重思考 | 失败摘要 + 阈值重排 | 摘要含「哪一步 / 失败几次 / **下一步建议**」（`digest.ts`）；同一 `itemId+tool` 连满 2 次触发规划通道重排 |
| 归档可追溯 | 审计 JSONL + 终态快照 | 环形 `log[]` 之外**永久追加** `audit.jsonl`；`sealLedger` 即归档（五条终态路径零遗漏），幂等（D187） |

**中断 ≠ 取消**（v0.37.0 修复的核心语义）：

| 用户动作 | 处置 | 未完成项 |
|---|---|---|
| 中断 / 暂停 | `park` | running → `paused`；pending **原样保留**；写恢复点 |
| 明确取消 | `discard` | 未完成项 → `cancelled` |

**续聊不重做**的三道保险：① `ensureLedger()` **已存在绝不重建**；② 恢复点按**产出物**判定（存在且校验通过 → `done`；不存在 → `pending` + attempts+1；无产出物声明 → 保持 `paused`）；③ 账本投影覆盖内存 `task.planItems`。

### 3.3 记忆：L1–L4 分层（`main/memory/`）

| 层 | 内容 | 落盘 |
|---|---|---|
| L1 | 工作记忆（当前会话 JSONL，含 reasoning 双通道） | 任务目录 |
| L2 | 会话级记忆（压缩 / 去重） | 任务目录 |
| L3 | 巩固（`l3b-archive` → `l3a-consolidate`） | **Agent 空间** |
| L4 | 合成（`l4-synthesize` → `distill-evaluate` → `skill-forge`，按周期触发） | **Agent 空间**；用户偏好归 Agent 空间，`memory.md` 归工作区 |

L2 以上按周期与任务终态触发，巩固结果经**暂存区**在下次运行生效，失败零写入。

### 3.4 插件与工作台（`main/plugins/` · `main/profile/`）

- **九类插槽**：`agent` / `tool` / `ui.panel` / `ui.renderer` / `ui.action` / `ui.homeModule` / `ui.theme` / `data` / `auto`。
- **三级作用域**：`bundled < global < workspace`；启用与副作用走**可逆 effect 账本**。
- **代码插件**：Host 侧跑在 `utilityProcess` 子进程（崩溃判死 + 双超时），Client 侧 `iframe sandbox`；能力经**能力网关**（`cap` 声明 ↔ 权限表结构对等）。
- 已知欠账（未接线项）见 `BACKLOG.md` 四·B 的 L-34-11…15 / L-35-04。

## 四、版本与工程约定

### 4.1 版本策略

- **版本号 = git tag = 应用版本号**（`app/package.json` 的 `version` 是唯一真源）。
- **版本克制**：仅 UI 或功能**大规模升级**才升大版本；小修走 `x.y.z` 补丁版。
- **文档先行**：架构级变更先出 `docs/versions/<ver>/`（`01-research` / `00-release-goal` / `02-prd` / `04-system-design`），门禁 `bin/validate_version_docs.py <ver>` 未过**禁写代码**。
- **测透再交**：用例库**累积继承** —— 最新版本的测试必须包含上一版本的全部用例；**冒烟全绿才展开详测**。
- **交付即用**：必须产出打包好的成品（`.app` / dmg / zip）。
- **环节闭环**：文档 → 开发 → 测试 → 交付，缺一不可。
- **收尾必落 git**（**先请用户确认**）：确认 → commit → tag → push。

### 4.2 用例与缺陷登记

- 用例 ID 形如 `TC-<组>-NNN`，**组内编号必须连续**（门禁把守）。
- 缺陷 ID 形如 `D<nnn>`，**连续且必须用标准表行** `| **D1xx** | … |` 登记（只在正文提及不算）。
- 用例矩阵 `testcases/00-cumulative-matrix.md` 的 §一 / §三 / §四 每版收尾必须用**逐文件实测**重写，**禁止批次累加报账**。
- 累计用例数（v0.37.0 起可对账）：`v0.36.0 2017 → v0.36.4 +80 → v0.36.5 +13 → v0.36.6 +8 → v0.37.0 +48 = 2166 → v0.38.x → v0.39.0 = 2370 → v0.40.0 +26 + 1 改写 = 2397 → v0.41.0 +48 + 3 改写 = 2445 → v0.42.0 +25 + 2 改写 = 2470 → v0.42.1 +7 + 1 改写 = 2477 → v0.42.2 +5 + 2 改写 = 2482 → v0.43.0 +9 + 2 回填 + 7 改写 = **2493**`（执行口径，已扣 runner `EXCLUSIONS` 1 条）。

### 4.3 代码纪律（改前必读，完整版见 `BACKLOG.md` §纪律区）

- **单一事实源**：白名单 / 枚举 / 平台判定 / 设计 token / 快捷键 / 注释剥离器 —— 每类只许一个真源。
- **接线类代码必须有「接线契约」用例**：断言**调用点存在**且**顺序正确**（函数全对但没人调 = 死代码）。
- **静默退化是复合缺陷的粘合剂**：容错路径必须在诊断通道留人话。
- **契约测试**：源码守卫断言前必须**剥注释**（唯一真源 `@shared/utils/source-guard`）；区分**形状校验**与**语义校验**。
- **语义变更必须同步改写既有契约**，且肯定/否定两条腿都钉 + 做反向核验（注入真实违规确认报红）。
- **降级路径三条件**：结果必被消费 · 必回退次级持久层 · 下游判据双通道对账。
- **「测试红」先分诊**是代码红还是环境/夹具红（抖动类：重复运行 + 换用例判定，并把测量证据写进报告）。
- **UI 文案**：面向用户的范围**包含插件自带界面**；禁 emoji 图标；快捷键只写逻辑和弦。

## 五、常见入口

| 我要… | 去哪 |
|---|---|
| 知道当前版本与主题 | `CHANGELOG.md` 发布索引 |
| 知道有哪些欠账与硬纪律 | `BACKLOG.md`（§纪律区 + 四·X 各版遗留） |
| 知道代码**现在**长什么样 | `ARCHITECTURE-ASBUILT.md` |
| 找目录 / 找命令 | `PROJECT-MAP.md` |
| 看清某版的设计与验收 | `docs/versions/<版本>/` |
| 查某版缺陷编号 | 该版 `testcases/00-cumulative-matrix.md` §三 |
