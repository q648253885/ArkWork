# ArkWork 变更日志（项目级）

| 项 | 值 |
|---|---|
| 用途 | 全项目**发布总日志**：每个版本的日期、主题与交付状态一览 |
| 粒度 | 本表只记「版本 → 日期 → 主题 → 状态」；**版本级明细**见 `docs/versions/<版本>/CHANGELOG.md` |
| 数据来源 | 历史条目回填自 git tag 与其目标提交（客观记录，不含推测）；明细以各版本 `docs/versions/<版本>/` 目录为准 |
| 建立 | 本总日志自 **v0.30.0** 起建立并回填（阶段八交付清单要求「版本级 + 项目级 CHANGELOG 双更新」，此前仅维护版本级） |

---

## 发布索引

| 版本 | 日期 | 主题 | 状态 |
|---|---|---|---|
| v0.16.5 | 2026-08-13 | 基线提交（ArkWork v0.16.5 源码） | 已发布 |
| v0.17.0 | 2026-08-13 | UI 交互重设计 | 已发布 |
| v0.17.1 | 2026-08-13 | Composer 玻璃感 + 任务列表状态筛选 / 计划进度 | 已发布 |
| v0.18.0 | 2026-08-14 | plan item 补丁广播 + todo UI 与摘要 | 已发布 |
| v0.20.0 | 2026-08-17 | v0.18~v0.20 中间态快照（engine / plan patch / registry） | 已发布 |
| v0.21.0 | 2026-08-17 | DSH 风格 UI 刷新 | 已发布 |
| v0.22.0 | 2026-08-17 | 交互区全面 DSH 化（user / assistant / reasoning / tool / shell） | 已发布 |
| v0.23.0 | 2026-08-17 | 交互区体验修复 + TraeWork 风格活动指示器 | 已发布 |
| v0.24.1 | 2026-08-18 | agent 自主浏览器 + 技能自动加载 + 计划清单容错 | 已发布 |
| v0.25.1 | 2026-08-21 | 浮窗功能对齐 / 交互提示视觉优化 / 模型选择持久化 | 已发布 |
| v0.26.0 | 2026-08-22 | 浏览器浮窗独立窗口重构 / 浮窗关闭自动收回侧栏 / IME 回车误发送修复 | 已发布 |
| v0.27.0 | 2026-08-22 | 流式管道 · 引擎/store 拆分 · 浏览器宿主统一（首个走完阶段八交付的项目） | 已发布（tag a97e43a） |
| v0.27.1 | 2026-08-23 | 市场 Tab 过滤已安装技能、记忆语义标题、ask_user 门禁重设计、终端主题修复、任务数据隐藏目录迁移 | 已发布 |
| v0.27.2 | 2026-08-23 | Tooltip 定位缺陷修复（文字溢出遮挡与贴顶压按钮） | 已发布 |
| v0.28.0 | 2026-08-25 | macOS 双架构构建（Apple Silicon arm64 + Intel x64） | 已发布 |
| v0.28.1 | 2026-08-26 | 修复 ReAct 循环中任务过早完成 | 已发布 |
| v0.30.0 | 2026-09-13 | 内核换代（TaskGraph）· Sync 五子阶段 · 任务面板 UI | 已发布（含阶段八后 D9 侧边栏状态同步修复；与 v0.30.1 同日发布，由 tag `v0.30.1` 一并覆盖） |
| **v0.30.1** | **2026-09-13** | **四问题修复补丁（i18n 插值 / 交互区可复制 · replan 待批准链路 · 功能完整性 · 顶栏重设计）** | **已发布（tag `v0.30.1`）** |
| **v0.30.2** | **2026-09-15** | **三问题修复补丁（L1 JSONL 并发写丢数据 · 续聊清单清空重建 · 思考内容运行时展开+完成后折叠）** | **已发布（tag `v0.30.2`）** |
| **v0.31.0** | **2026-09-17** | **大版本：文件工作台（CM6 编辑器内核 + 原子保存 + chokidar 监听 + Goto Anything）+ 交互区三层信息架构（真思考管道 + Turn/Step/Block）+ C1 视图收敛 + C2 LLM 任务标题 + C3 浮窗最小化恢复修复** | **已发布（tag `v0.31.0` / `f4ad03e`；875 条全绿 + 打包冒烟通过）** |
| **v0.31.1** | **2026-09-17** | **小版本补丁：v0.31.0 发版后用户双端实测缺陷集中修复（14 项，D19–D30）—— Windows 阻断级三项（快捷键全失效 / 语法高亮缺失 / 编辑器右键无菜单）+ WCO 主题同步 + OpenAI 端点双重拼接 + 品牌紫→业务蓝全局切换 + 交互区/输入区两态中性灰调色 + 低配性能降级模式 + CDP 调试端口** | **已发布（tag `v0.31.1`；940 条全绿 + typecheck/build 通过）** |
| **v0.32.0** | **2026-09-18** | **大版本：插件模式（Workbench Profile 垂直工作台）+ 交互区进程折叠（思考/工具调用可折叠，主展示要做的事与结论）** | **已交付（1017 条全绿 + typecheck 零错 + build 通过 + 打包冒烟通过；交付 mac `.app` + Windows 免安装 zip）** |
| **v0.32.1** | **2026-09-18** | **补丁版：回合终结收口与「正式输出」通道修复 —— D35 思考中断被静默当正常回合（超时吞掉 + 缺终止帧伪装 stop）/ D36 任务终结后清单不收口（图化丢 pending 兜底 + 图级 status 从不封口）/ D37 正文被原生思考遮蔽；真实环境实测追加 D38（成功路径漏封口 · 纯图级封口无广播 · 收口单向性 · 失败原因未留存）/ D39（task_complete 前未收口项守卫）；+34 用例** | **已交付（tag `v0.32.1`；1051 条全绿 + typecheck 零错 + build 通过 + 真实环境三场景 19/19 通过 + 包内 SHA256 回验；交付 mac `.app` + Windows 免安装 zip）** |
| **v0.34.0** | **2026-09-18** | **功能版：P1 空转终局（stall 六轮零产出 → paused + ask_user）/ P2 呼吸可读性 / P3 插件·能力·工作区重组（三 Tab + PluginsView 删除）/ P4 随包示例落盘（默认禁用）/ P6 契约修复（D54）+ D55 实机冒烟捕获** | **已交付（1286 条全绿；mac `.app` + dmg + Windows zip 已出）。⚠️ 仓库侧**未 commit、未打 tag**（docs/versions/v0.34.0/ 完整可查）** |
| **v0.34.1** | **2026-09-19** | **补丁版：空转守卫防误杀（narrativeSig 回落）+ 复制对话（T2 单源构建）+ 蒸馏清理 + Java 智能体 + 股票插件范例（面板取数通道 `panel:fetch`）** | **已发布（tag `v0.34.1` / commit `b1c8c50`，已推送 origin；1364 条全绿）。⚠️ 该版**未建 docs/versions/v0.34.1/ 文档目录**（正文分散在代码注释与 TC 载体中），属文档欠账** |
| **v0.34.2** | **2026-09-19** | **补丁版：D56 插件面板打不开（取数栈改 Chromium `net.fetch` 遵循系统代理 + 数据源主机 push2 → push2delay，实测 push2 为 ERR_EMPTY_RESPONSE）/ D56-c 竖排栏高度自适应折叠（可见名称 = min(3, 高度可容纳)，口径纠正取代 D54）/ D57 随包示例「未改动即升级」（修正送得到存量机器）** | **已发布（tag `v0.34.2` / commit `0c4b45a`，已推送 origin；1374 条全绿 + 双 tsc 零错 + build 通过 + `.app` 实机冒烟通过）** |
| **v0.34.3** | **2026-09-19** | **补丁版：D59 竖排栏「更多」弹层点不开（弹层渲染在 `overflow-x: hidden` 的栏盒内被裁成零宽 → 改 Portal 到 `document.body` + `position: fixed`）/ D58 折叠判定口径纠正（「在铺满的时候才有更多」—— 去 `≤3` 硬上限，改纯高度驱动 + 未测量不折叠）/ D60 菜单交互契约补齐（外部关闭排除触发器与弹层、`keydown` 白名单、Esc 归焦、↑↓ Home End、激活态样式）/ **D61 `http` 数据源被形状守卫白名单漏掉**（面板从 v0.34.1 起从未渲染 → 统一到单一事实源 `isPanelDataKind`）/ **D62 `derive` 派生列在投影后的行上求值**（引用未展示字段即静默退化为字面占位符 → 改面向原始记录 + 诊断不再静默）** | **已实现（1412 条全绿 + 双 tsc 零错 + build 通过 + mac `.app` 实机验证通过）。⚠️ 提交/打 tag 待用户确认** |
| **v0.36.0** | **2026-09-20** | **大版本：插件系统重构 + 记忆分层迁移（L3/L4 入 Agent 空间）+ 子 agent 并行 + 配置向导化（明细见 `versions/v0.36.0/`）** | **已实现（2017 条 / 0 fail + 双 tsc 零错 + mac `.app` 冒烟；⚠️ 索引行后补，v0.35.0 行欠账待回填）** |
| **v0.36.1** | **2026-09-22** | **小版本：交互区过程组（Process Group）—— 连续进程块（思考+工具混排、跨 step）整轮收成单个折叠组，摘要「思考 N 次 + 工具分列计数 + 耗时」；文本层级：白字正文（say/answer）独立高亮，过程低对比度可折叠；StepView 退役，TurnView 整轮一体化分段（设计 `versions/v0.36.0/13-process-group-design.md`）** | **已实现（本批 +2 用例；全量 158/159 文件绿，唯一红为存量权限 WIP 缺陷，与本版无关；双 tsc 零错 + build 通过 + `.app` 冒烟通过；⚠️ 提交/打 tag 待用户确认）** |
| **v0.36.2** | **2026-09-22** | **小版本缺陷批（D112–D114）：① 工具卡一行化 —— 路径只出现一次且可点击（FileLink/ChangeSummary 上移头行），结果摘要内联、完整结果可展开；② 文件树「全部收起」改为对已加载文件夹显式写 false（原清空表导致顶层回落默认展开），目录 toggle 加 300ms 双击防抖；③ 内置工作台克隆 id 修正为单点格式（`wb.research-edited`）并与既有台去重（设计 `versions/v0.36.0/14-v0362-fixes-design.md`）** | **已实现（本批 +5 用例；双 tsc 零错；提交/打 tag 待用户确认）** |
| **v0.36.3** | **2026-09-23** | **小版本四项（D115–D118）：① 交互区文件路径边界修复 —— 点击相对路径可打开（按工作区根解析），「路径越界」仅限大模型运行时的工具面，工作区外文件改为只读可预览并标出原因；② 动效降级 —— 删除所有高级动画（旋转/毛玻璃/扫光/位移动画），只保留基于透明度的纯色呼吸，`prefers-reduced-motion` + `html.perf-lite` 双降级，面向无 GPU 环境；③ 记忆收尾巩固管线 —— 任务终态触发 `l3b-archive → l3a-consolidate → l4-synthesize → distill-evaluate → skill-forge`，巩固结果经暂存区在下次运行生效、失败零写入，L4 按周期（首次 / 24h / 5 任务）合成，`memory.md` 归工作区、用户偏好归 Agent 空间；④ 帮助页与四语言用户指南整体更新（文件工作台 / 插件 / 工作台 / 设置与权限 / 性能与本地存储五章，快捷键表按键位唯一真源重写；设计 `versions/v0.36.0/15-v0363-memory-motion-path-design.md`）** | **已实现（本批 7 个新载体 + 1 个改写载体共 69 条；全量 164/165 文件绿，唯一红为存量权限 WIP 缺陷；双 tsc 零错 + build 通过 + mac 双架构 dmg/zip + Windows 绿色免安装 zip（`ArkWork-0.36.0-win-x64.zip`，Win10/11 x64）打包 + 启动冒烟通过；⚠️ 提交/打 tag 待用户确认）** |
| **v0.36.4** | **2026-09-24** | **缺陷批五项 + 性能增强（D119–D123 · PERF-1，Windows VM 实测 + macOS 复测）：① D119 原子写加固 —— `db.ts atomicWriteFile`：rename 锁重试 ×4（25–200ms 退避）+ unlink 再试 + 直写兜底，automations/sync 同步收敛，图落盘失败提示带 Windows 排查建议；② D120 任务标题 —— 轻量模型旁路（`lightweightModelId`，OpenCode small_model 范式）+ 超时 45s→120s + 任务终态 `.finally` 重试；思考保留（用户裁决）；③ D121 交互区执行锚点 —— TaskAnchor 卡片恒显核心任务（graph.goal）/正在做（焦点节点 title+intent，与 S1 投影同口径）/用户意图（标题+首条消息），全部 LLM 规划产物（用户裁决否决机械锚块；对照 Claude Code/ZCode/OpenCode 调研见设计 §五）；④ **D123 续聊重做根治（平台无关，用户报「非常严重」）**—— 双通道漂移三级修复：`applyPlanItemStatusesRobust` 两级定位（planItemId 直查 → `T-{index+1}` key 兜底）/ act.ts 消费图写结果 + NOT_FOUND 回退直写 + 降级告知模型 / 完成守卫双通道对账（镜像已终态项不再算 leftover）；配套 D122：run-setup 无 graphId 先查 specs 索引收养既有图再判迁移（杜绝过期清单重建第二张图），saveGraph 第③步写失败不再中断镜像回写；⑤ PERF-1 —— 设置页性能模式三态（auto/on/off）+ VM 漏判修补（gl=disabled/overridden 计入软件渲染）+ perf-lite 下流式攒批 40–80ms→150–250ms（正文权威数据不受影响）（设计 `versions/v0.36.0/16-v0364-windows-compat-design.md`）** | **已实现（全量 **2097 用例 0 fail**（2017→+80：TC-ATOMIC/D120/D121/D122/D123/PERF2 六套新载体）+ 双 tsc 零错 + 版本文档门禁全绿（补录 D112–D118 标准登记行）+ build 通过；⚠️ 提交/打 tag/打包待用户确认）** |
| **v0.36.5** | **2026-09-24** | **任务树同步三缺陷修复（D124–D126，对齐 ZCode todo 机制；用户导出会话实测「中断/续聊清单不更新」）：① D124 —— doc-driven 计划 prompt 补 Tier-0 对话级出口（只读任务 → `[]`，不再强配 10 阶段清单）；② D125 续聊强制重评 —— 计划注入前缀改中性权威快照（退役「请严格按此计划执行」）/ plan-constraint 冲突句改写为「先按『续聊指令与清单』同步、未经批准不得整体作废」（sections + prompt-assembly 双份同步）/ 新指令型续聊 hint 内联整棵树快照（`renderPlanTreeSnapshot`）+ 硬性「先同步、后作答」，答复型续聊清单不变（D12 v2 不变量）；③ D126 段末完成检查 —— 引擎每轮维护 `itersSinceTreeTouch`，≥10 轮未触碰任务树且有未收口项 → 注入「检查任务树」提醒 + 树快照（ZCode todo_reminder 对应物，触发归零防刷屏）（设计 `versions/v0.36.0/17-v0365-plan-tree-sync-design.md`）** | **已实现（新增 13 条 + 改写 TC-REGEN-004；全量回归 172 文件 / 171 过 / 1 挂 = v0.36.3 起已知 WIP 遗留 permission-rules-ui，与本批零交集；双 tsc 零错；⚠️ 真机 Electron 冒烟 + 提交/打 tag 待用户确认）** |
| **v0.36.6** | **2026-09-24** | **任务树同步强约束 + 追加批（D127–D130，v0.36.5 后续聊清单不更新仍复现的根治）：① D127 —— 段末提醒判定去「有未收口项」自设前置，改纯轮数（对齐 ZCode runtime-reminders，全终态但已过时的树同样提醒）；② D128 续聊零写树完成硬门禁 —— 新指令型续聊挂「树同步欠账」（run-setup 判定 → loop 欠账满额启动 + 零写树事实维护 → turn-end 完成守卫在 syncModelClaim 之前拦截首次零写树 task_complete：要么 task_create/replan 把新工作挂树、要么 todo_update 留痕「对话级续聊，清单不变」，仅拒绝一次防死循环；对齐 ZCode target.ts 完成前强制检视 + OpenCode reminder 语义）；③ D129 同轮并行写图竞态修复（追加批，mueyku3g-mqlt 图审计实锤：同轮 3 个并行 todo_update 仅 1 个存活）—— `plan-sync.ts:commitStatuses` 按图串行化（每图写锁 + 锁内重载 base），并行 todo_update 不再 last-writer-wins；④ D130 答复型收尾绕门禁修复（追加批）—— 模型不调 task_complete 直接给最终答复时，loop 最终答复分支在封图前同样过「续聊零写树」守卫（拒绝一次，与 D39/D128 共用计数源；拒绝文案单源 `emitTreeSyncRefusal`，双通道口径一致）（设计 `versions/v0.36.0/18-v0366-tree-sync-enforce-design.md` §一~§八）** | **已实现（新增 8 条 TC-ENFORCE-001..008 + 改写 3 条 TC-PTREE；全量回归 173 文件 / 172 过 / 1 挂 = 已知 WIP 遗留；双 tsc 零错；⚠️ 提交/打 tag 待用户确认）** |
| **v0.38.0** | **2026-09-26** | **任务清单控制面收敛 + 实机韧性五连修**：D154 清单工具收敛为 `task_plan` 单入口（9 旧名下架）+ D157 三份显式集合（写入口/下架名/清单族）与三守卫 + D158 测试 runner 提速（`node --import tsx/esm` 直启 + repo-scan 共享快照，守卫套件 242s→96s）+ **D159 工具名形态归一化**（模型输出连字符 `task-plan` 在唯一摄取点归一，派生式别名表）+ **D160 伪工具调用止血**（模型把调用"演"成正文 → 连续 3 轮判定并优雅暂停，人话说明经 NoteBlock `engine-stop` 通道可见；实测 21 轮空转 8 分钟 → 3 轮 17 秒）+ **D161 思考开关**（`LlmModel.think` 配置 + `/no_think` 追加到最后一条 user 消息；Ollama 形态端点默认关闭——思考会压掉原生 tool_calls）+ **D163 重启回收跟工作区走**（`settings:activate-workspace` 后补跑 reconcileStaleTasks，修复重启后虚假「运行中」）+ **D162 测试分片并行**（`TEST_SHARDS=N` 多进程分片 + 每片独立 TMPDIR 防互删） | **已实现（实机验证：D159/D160/D163 见 .app 截图取证；D161 未最终验证 tool_calls 恢复；测试提速实测受沙箱 CPU 限制，需用户终端复测）** |
| **v0.37.0** | **2026-09-25** | **大版本：任务清单**唯一真相源**（`agent/ledger/` TaskLedger —— 单一写入口 `mutate` + per-task 串行锁 + `revision` 乐观锁 + tmp+rename 原子落盘）+ **中断/续聊语义修复**（D131 中断走 `park` 保留、取消才 `discard`；D135 禁止用过期清单重建第二张图）+ **统一完成门禁 `guardFinish()`**（覆盖 task_complete / 最终答复 / 超迭代 / 用户中止四路径，D134）+ **模型自选任务模式**（`set-task-mode` 工具声明、引擎 `inferMode()` 兜底，**取消 UI 层 T1–T4 档位选择并收回 v0.30.1 的 tier 升降级下拉**，D137）+ **提示词四层**（L0 不变量 / L1 每轮清单快照 + 恢复点 / L2 输出层次契约 / L3 运行期提示）+ **交互区输出层次**（`answer-layers` 纯解析 + `AnswerBlock` 分层渲染：结论 / 变更 / 验证折叠 / 下一步，缺段显式占位）；配套 D132/D133/D141 三处第二/第三写入者收敛、D139/D140 分层实现缺陷；新增 48 用例（LED/WIRE/E2E/LAYER/UIMODE 五组）；收尾补 D142–D148（旧契约未随语义改写 / 死 import / 夹具缺 `kind` / `fs/watch` 时序抖动挂账 / runner 并发旋钮 / `delegate-parallel` 时序脆弱挂账 / **测试夹具临时工作区泄漏**——实测 TMPDIR 累积 7622 个 `arkwork-*` 项，是「越跑越慢、越跑越红」的放大器，已交付 runner 前后清扫 + `NODE_OPTIONS --import` 进程退出清扫两层收口，实测 9420 → 1799、残留 0）；`app/package.json` 版本 0.36.0 → **0.37.0** ** | **已实现（交付物见 `versions/v0.37.0/`；实测口径与红灯归因见 `versions/v0.37.0/05-function-test-report.md`）** |
| **v0.38.1** | **2026-09-26** | **验证收尾小版本（D164–D176）**：D164 单测 runner node18 自适应（双 loader 链 + 分片并行默认开启，本机 0.7s/文件）+ D165 LED-022 台账缺记修 + D166 下架工具名残留清理 + **D167 Ollama 原生 `/api/chat` 通道**（D161 关思考三通道被 `/v1` 实测证伪后的根因修复；**触发收紧为显式 `think=false` 才走原生**，其余行为不动）+ **D168 无工具纯答复停滞守卫**（NO_TOOL_STOP_ROUNDS=4 有界暂停 + 人话说明）+ **D169 Tier-0 显式空清单短路降级链**（模型输出 `[]` 立即短路，不再被精简重试强扭成清单）+ **D170 对话级自动降级**（plan 显式空 → chatMode，纯对话答复即终局，兜底占位项显式收口——「你好」不再被任务化走守卫链）+ **D171「就此结束」硬终局**（`Suggestion.action='finish'` 结构化动作 → onStop=cancelTask，点击/Enter 双路径，不再把 label 发回模型空转）+ **D172 续聊清单边界收窄**（分析/调研/评审/方案类属实质工作应建轻量清单；内置 agent version→0.38.1 触发存量同步）+ **D173「计划生成失败」降级卡可关闭**（终态自动清理无 graphId 降级闸门 + 手动关闭 IPC/✕ 按钮）+ **D174 续聊清单重评估结构对账**（`reconcilePlanItemsToGraph`：缺节点补建 id=item.id、多余节点 cancelled 留痕、全量对齐幂等——账本/图双通道漂移根治）+ **D175 清单重评估配对门控与文本保真**（`textSimilarity` bigram Jaccard ≥0.2 才兜底配对防「整体重制计划」被错配；`retext` 算子 + plan-commit 应用 layout.text——坦克大战现场 8 条新文本不再蒸发）+ **D176 成果产物门禁**（用户裁决：每项必须有产物、引擎核对后才可收尾——task_plan 增 artifact 声明 + `set-artifact` 算子 + `verifyArtifacts` 只读存在性核对 + guardFinish `ARTIFACT` 判定（唯一计数/超限放行）+ 内置 agent version→0.38.2）+ **D177 正则清单提取回退**（用户裁决：局域网弱模型也要能完成任务生成/替换——`plan-regex.ts` 纯函数提取器（fenced JSON/outline 两形态、宁缺毋滥）+ `plan-commit-pipeline.ts` 共享落库管线（task_plan 与正则回退两入口收敛）+ loop 无工具分支接线（提取成功代为登记 actor='plan-regex'）；实机 0.8b 验证清单落账本 + 真实 fenced JSON 输出 10 项全量正确解析）；打包版 .app 实测矩阵回填（S1 ✅ / S2 ⚠️ 模型能力边界 / S3 ✅ / S4 ✅ / S5 ✅ / S6 受限）；任务功能三家族调研（ZCode/OpenCode/DeepSeek Harness）落盘 §五·a；**适配影响面复核：全部改动不含按模型名/provider 的 prompt 或流程分支，不影响其他模型** | **已实现（双 tsc 零错；详见 `versions/v0.38.0/05-v0381-verify-batch-design.md`；⚠️ 提交/打 tag 待用户确认）** |
| **v0.39.0** | **2026-09-27** | **小版本：任务清单的「规划通道 + 弱模型韧性 + 全量清创」**。① **规划通道（Planner Pass）新建**：`agent/planning/{types,policy,prompt,parse,digest,runner}` —— 一条**不带工具、短上下文、独立于 ReAct 轮次**的 LLM 调用，专做「现在该做什么、按什么顺序做」，把「任务清单必须单独与模型交互一次」这条设计落到 W1–W4 四个接线点（开局 / 连续失败达阈值 / 陈旧 ≥10 轮 / 用户新指令），全部失败静默回落既有链（**不影响正常 LLM**）；② **统一解析器**（`parse.ts`，5 层降级 JSON→fence→repair→checklist→outline）取代 `plan-regex.ts`，含 S1–S5 安全不变量（解析出的 `done` 一律降级 `todo`，D181）；③ **子任务两层结构**（`parent` 引用三形态 + 层级 ≤2 + 快照复合编号 `1.1` + I5 生效，D185）；④ **重做 `reopen` 算子**（终态→进行中，`log` 留 `from/to/by/理由` 四项留痕）；⑤ **归档可追溯**（审计 JSONL 永久双写 + 终态归档快照 + 幂等，D187）；⑥ **失败后重思考闭环**（失败摘要含「哪一步/失败几次/**下一步建议**」+ 连满 2 次触发规划通道重排，W2）；⑦ **六个判据缺陷收口** D178（门禁放行收口在途项）、D179/D182（文本解析降到伪调用与停滞守卫**之后**且不旁路计数）、D180（拒绝计数写失败 → 有界放行，双方向都不再静默）、D183（删第二套完成守卫）、D184（failed/cancelled/孤儿路径补 `sealLedger`）、D188（**两处"判据恒假"的假守卫**：`planGateHit` 依赖已下架 `submit_plan`、`shouldCommitRegexDraft` 两个守卫参数被写成字面量 `false`）；⑧ **清创** D186 + **D189（D186 又漏网 2 处）** + **D190（`task_plan`/`turn_note` 反而没有展示条目，历史名 `todo_update` 却留着）**；⑨ `app/package.json` 版本 0.38.1 → **0.39.0**；⑩ **收敛清账（第二轮）**：全量并发扫描 7 红 → 串行复验 6 环境红 / 1 代码红 —— 代码红为 `v018-todo-ui-and-summary` 旧断言随清创失效（**反转**为 TC-GUARD-012 双向钉死），环境红根因为 **D191「并发跑两个 runner 会互相摧毁证据」**（slot 目录与 TAP 日志名只按序号命名 → 夹具互踩 + 日志互相覆盖，6/7 红**连报错原文都取不到**）→ runner 临时目录/日志名改为按 `process.pid` 命名空间 + `prune` 跳过非本 run 的 slot（W20，TC-HARN-004 把守）；⑪ **文档一致性自查（第三轮）**：逐条核对「代码是否与文档一致」补登记 **D192** —— ① 降级链 **5 层**被文档与代码注释同时写成"四级"（入口链式调 5 个 `parseXxx` + `PlanParseVia` 5 成员 + 矩阵 L1–L5 三处互证）；② §二模块树仍描述 `engine/plan-regex.ts` 为「薄封装保留导出名」，而该文件**已整体删除**（`PlanItemSource` 的 `'plan-regex'` 只剩数据留痕标签）；⑫ **全量回归（第四轮）→ D193**：192 文件 / 2726s → fail=9，串行分诊为 **6 环境红**（沙箱「运行时文件规则」池被 7 路并发耗尽）+ 1 已挂账抖动（`fs/watch`）+ **2 真红**（3 条既有断言被本版**合法**变更打破：D188 删 P8 死分支 / W4 加 run-setup import / D180 加分支内提前投递）→ 改为分支感知或反转回潮断言后 `fail=0`；新增纪律 **㉞**（受影响子集由 diff 推导 + 收尾必须至少跑一次全量）；⑬ **打包交付（第五轮）**：macOS `.app` 交付（`release/mac/ArkWork.app`，x64 = 宿主原生架构，557 MB，`app.asar` 内 `version=0.39.0`、Electron 33.4.11，非依赖条目 23 条全在白名单内；宿主为 Intel，**交叉打 arm64 会因缺 `@napi-rs/canvas-darwin-arm64` 产出坏包**故不做）；`tar-stream@undefined` 警告经证据链归因为**上游 dugite 的维护者侧脚本依赖**（运行时入口不 require）→ cosmetic 不修；⑭ **产物扫现场 → D194**：asar 内发现 `/out/.arkwork/b2-smoke/result.json`（354 B，一次 `ok:false` 的历史冒烟结果）随包出货 —— 根因是 `dev/b2-smoke.ts` 早期版本用 `resolve(__dirname,'..','..','.arkwork',…)` 推产物目录（electron-vite 把主进程打进 `out/main/chunks/` → 落进被收进 asar 的 `out/`），源码早已改成 `app.getAppPath()` 但**现场没清**且 `electron-vite build` 不清 `out/` → 删现场 + 重打包（asar 非依赖条目 26 → 23）+ 两条扫现场守卫（TC-CLEAN-008/009，含反向核验）→ 新增纪律 **㉟**（修根因 ≠ 清现场）；⑮ **失败诊断复查 → D195 / D196**：D195 规划通道不可解析时**只留分类词、丢掉模型原文**（既有计划链从 v0.15 起一直记 200 字原文）且 `skipped` 借用 `'aborted'` 与"用户中止"混淆 → 新增 `clipRawForLog`（200 码点 / 裁空白 / 换行折叠 / 不劈代理对）+ 原文只进日志不进用户面 + 新增 `'unparsable'`（TC-PLANCH-012/013）；D196 **纯转发壳导出 4 处**（`runner.ts` 的 `draftFingerprint`、`project.ts` 的 `assigneeLabel`、`task-title.ts` 的两个多余导出、`shared/types/graph.ts` 的 `assigneeLabel` 定义）→ 全删 + TC-CLEAN-010（检测器含门面链排除与 3 条自检；Level 2 模块图因误报率高不入用例）；**D197 空响应防御"只有入口没有出口"**（用户实机日志暴露：补试用尽后空回合顺着「未调工具 ✓ + 清单无未完成项 ✓ + 未截断 ✓」被判为**最终答复**，用**空 summary** 把任务封成 `completed` —— 用户看到一条空白「答复」而任务已 done）→ 补第三级处置（就地优雅暂停，**不封任何终态**）+ summary 三级兜底（**永不输出空串**）+ TC-EMPTYG-005/006（终局类 + 真执行）；**D198 暂停提问「有写无读」**（实机 UI 验收暴露：引擎 **9 处**暂停点都写 `Task.pendingAskUser`，渲染层却**零消费者** → 当场看着它暂停可见完整提问，**刷新 / 重开 / 切走再回来**就只剩无因由的「已暂停 · 等待你的指令…」，D52/D65/D160/D168/D197 五处精心写的人话全部丢失；而 `loop-stall-guard.test.ts:138` 早就断言「必须写 pendingAskUser，否则重开任务时问题丢失」—— 字段本就是为「重开」而留，缺的只是读者）→ 渲染层新增纯函数 `resolveAskUserQuestion`（活体事件 ∪ 持久化字段，`@@ARKWORK-PURE@@` 真值表钉死，渲染层首个真执行缝用例组）+ `Composer` 接线 + TC-ASKP-001..005。缺陷总数 **D178–D198（21 条）** | **已实现（新增 9 组 73 条 + 既有套件回填 4 条，用例矩阵按逐文件实测回填 2370 条；缺陷 D178–D198（21 条）；D188/D189/D190/D191/D194/D197/D198 均已反向核验"修复前真报红"（D191 做了两轮：`if (false && 判据)` 曾躲过子串正则 → 判据收紧为"必须是 `if` 首个条件"；D194 注入 `resolve(__dirname,…)` + 造残留 → TAP `# fail 2`，还原 → `# fail 0`）；全量 192 文件 2726s 实测 9 红已全部归因（6 环境红 + 1 挂账抖动 + 2 真红已修）；产线侧 x64 `.app` 已产出并逐项校验；门禁 `validate_version_docs.py v0.39.0` 全绿（77 用例 ID / 11 组）；全量 194 文件实测 7 红已串行复验为**全环境红**（沙箱文件规则池耗尽，逐文件 `fail=0`）；产线侧 `.app` 已按 D197+D198 重打包；⚠️ 提交/打 tag 待用户确认）** |
| **v0.40.0** | **2026-09-27** | **小版本：清单操作独立通道（PlanOps）+ 弱模型协议韧性**。起因是用户实机诉求「任务清单的生成 / 修改 / 完成确认 / 取消 / 重新规划都要**单独请求大模型**一次，保证 qwen3.5 9b / 0.8b 也能稳定产出」+「我使用其他 agent 都可以正常交互，没有 ArkWork 出现这样的问题」。① **根因裁决**（`versions/v0.39.0/evidence/04-empty-response-root-cause.md`）：三组合计 10 次端点实验证明 —— 25 工具 + 长 system（in≈3965）下，**Ollama 类端点走 `/v1` 必空**（`tc=0 / content=0ch / reasoning=217ch / out=131`，精确复现实机空响应），而**同等规模的原生 `/api/chat` + `think:false` 三次全部正常返回 `tool_calls`** ⇒ **主因在 Agent 侧**（通道选择 + 协议刚性 + 无兜底），模型侧只是诱因（「弱模型根本不会 tool_calls」的假说 H1 已证伪）；② **D199 通道修复**：`useOllamaNativeChannel` 由「必须显式 `think===false`」放宽为「非显式 `think===true` 即走原生」，非 Ollama 端点恒 false（I-O6 零影响）；③ **D200 清单操作独立通道**：新增 `agent/planning/ops/`（五类操作 `create`/`update`/`complete`/`cancel`/`replan` 各自一次**无工具、低温、有界超时**的窄请求 + 既有五层降级解析 + 既有 `commitPlanDraft` 管线），补上 v0.39.0 留下的夹缝 —— 此前「独立通道只管生成」而「正文解析只在**零**工具调用时生效」，模型调了 `file-reader` 却没调 `task_plan` 时**两条路都不覆盖**，清单永久停摆；④ **D201 空回合不停摆**：`pauseForEmptyResponses` 之前先跑一次 `update`，清单动了就继续跑（`force` 只豁免轮间隔、**不豁免预算**，不会变无限调用）；⑤ **D202 去「必须调用 task_plan」**：模型可见文案改为可选快路径，清单维护责任移交引擎侧（弱模型做不到时不再被判为「不用工具」→ 空转）；⑥ **D203** 失败诊断沿用 `clipRawForLog` 留原文（新通道带**真实** attempts：1=端点直接报错 / 2=问了两遍没问出清单）；⑦ 解析器 `allowDone` 放行开关（**默认 false**，既有两条路径零变化 —— 否则「输出完整清单」会把已完成项回退成待做）；⑧ 用例 **+26**（新套件 `plan-ops` 25 + `ollama-native` 回填 2；其中 **TC-OPS-024/025/026/027 四条是真机验收驱动的**），改写 1 条（TC-ON-001 `undefined → false` **反转**为 `→ true`）；⑨ **顺带真红分诊**：`protocol-shapes` TC-PS-003/004/006/008/009 五条因本版**合法**语义变更失效（它们测的是 `/v1` 形态却隐式依赖旧路由），改为**分支感知**（adapter 显式走 `/v1`；路由本身由 TC-ON-001 / TC-OPS-016/017 覆盖）后 `fail=0`；反向核验 **5/5 报红**（含一次注入点选错导致误判「用例失效」的修正 —— 注入必须打在**入口**而非下游默认参数）；⑩ `app/package.json` 0.39.0 → **0.40.0**；新增纪律 **㊴**（独立通道必须带节流三件套，预算优先于一切豁免）/ **㊵**（安全降级默认值须与放行开关分离）；登记 **L-40-01…06**（含**局域网 9b 未能由开发侧实测**、**工具定义占上下文 +361 token/个**、**`cancel` 操作目前无生产触发点**） ；⑪ **真机验收（打包 `.app` + 本地 `qwen3.5:0.8b`）抓出并修掉两条「静态审查与单测都发现不了」的缺陷**：**D204** —— 进展信号只认「工具执行成功」，而弱模型**从不调工具**（只输出正文）→ 通道永不触发（第一轮实测：清单只推进 1 次即停、`plan-ops` 日志**零命中**、6 轮后 D168 暂停）；根因两层 —— 判据缺 `hadProse`（只有正文也算进展 → `update`，**不走 `complete`**）+ **信号采集点被无工具分支的十几处 `continue` 跳过**（原放在 Act 之后）；**D205** —— 解析器覆盖不到真机实际输出形态：修好触发后 `plan-ops` 命中 2 次却**两次都 `unparsable`**（① 模型把同一段 JSON **说了两遍** → `json-repair` 取 `lastIndexOf(']')` 切出拼接串永远非法；② 输出 `[running] 文本` 行首形态 → `checklist`/`outline` 均落空）→ 改 `json-repair` **枚举每个 `]` 作候选终点** + `checklist` 收 `[状态] 文本`（内部 9 态词归一对外 5 态，不新增 `PlanParseVia` 成员）；用例 **TC-OPS-024/025/026**；**D206** —— 第三轮指标全部达标（清单变更 4 次、终态 `done`）但**细看内容是静默假成功**：五项被**全部标成 `done`** 而任务什么都没产出、`summary` 为空（D197 同族）；根因是「必须放行 `done`（否则清单倒退）」与「不许模型自证完成」的冲突 → 新增纯函数 `keepOnlyPreviouslyDone`（`create`/`update`/`replan` 只许**保留**已完成状态，新标 `done` 一律降级 `todo` 并留 note；`complete`/`cancel` 不过滤），用例 **TC-OPS-027**；**本轮真机共抓出 3 条缺陷（D204/D205/D206），全部为「静态审查与单测发现不了、只有真机数据能暴露」的形态**（对照 D198 的教训）；用例 **+4** → 合计 **2397** | **已实现（累积用例 2397 + 双 tsc 零错 + 版本文档门禁全绿（D178–D206 / 29 条 / 100 用例 ID）+ 反向核验 5/5 + 打包 `.app`（0.40.0）真机四轮验收；✅ main 已推送（`28509ce`）+ 17 个 tag；⑫ **CI 发布链路修复（本版附带发现）**：`app/package-lock.json` 的 version 停在 **0.28.1** 且 `packages[""]` 缺 `@codemirror/*` 全套等声明 → CI 的 `npm ci` **必然失败**（查历史 run 三平台全倒在 `Install dependencies`）—— 这就是**所有 Release 均 `assets=0`、从未产出安装包**的原因；已 `npm install --package-lock-only` 补齐至 0.40.0 并与 `package.json` 逐项对齐（deps 29 / devDeps 16 / optDeps 2，**差异 0**）；⚠️ 最终提交 `0b3f592` + tag `v0.40.0` 待推送（推送需 SSH 私钥，被沙箱规则 `/Users/gongzheng/.ssh/` 拦截））** |
| **v0.41.0** | **2026-09-28** | **小版本：终局补漏 + 弱模型正文工具降级通道 + 清单归档/层级 + 交互区对齐 ZCode**。① **D207 「就此结束」硬终局补漏**：D171 只堵了 chip，自由文本/Composer 输入「就此结束」仍被当新指令重排续跑（实机会话导出轮 #9 实证）→ shared 谓词四语言精确匹配 + `appendUserMessage` 在 transient cancel/runTask 之前拦截（未终态→完整 cancelTask+turn_note 回执；已终态→仅回执）+ AskUserGate 自由文本短路；② **D208 Ollama qwen3.5 正文工具降级通道**（用户裁决「开 think、让模型输出标准格式、解析后代为调用，只针对 ollama qwen3.5」）：谓词默认关闭（ollama 形态 + qwen3.5）+ `LlmCompleteRequest.think` 请求级覆盖（原生通道形态探针 + body `think:true`，thinking 走独立字段 content 保持可解析）+ 提取器（fenced/裸 JSON/**扁平键实机主形态**/别名/白名单防幻觉/repairJson/上限 4/去重）+ loop 回灌在动作收集点（合成动作流经原生 Act/预算/observation 链零旁路）+ 契约提示替换；③ **D209 清单归档与层级**：TodoPanel「全部」只显未终态 + 新增「已结束」归档 chip（计数与列表口径一致）+ 子任务缩进 16px×depth + 复合编号 `3.1`（planItemDepths/planItemNumbering 纯函数）+ PlanContent/PlanBlock parentIds 透传链；④ **D210 交互区对齐 ZCode**（探查报告五差距做四半）：say 降调+末条高亮（isSummarySource 首次接线）/ 无工具轮 say 兜底移除（同文双份根治）/ 过程组折叠行尾补结果信号（lastResultSummaryOf 失败优先）/ AnswerBlock 左主色边强调 / userOpen 入 store；⑤ **D211（实机抓出）**：tasks.migrate 逐字段重建漏 parentId → 重启后子任务层级静默消失 → 迁移层补字段 + TC-FH-006；⑥ 顺带真红：TC-FOLD-016（折叠条禁原生 title）→ 移除 title；TC-THINK-001/002、TC-FLOW-010 纪律㉔改写；⑦ 用例 **+48**（新套件 43 + 回填 5；★ 形态 mock 取自用户提供的 qwen3.5:9b 会话原文）合计 **2445**；反向核验 5/5；对标研究（ZCode/OpenCode/Trae）+ 核心链路生产级核查矩阵落盘 evidence/02；`app/package.json` 0.40.0 → **0.41.0** | **已实现（全量 200 文件 fail=1 文件=存量 WIP；双 tsc 零错；门禁全绿；打包 `.app` 0.41.0 x64 实机验收 A/B 通过（归档/层级/深浅色/0 失败资源）；✅ 已提交并推送（commit `095c96b` + tag `v0.41.0`，main 与 tag 均在 origin））** |

| **v0.42.0** | **2026-09-29** | **小版本：交互区 UI 对齐 ZCode（最终答复去蓝底留边线）+ 文件卡/任务卡学习 WorkBuddy（FileLink chip 化 / PlanBlock 卡片化+进度条 / TaskAnchor 标签 chip）+ 清单关联增强（产物摘要路径链接化 `path-links` 纯函数 + 子任务树线）+ git 插件对齐 VSCode 源控形态（暂存分组 / 单文件操作 / 内联 diff / 分支操作 / 提交两步化，零宿主改动，插件 1.1.0）+ 浮窗「编辑\|预览」分段控件替代渲染器下拉（rendererOverrides 机制保留，VIEW_MODES.editor 退役）+ **P5 追加批：交互区过程行对齐 ZCode（ToolBlock 去卡片化行式 / StateRail 竖条退役 / TaskAnchor 胶囊化「正在做」优先）**；新增 25 用例（TC-UI42 7/PLINK 6/VSEG 5/GITP2 7）+ 改写 3（TC-C1-001 / TC-FLW-004 / TC-COPY-001，纪律㉔），合计 **2470**；无新增 D 编号；L-42-01（git 面板放弃单文件不做，白名单无 op） | **已实现（全量 204 文件 fail=1 文件 = 存量 permission-rules-ui WIP，与本版零交集；双 tsc 零错；门禁全绿；P5 后重新打包 `.app` 0.42.0 实机 UI 验收 A/B 通过（深浅色 / 分组 / 内联 diff / 分段控件切换 / 过程行去卡片与胶囊锚点，证据 `evidence/01`）；⚠️ 提交/打 tag 待用户确认）** |

| **v0.42.1** | **2026-09-30** | **补丁版：弱模型收尾死循环根治（D212 终局引导）+ 清单层次规划引导（D213）**。用户实机 qwen3.8 27b「无法结束任务」，澄清「是因为一直无法结束，才导致到达上限的」——根因：task_plan 零变化 observation 与同参数拦截都无终局指引，完成门禁只在模型尝试收尾时运行 → 模型反复提交同一清单到 stall。修复：`PLAN_TOOL_HINT.endgame` 唯一文案源三处消费（act.ts 收口/零变化 observation 按 `openItems` 分场防误导提前收尾 + loop.ts 预算拦截清单族特化三注入点，指引指向 task_complete/最终答复=换层次，纪律⑩）；seed 三份 agent prompt §6 增「层级规划两级结构（主任务+parent 挂子步骤，≤2 层）」与「完成后立即收尾」，内置 agent 0.38.2→0.42.1 触发存量同步；纯函数 `endgameSuffixOf` 真值表 + 接线契约 TC-ENDG-001…007，反向核验 1/1 报红 | **已实现（继承 2470 + 7 − 改写 TC-MIGR-002b（版本钉 0.42.1，纪律㉔）= 合计 **2477**；全量 fail=1 文件 = 存量 WIP；双 tsc 零错；门禁全绿；重打包 mac `.app` + Windows zip 0.42.1；⚠️ 引导实效待用户 qwen3.8 复测（纪律㊶）；✅ 已提交并推送（commit `5436a5d` + tag `v0.42.1`，main 与 tag 均在 origin））** |

| **v0.42.2** | **2026-09-30** | **补丁版：spec 模式 done 不可达三联死锁根治（D214）**。用户实机 DeepSeek Flash v4.1：同一清单项被反复「完成」8+ 次（非弱模型专属，D212 同族不同根因）。三联：① I2 不变量使 spec 缺验收项 done 经清单路径永不可达（task_plan 无 acceptance 字段；artifact 不参与判定；写入顺序 artifact 后于 setStatus）；② 默认 agent defaultSkillIds 缺 S-core.task-complete（模型原话 "not in the function list"）；③ mutate 重建返回丢弃算子 warnings → 回执「完成」vs 快照 `[?]` 自相矛盾。修复：I2 补 artifact 出路（与 D176 门禁口径一致）+ plan-commit artifact 先落 + 新建项同判据；三份 defaultSkillIds 补 task-complete + agent 0.42.2 同步；OpResult/MutateResult/CommitPlanDraftResult 三层透传 warnings 进 observation | **已实现（继承 2477 + 5（TC-SDR-001…005 账本真执行）+ 改写 2（版本钉 → 0.42.2）= 合计 **2482**；全量 fail=1 文件 = 存量 WIP；双 tsc 零错；门禁全绿；反向核验 1/1；重打包 mac + win；⚠️ 实效待用户真模型复测；✅ 已提交并推送（commit `4e0373c` + tag `v0.42.2`，main 与 tag 均在 origin））** |

| **v0.43.0** | **2026-09-30** | **功能版：任务清单侧边栏五项升级（R1–R5）**。① **R1 标题=本轮目标简介**：面板标题取值链改为 `snapshot.goal` 优先 → title → 首条用户消息 → 「本轮任务」，命中 `/^未命名任务/` 一律跳下一级（根除「未命名任务」）；引擎 replan 时 `l.goal = reason` 并经 `reconcilePlanItemsToGraph` 下推 `graph.goal`（本版修复 goalText 漏传）。② **R2 档位可见可查**：档位徽章移到标题下方独立行 + **`Icon.Info` + 文字标签「档位说明」按钮** → `TierInfoPopover`（Portal 到 body 的 T0–T3 四档释义卡，逃逸裁切，纪律⑤）+ 判定理由作可见文本，**渲染前经 `sanitizeTierReason` 剥离内部迁移语言**（「迁移自 v0.29…」不外露），释义正文不再与档位标签重复（用户反馈三条修正 F11–F13）。③ **R3 去依赖图**：移除 DagView 挂载与树/DAG 切换段控，只留树视图（文件本体保留）。④ **R4 两 Tab**：`FILTER_KEYS ['all','todo','active','ended'] → ['round','all']`（本轮任务/全部任务）；账本引入 `LedgerFile.round` / `LedgerItem.round`，**plan-commit 含新建项且账本原有项 → round+1**（首次建计划不晋升、goal 仍落库），沿用项保留旧轮次 → 旧任务只留「全部任务」；面板**默认档 = 「本轮任务」**，「本轮」判据取自**账本快照**（`item.round === file.round`）+ `T-NN` 序号兜底（无命中归历史，只进「全部任务」），并修掉 `normalizeLedger` 漏收 `round` 致「读→规范化→写回」抹平轮次（实机才暴露，F14/F15/F16）。⑤ **R5 证据门禁**：状态变更/replan 缺 `reason` → plan-commit 拒绝（人话）；done 无 artifact → 降级 verifying（**I2 推广到全模式**，并修 `pending→verifying` 非法转换致整单失败）；replan 依据发 `turn_note`「本轮任务更新：${reason}（新增 N 项）」入交互区 NoteBlock。`app/package.json` 0.42.2 → **0.43.0** | **已实现（继承 2482 + 9（TC-V043-001…009 账本真执行/图真写入）+ 9（TC-ROUND-001…009 轮次判据纯函数 `round-filter`）+ 回填 4（TC-PANEL-HDR-010/011/012 + TC-LED-025）+ 改写 7（版本钉 + R2/R4 新结构，纪律㉔）= 合计 **2503**；全量 209 文件（执行 208，排除显式欠账 `e2e-memory-l4-llm`）：代码红 0（首轮 generate-plan 版本钉真红已修；`delegate-parallel` 为并发抖动，单跑复绿；`permission-rules-ui` 为**既有环境红**——夹具写在顶层 `before()` 而 runner 的 node v18.11.0 不承认顶层钩子，已定证、与本版零交集）；双 tsc 零错；门禁全绿；反向核验 3/3；**打包 `.app` 0.43.0 实机验收 R1–R4 通过**（含用户反馈三条修正 F11–F13 与第二轮两处 Tab 语义修正 F14/F15/F16 逐条复验通过：默认档 = 「本轮任务」、计数 9/33、旧轮次只在「全部任务」，证据 `versions/v0.43.0/evidence/screens/`）；⚠️ 引擎语义（replan 实时展示）待真模型复测；**多轮次分区已在实机（真实多轮账本）闭环**；✅ 已提交并打 tag `v0.43.0`（commit `711c54f`，tag 重指至该提交；**未推送**，待用户确认））** |
| **v0.43.1** | **2026-10-01** | **补丁版：实机验收缺陷批（D215–D218）**。**D215 终态广播冲掉 LLM 标题** —— 引擎 15 处 `broadcastTaskStatus({ ...task })` 直传内存副本，把运行期落库的标题冲回「未命名任务」（磁盘 tasks.json 正确、UI 错误）；修复 = 不变量「渲染层任务对象唯一来源 = store」：新统一出口 `broadcastTaskStatusStored`，15 处改走 `updateTask` 返回对象 + 源码守卫 TC-BCAST（反向核验 ✓）。**D216 重排后交互区无新计划卡**（旧卡因条数守卫冻结 0/9 与面板 12/12 矛盾）—— `commitPlanDraft` 含新建项落库后补发 `type:'plan'` 步骤（goal=账本轮次目标，自带持久化），渲染投影零改动，TC-PLANCARD-001…004 账本真执行。**D217 完成横幅「· tokens」空值 + 跳过口径** —— 纯函数 `all-done.ts`（tokens 无数据整段隐藏 + 「含跳过 N」）+ 四语言模板修正，统计语义（progressCounts）不动。改写 2 条既有契约（TC-EMPTYG-005 / TC-STALLG-008，纪律㉔）；**D218 实机白屏**（用户启动打包包截图：React #310 整层崩溃）—— D217 首版把横幅派生值写成 useMemo 且置于 TaskPanel 两个早退 return 之后，早退渲染 hook 数漂移 → 改普通派生计算 + 守卫 TC-BANNER-005（教训：早退 return 之后不得新增 hook）。**合计 2515**（声明 2516 = 2505 + 11，执行口径 −1）；全量唯一红 = 存量 permission-rules-ui（L-43-03，零交集）；双 tsc 零错；**L-43-01 闭合**（v0.43.0 replan 回执经实机证据确认）；新增遗留 L-43-04（tokensUsed 数据面）/ L-43-05（真模型复测） | **已实现（已发布：tag `v0.43.1` / commit `d793c16`，main 与 tag 均在 origin；打包见 evidence）** |
| **v0.44.0** | **2026-10-01** | **功能版：交互区产物链接化与产物卡（产物一等公民）**。用户实机反馈：答复里的产物路径（`docs/SIMILAR_PROJECTS.md`）只是纯文本不可点击。**R-A 产物数据可达** —— `PlanItem` 增 `artifact` + `toPlanItems` 透传（D198「有写无读」同型预防性闭环，TC-LED-026 账本真执行）；**R-B 产物卡** —— 第十二个块 `ArtifactBlock` + `TaskArtifactCard`（最后一次 task-complete 答复轮出卡，FileLink 点击打开，command 不进卡、去重、无产物不出块）；**R-C 路径链接化** —— 新组件 `LinkifiedText`（path-links 唯一判据分段，无损）接入 NoteBlock/SayBlock；复制对话导出同步（D69）。改写 TC-CMD-010（判别联合 11→12，纪律㉔）；**合计 2527**（声明 2528 − 1，闭合 2516+12）；双 tsc 零错；门禁全绿。Scope Out：AnswerBlock Markdown 正文内嵌链接化（产物卡承载可点击） | **已实现（已发布：tag `v0.44.0` / commit `d1cb94c`，main 与 tag 均在 origin）** |
| **v0.44.1** | **2026-10-02** | **补丁版：D219 最终答复整条丢失**。用户实机反馈（任务 T-20261002-2k584x）：任务完成后交互区只有过程旁白，模型写好的四段式总结（≈900 字，`steps.jsonl` 可证完整）用户看不到。根因 —— 模型偶发把控制工具写成连字符孪生 `task-complete`（D159 已登记形态），而 D159 归一化摄取点（loop.ts）**晚于** reason step 落盘/广播/L1 meta/事件（全在 reason-phase.ts 内）→ 落盘带原始拼写；引擎控制流拿到归一正名任务正常完成，但渲染层 `deriveConversation` / 投影 `origin` / `delegate` 摘要提取用正名精确匹配落空 → **assistant 最终答复整条不派生**。修复双管 —— **① 摄取点前移**（管新数据）：`normalizeResponseToolNames` 移入 reason-phase 响应落定处，loop.ts 保留幂等防线（TC-NORM-007 源码顺序契约）；**② 读侧容错**（管历史数据，不迁移用户数据）：新增 `shared/utils/tool-name.ts` 纯函数 `sameToolName`（`_`↔`-` 全串孪生），三处读侧接入（TC-TWIN-001/002 + TC-FIN-001…004 + TC-FLOW-003b）。反向核验：孪生回归用例修复前实测红（2 红）修复后复绿 ✓；**合计 2536**（闭合 2528+8，执行口径 −1）；唯一红 = 存量 permission-rules-ui（L-43-03，零交集）；双 tsc 零错。Scope Out：历史 steps.jsonl 迁移（读侧容错已覆盖）；日志面板 100 字截断（诊断通道有意设计）。新增遗留 L-44-01（实机复测） | **已实现（已发布：tag `v0.44.1` / commit `569abcb`，main 与 tag 均已推送 origin）** |
| **v0.45.0** | **2026-10-02** | **功能版：交互区打磨批（R-E/R-F/R-G/R-H）**。**R-E 产物写盘兜底** —— 产物卡第二数据源：除清单 artifact 声明外，收集 file-writer / file-editor 成功执行过的路径（时间序、去重、声明优先），修复「chat 模式 / 兜底单步清单从不声明 → 写了报告却无卡」的大面积空缺（TC-ART-012/013）；**R-F 每段复制** —— 新共用件 CopyButton（hover 浮出 + 1500ms 已复制 + 防冒泡）挂五类正文块（Answer 分层每段/未分层、Say、Note、User、Reasoning 展开态），文案复用四语言 markdown.copy/copied 零新增键（TC-COPYBTN-001…004）；**R-G Git 空态** —— 非 git 工作区不再红字直出：body.norepo 空态卡 + 初始化仓库按钮（走 git init 白名单 → 宿主确认 + 审计）+ 错误条改「一句人话 + stderr 折叠详情」（errSpeak 纯函数契约 TC-GITP3-001…004）；**R-H 侧栏三件** —— running 任务脉冲点（animate-pulse + 四语言徽标）、onStatusChange 未知任务头部插入（修复 task:list-changed 无订阅者：automation/delegate 任务实时入列）、automation 任务名 = 名称 + 触发时间（titleSource=user 锁定不变）（TC-SIDE-001…004）。多任务并行为既有能力披露（runner per-task，零引擎改动）。守卫联动 3 处（TC-TOKEN-003 / TC-MOTION-004 / TC-SMPL-029 均改实现未放水）；**D220 文件夹路径不可点击** —— 目录引用渲染为非交互 chip（main 新增 fs:path-kind 轻探测 + FileLink 目录态降级 + 产物卡 dir 直传，TC-GUARD-008/009 + TC-DIRK-001…003）；**合计 2555**（闭合 2536+19，执行口径 −1）；唯一红 = 存量 permission-rules-ui（L-43-03）；双 tsc 零错。新增遗留 L-45-01（真模型复测） | **已实现（已发布：tag `v0.45.0` / commit `8771929`，main 与 tag 均已推送 origin）** |
| **v0.46.0** | **2026-10-03** | **性能与低配适配专版（PERF-2）**：渲染层流式全量重投影根治（turn 级结构共享 + memo 四件 + derive 短路 + 签名 O(1)）+ 引擎每轮 O(n²) 收口（JSONL/JSON mtime 读缓存 + act_end 广播剥 result + checkpoint 节流 + memory:changed 节流 + deleteTask 缓存驱逐）+ 低配档（软渲染粘滞判定 → 次轮启动关硬件加速 + V8 堆上限 + perfMode 热生效 + spellcheck 关闭）+ 打包瘦身（renderer 专属依赖→devDeps，win zip 142→135 MB；echarts 异步 chunk）；D221（JsonCollection seed 污染存量隐患，测试当场暴露当版修复）；+41 用例 = **2596** | **已实现（224 文件全量唯一红 = 存量 permission-rules-ui；双 tsc 零错；门禁全绿；打包 mac `.app` + Windows 绿色 zip 0.46.0；实机热生效验收通过；⚠️ 提交/打 tag 待用户确认）** |

> 说明：`v0.29.0` 仅有设计调研文档（`docs/versions/v0.29.0/02-plugin-extension-research.md`），无代码发布与 tag，故不列入发布索引；v0.30.0 文档线基于 v0.29.0、代码线基于 v0.28.1。> 说明：v0.30.0 与 v0.30.1 同日交付，git 侧**只打 tag `v0.30.1`**（指向已包含两版全部代码与文档的提交），v0.30.0 不单独留 tag；四语言 README 已同步新增「最新版本」亮点板块。

---

## v0.30.0（2026-09-13）· 内核换代 + 任务面板

> 明细（代码清单 / 缺陷 D1–D8 回溯 / 有意偏离 V1–V5 / 验证结果）见 [versions/v0.30.0/CHANGELOG.md](versions/v0.30.0/CHANGELOG.md) 与 [versions/v0.30.0/08-delivery-checklist.md](versions/v0.30.0/08-delivery-checklist.md)。

| 项 | 内容 |
|---|---|
| 档位 | T3（中大型功能） |
| 版本判定 | UI 大规模改版 + 内核换代 → **大版本**（新建 `docs/versions/v0.30.0/`） |
| 文档产出 | `00-release-goal.md` / `01-research.md` / `02-prd.md` / `03-interaction.md` / `04-system-design.md` / `05-function-test-report.md` / `06-ui-test-report.md` / `07-ux-review-report.md` / `prototype/`（9 页）/ `testcases/`（累积矩阵 683 + 冒烟 676）/ `08-delivery-checklist.md` |
| 代码产出 | 内核 14 新 + 8 改（约 6,600 行）；UI/IPC 11 新 + 15 改（约 4,150 行）；IPC 频道 13 → 18 |
| 缺陷 | D1–D8 全部修复 + 三层回测 + 用例固化；D1 由**未被改动的继承套件**捕获 |
| 测试 | `npm run typecheck` exit 0；`npm test` 53 套件 · 0 fail（累积 683 条：继承 611 + 新增 72）；`npm run build` exit 0 |
| UX 校验 | 走查 P1–P8；X1–X5 缺陷 + X6–X8/X10 建议本版全修，X9 Scope Out S5；4 语言键集 1944 × 4 一致 |
| 交付产物 | `app/release/mac/ArkWork.app`（551M，`app.asar` 139M），内嵌版本 0.30.0；启动冒烟达 `[System] ArkWork ready` |
| 遗留 | U2 / U3（建议级，不阻塞）；真实 LLM 建图链路 + 像素级视觉/键盘流转 **UAT 待用户执行** |
| git 收尾 | 代码已 commit 至 `clean-main`；tag `v0.30.0` 不单独打，由 v0.30.1 覆盖 |

---

## v0.30.1（2026-09-13）· 四问题修复补丁

> 明细（代码清单 / 缺陷 D10–D11 回溯 / 有意偏离 / 验证结果）见 [versions/v0.30.1/CHANGELOG.md](versions/v0.30.1/CHANGELOG.md)。

| 项 | 内容 |
|---|---|
| 档位 | T3（跨 i18n / 主进程 / 渲染层 ≥12 文件，含 1 处面板顶栏重设计） |
| 版本判定 | 未达"UI 大规模改版 / 功能大规模升级" → 只升小版本 `v0.30.1`（铁律②版本克制） |
| 来源 | v0.30.0 交付后**用户实测反馈的 4 个问题** |
| 修复范围 | ① i18n 双插值修正 + 交互区全量可复制；② replan 待批准链路收口；③ 功能完整性补齐（preload `defaultPolicy`）；④ 任务面板顶栏三控件重设计（四语言标签 R5） |
| 缺陷 | D10（高，续聊复位误删待决补丁）、D11（低，`CardButton` 缺 `onClick` 类型错误）全部修复 + 回测 |
| 测试 | `typecheck` exit 0；全量 `npm test` **60 文件 / 737 条 / 0 fail**（≈16.8s）；冒烟 **709 全绿**；i18n **1955 键 × 4 语言** parity |
| 交付产物 | `app/release/mac/ArkWork.app`（551M），`CFBundleShortVersionString=0.30.1`；启动冒烟达 `[System] ArkWork ready` |
| 遗留 | S1–S5 记录待办；S6（真实 LLM 建图链路 + 像素级视觉/键盘流转）**UAT 待用户执行** |
| git 收尾 | commit + tag `v0.30.1` 已执行并推送 origin |

---

## v0.30.2（2026-09-15）· 三问题修复补丁

> 明细见 [versions/v0.30.2/CHANGELOG.md](versions/v0.30.2/CHANGELOG.md)。

| 项 | 内容 |
|---|---|
| 档位 | T2（修复补丁，只升小版本） |
| 修复范围 | ① L1 JSONL 并发写丢数据（`JsonlCollection` 写互斥 + 原子重写 + `mutate` 原语）；② 续聊清单清空重建 + replanHint 三选一分叉（D12）；③ 思考内容运行时展开/完成后折叠 + drift 无声明降级（D13） |
| 测试 | 用例库 737 → **755** 条全绿；`typecheck` exit 0 |
| 交付产物 | `app/release/mac/ArkWork.app`，启动冒烟通过 |
| git 收尾 | commit + tag `v0.30.2` |

---

## v0.31.0（2026-09-17）· 文件工作台 + 交互区三层信息架构（大版本）

> 明细（批次推进 / 缺陷 D14–D18 / 逐批测试账目）见 [versions/v0.31.0/CHANGELOG.md](versions/v0.31.0/CHANGELOG.md) · [versions/v0.31.0/testcases/00-cumulative-matrix.md](versions/v0.31.0/testcases/00-cumulative-matrix.md)。

| 项 | 内容 |
|---|---|
| 档位 | T4（两个新子系统 + 交互区数据模型换代 + 跨多轮会话交付） |
| 版本判定 | 功能大规模升级 + UI 大规模改版 → **大版本** `v0.31.0`（新建 `docs/versions/v0.31.0/`） |
| 方向一 · 交互区 | 真思考入管道且落盘（`onReasoning` / delta 级协议剥离）/ Turn → Step → Block 三层信息架构 / 工具类型化渲染 / 六态状态机 / 旧组件下线 |
| 方向二 · 文件能力 | CM6 编辑器内核（可编辑 + 原子保存 + 冲突三选一 + 关闭保护）/ chokidar 文件监听与三面同源刷新 / Goto Anything / 选中动作系统 / 交互区产物卡片 |
| 追加批次 | C1 编辑器视图收敛 + 思考折叠标签（用户裁决）；C2 LLM 任务标题生成（用户裁决，`titleSource` 三态）；C3 浮窗最小化恢复空窗修复（用户实测缺陷 D18） |
| 缺陷 | D14（高，符号键和弦永不匹配）· D15–D17（文档/口径）· D18（中，浮窗恢复空窗）全部修复 + 用例固化 |
| 测试 | `typecheck` exit 0；`npm test` **85 文件发现 / 执行 84 / 0 fail**（累积 **875** 条 = 继承 766 + 新增 109；冒烟 **845**）；i18n 四语言键集一致 |
| 交付产物 | macOS dmg/zip（arm64+x64）· Windows nsis + portable（x64，Win10/11）· Linux AppImage/deb；`app.asar` 逐批标记回验 |
| git 收尾 | 两笔提交（代码+测试 / 文档）+ tag `v0.31.0` |

---

## v0.32.0（2026-09-17 ~ 09-18）· 插件模式 + 交互区进程折叠（大版本）

**基调**：把 ArkWork 从「一个通用 agent 工作台」变成「可插拔多工作台的宿主」；
同时把交互区从「所有内容平铺」改为「过程折叠、结论前置」。两条线合一个版本交付。

### A 线 · 交互区进程折叠（需求 2）

参考 opencode / TraeWork 的交互区形态，落地「进程折叠」：

- 新增 `shared/utils/flow-fold.ts`（纯函数）：**连续性分组** —— 仅相邻同类块合成一段，
  `[reasoning, reasoning, say, tool, tool]` → 3 段；run id 取首块 id（虚拟化可复用）；
- 新增 `ProcessFold.tsx`：折叠条 = 标签 + **有信息量的摘要** + 耗时 + 失败徽标；
- 摘要规格（直击 TraeWork 被投诉的「空壳摘要」）：`思考 12.3s · 读取 ×3 / 搜索 ×1 / 执行 ×2 · 用时 45.2s`，零类别不出现；
- 展开态落 `store.flow.blockUiState[runId]`，**不用组件本地 useState**（虚拟滚动会重建组件，本地态必丢）；
- 三档 viewMode 策略：`compact` 全折叠 / `standard` 异常强制展开 / `detailed` 全展开；用户手动点击优先于一切自动策略。

### B 线 · Workbench Profile 插件模式（需求 3）

三层结构：`workbench.json`（纯数据）→ `WorkbenchProfile`（extends 链合并）→ `CompositionSnapshot`（装配快照）→ 视图投影。

- **槽位服务** `main/profile/slots.ts`：重复 id 直接 throw（不静默覆盖），返回 `Disposable`；
- **装配器** `main/profile/activator.ts`：事务性装配 + **五层降级记账**（技能 / MCP / 面板 / 命名空间 / 自动化）；
- **记忆命名空间** `core/`（跨台共享）+ `ns/<name>/`（域隔离），激活时幂等就绪并进快照；
- **引擎挂点**：G1 工具集「只加不减」叠加台内技能；G2 新增 `profile-context` system 段（order 180 / run-static 前缀缓存友好）；
- **切换 UI**：顶栏常驻台名 chip + 切换菜单 + 降级明细（红=阻断 / 橙=非阻断）+ **五层装配快照面板**；
- **内置三台**：`wb.base`（通用，零降级基线）/ `wb.coding`（代码开发）/ `wb.research`（研究）—— 一律内联 `personaText`，不引用既有 Agent 实体（避免 profile 与 agents.json 双向耦合）。

### 缺陷

D31（`extends` 子台省略 `data` 会致记忆命名空间被空串覆盖 → 装配必然失败；中危，用例暴露后已修）
· D32（设计文档五处口径与交付实况漂移；文档升级 v1.1）
· A1/A2（`var()` 颜色加透明度类静默失效 / CSS 契约取块错位 —— 均由 v0.31.0 既有门禁抓到）
· **D33**（实测：折叠条**点开后收不起来**。`setBlockOpen` 恒写 `userOpen:true` + 读数取自三态门闩，两处叠加；
  已修并由 TC-FOLD-011b / TC-FOLD-019 把守）
· **D34**（实测：`bootstrapProfile` 早退 → **第二次及以后每次启动五层插槽全空挂**（静默半死）。
  根因是「磁盘快照」与「进程内注册表」的错配；已修并由 TC-PUI-011 / TC-PUI-012 把守）。

### 门禁

`npm run typecheck` 双 tsconfig 零错 · `node scripts/run-tests.mjs` **1017 / 1017 pass 0 fail**（基线 940 → +77，新增载体 6 个）
· `npm run build` 通过（渲染主 chunk 零 `@codemirror` / `chokidar` / `lezer`）· 四语言 i18n parity
· 打包冒烟通过（mac `.app` 启动零 ERROR；包内 SHA256 与本地构建字节一致，见 `versions/v0.32.0/packaging-smoke-report.md`）。

### 交付形态（用户裁决）

**只交付 mac `.app`（未压缩，557 MB）+ Windows 免安装 zip（≈147 MB，解压顶层 `ArkWork/`）**；
不做 dmg / nsis / portable / mac zip，旧版产物已清除。

### 遗留

L7（既有记忆文件路径未按命名空间改写）· L10（台下 Dock 偏好未持久化）· L11（导入 UI 未做，IPC 已就绪）
· L12（namespace 模块无自动化覆盖）· L13（`personaText` 未注入人格段）· L14（无键盘和弦入口）
· **Windows 实机启动未实测**（本机无 Windows；已完成包内容回验，属未测未知区）。

### 过程教训（两条，均已写成纪律）

1. **凡「写一处、读另一处」的状态，必须配一条往返回归用例** —— D33 之所以躲过全绿，是因为三层守卫
   全在结构层（纯函数单测 / 源码契约 / slice 不可导入），「写入值 → 读出值」这条缝没有任何用例经过。
2. **凡「磁盘持久化 + 进程内注册表」双写结构，启动时必须以内存侧为准重放一遍** —— D34 之所以躲过全绿，
   是因为所有用例都在单进程内跑，**「模块级状态跨进程存活期」是用例完全没覆盖的维度**。

---

## v0.34.2（2026-09-19）· 插件面板打不开 + 竖排栏折叠

> 明细见 [versions/v0.34.2/00-release-goal.md](versions/v0.34.2/00-release-goal.md)（根因矩阵 / 口径纠正登记 / 实测证据）
> 与 [versions/v0.34.2/04-system-design.md](versions/v0.34.2/04-system-design.md)。

| 项 | 内容 |
|---|---|
| 用户复报原文 | 「插件打开失败，且侧边栏名称超过三个了！」+ 追问澄清「① 显示的侧边栏名称超过三个会挤压溢出 ② 右侧侧边栏栏目如果超过侧边栏容纳范围高度，需要有折叠机制」 |
| D56-a 取数栈 | `panel.ts` 从 Node 全局 `fetch`（undici，**不读系统代理**）改为 `pickFetch()` 优先 Electron `net.fetch`（Chromium 栈，遵循系统代理/PAC）；裸 `fetch` 调用点由用例锁死为 1 处 |
| D56-b 数据源主机 | 实机实测 `push2.eastmoney.com` 连代理都返回 `net::ERR_EMPTY_RESPONSE`（明文经代理 502）→ 自选股/详情改 `push2delay.eastmoney.com`（200 + 字段齐全），K 线保持 `push2his`（200）；三维运行时探针逐字段核过 |
| D56-c 竖排栏折叠 | 收纳规则由「插件 ≤3、内置全留」改为 **`min(名称上限 3, 可用高度可容纳)`**，内置与插件一视同仁；`ResizeObserver` 实测栏高；激活面板入口恒可见；被折叠项进「更多」（附快捷键）；新模块 `rail-tab-overflow.ts` 取代 `plugin-tab-overflow.ts` |
| D57 种子升级 | 随包示例落盘加 `.arkwork-seed.json` 指纹；「内容未改动」的副本**随版本升级**（含升级路径上无指纹的存量机器），用户改过的副本一字不动；`TC-SMPL-020` 拿上一版官方副本夹具把守「忘了声明迁移」这一静默失败模式 |
| 验证 | `node scripts/run-tests.mjs` **1374 / 1374 pass 0 fail**（基线 1364，新增 10 条 TC-SMPL，重写 9 条 TC-OVF）· 双 tsconfig typecheck 零错 · build 通过 · mac `.app` 重出并启动冒烟 |
| 交付形态 | mac `.app`（本机 Intel x64）。**v0.34.1 的包仍不可用**（面板数据源主机在真机不可达），本版为修正版 |

---

## v0.34.3（2026-09-19）· 「更多」点不开 + 「铺满才折叠」

> 明细见 [versions/v0.34.3/00-release-goal.md](versions/v0.34.3/00-release-goal.md)（根因矩阵 / 口径纠正登记 / 新纪律 ⑤⑥）、
> [versions/v0.34.3/04-system-design.md](versions/v0.34.3/04-system-design.md)（D58–D60 设计）、
> [versions/v0.34.3/05-plugin-mechanism-verification.md](versions/v0.34.3/05-plugin-mechanism-verification.md)（**D61/D62 + 插件↔Agent↔模型 关联普查 + 实机证据**）、
> 用例矩阵 [versions/v0.34.3/testcases/00-cumulative-matrix.md](versions/v0.34.3/testcases/00-cumulative-matrix.md)。

| 项 | 内容 |
|---|---|
| 用户复报原文 | 「整体验证，尤其是侧边栏，**在铺满的时候才有更多**，**现在的更多我点不开**。整体 UI 要合理，符合 UI 交互」 |
| D59 弹层点不开（阻塞） | 弹层用 `absolute right-full` 渲染在 `.inspector-toolbar` **内部**，该容器 `overflow-x: hidden`（`globals.css:1960`）且仅 **44px** 宽，弹层 `min-w:160px` ⇒ **整体落在裁切区之外，一个像素都看不见**（逻辑全对、DOM 也确实挂载了）。修：`createPortal` 到 `document.body` + `position: fixed`，坐标由新增纯函数 `utils/anchored-menu.ts` 按触发器矩形现算（含下半屏向上翻转、视口夹取、限高保底、非法输入兜底） |
| D58 折叠口径纠正 | v0.34.2 的 `min(3, 高度可容纳)` 含**硬上限 3**，导致「有 9 个名称、窗口完全放得下」时仍被强行折叠。用户本版给出真正规则 ⇒ 收敛为**纯高度驱动**：放得下就一条不收，「更多」只在**放不下**时出现；未测量（首帧 / jsdom）**不折叠**；`useLayoutEffect` 让首帧即测得真实高度（无闪跳）；`MAX_VISIBLE_NAMES` 退役为 `@deprecated`，`maxVisible` 参数缺省不限（要回旧口径只需传 `3`） |
| D60 菜单交互契约 | ① 关闭监听绑 `keydown` ⇒ **任意键都关**，键盘导航被自己人打断；② `mousedown` 关闭**未排除触发器** ⇒ 点触发器「先关再开」，表现为点了不切换；③ 菜单项有 `data-active` 但**无样式** ⇒ 看不出当前面板；④ 无 `aria-controls`、无键盘导航、Esc 不归焦。逐条补齐为 ARIA menu 模式 |
| **D61 http 面板从未渲染（追加）** | 形状守卫 `validatePanelData()`（`shared/utils/vlib-data.ts:46`）的 kind 白名单只写了 `static/file/mcp`，**漏掉 `http`** ⇒ 面板 http 取数**已经成功**（UI 显示「6 行」）却在渲染前被判「未知数据源 kind「http」」。修：导出 `PANEL_DATA_KINDS` + `isPanelDataKind()` 单一事实源，**全仓 3 处硬编码 `!==` 链一律改为调用守卫**（禁止再写链），并加 `TC-VD-013` 断言「常量与守卫逐字一致」 |
| **D62 行点击参数链断在派生列（追加）** | `mapHttpResponse()` **先按 `columns` 投影、再跑 `derive`** ⇒ 出厂清单 `derive: {secid:'{{f13}}.{{f12}}'}` 引用的 `f13`（市场码，本就不展示）已被投影丢掉；而 `applyTemplate` 对未命中变量**原样保留** ⇒ `secid` 退化成字面量 `'{{f13}}.600519'` ⇒ 详情接口 `data:null` ⇒ 浮窗「暂无数据」。修：**derive 面向「投影前原始记录 ∪ 已派生字段」求值**（`columns` 管展示、`derive` 管计算，并支持链式派生）；派生值仍含 `{{…}}` 时写进 `note` **点名**；面板 URL 替换后残留 `{{param}}` 直接判为 **error 并说明缺哪个参数**（不再发请求后报「数据为空」） |
| 用例 | 重写 **TC-OVF-001…021**（D58 语义，替换 v0.34.2 的 17 条）+ 新增 **TC-AMEN-001…012**（定位纯函数）+ **TC-MENU-001…012**（渲染契约）+ **TC-VD-012/013 · TC-PLG-020 · TC-PHTTP-011…014 · TC-SMPL-023…025**（D61/D62 回归，其中 D62 六条**经反向核验**：回退修复即报红 5 条）；新增 `testcases/01-smoke-suite.md`（P0 子集 + 8 步实机走查） |
| 验证 | **1412 / 1412 pass 0 fail**（1374 − 17 + 21 + 12 + 12 + 10）· 双 tsconfig typecheck 零错 · build 通过 · `docs/versions/v0.34.3/` 机械校验通过（45 条用例 ID / D58–D60 / 28 张表） |
| **实机端到端（经应用本体）** | ① 插件 http 面板渲染 **6 行真实行情**；② 点行 → 浮窗「个股详情」渲染 **11 列真实行**、URL 条显示 `secid=1.600519`，「日K线」渲染**真实蜡烛图**（涨红跌绿）；③ 插件 `setEnabled` ⇒ `ui.panel` 插槽 3→0、**侧栏即时 9→6 项**（免重启），恢复后回 9 项；④ 局域网 ollama `qwen3.5:9b` 真实对话（`POST /chat` 三次真实返回 87/256/63 tokens）。详见 `versions/v0.34.3/05-plugin-mechanism-verification.md` |
| 新增工程设施 | `app/scripts/ui-probe.mjs` —— CDP（localhost）实机探针：截图 + 读真实布局几何。它专门补上契约用例的能力边界（欠账 **L-34-08**：「在渲染树中」不等于「可见」） |
| 交付形态 | mac `.app`（本机 Intel x64）。实机验证走**应用连局域网 ollama**（`qwen3.5:9b` @ `192.168.31.57:11434`），不使用本机模型 |

### 本版沉淀的五条新纪律

1. **纪律 ⑤：「在渲染树中」不等于「可见」。** 凡浮层组件（popover / menu / tooltip / dropdown），
   用例不能只断言「被挂载」，必须覆盖一条**「逃逸出滚动/裁切容器」**的契约，并用实机截图确认它真的出现在像素上。
2. **纪律 ⑥：用户给的「阈值」要先问是「偏好」还是「症状描述」。** 「超过三个会挤压溢出」可能是偏好，
   也可能是**她的窗口恰好只放得下三个**。歧义时选「症状描述」并让机制自适应（此处 = 随高度自适应），
   因为它同时满足两种解读；反过来则会漏掉偏好 —— 本版正是踩了这个坑（把症状当成了偏好）。
3. **纪律 ⑦：白名单 / 枚举只许有一个事实源（D61）。** 合法值导出为常量数组 + `isXxx()` 守卫，
   全仓只许调用守卫；须有用例断言「常量与守卫逐字一致」；**表驱动穷尽用例必须遍历枚举全体**，
   不许挑选「看起来够了」的几个 —— `TC-VD-011` 只跑 `static`+`mcp` 就是漏掉 `http` 的直接原因。
4. **纪律 ⑧：夹具形状必须复刻生产形状（D62）。** 凡「声明式清单 → 消费者」链路，回归用例必须
   **直接取清单本身**作为输入，并**先断言前提**（前提变了要**响亮失败**，而不是静默失效）——
   `TC-PHTTP-005` 把 `f13` 也写进 `columns`，于是永远走不到出厂清单那条真实路径。
5. **纪律 ⑨：静默退化是复合缺陷的粘合剂（D62）。** 凡「取不到值就原样保留 / 返回空」的容错路径，
   必须在**诊断通道**留一句人话 —— D62 正是三重静默叠加（投影静默丢字段 → 模板静默留占位符 →
   空集静默显示「数据为空」），真正的「缺参数」原因永远浮不出来。

### 新增文档

`versions/v0.34.3/05-plugin-mechanism-verification.md` —— **插件 ↔ Agent 核心 ↔ 大模型** 的真实关联普查：
D61/D62 根因与修法、九类插槽的真实消费对账（只有 `ui.panel` / `ui.theme` 真生效）、
实机验证证据表 V1–V6、插件机制欠账 8 条（**模型侧零插件通道**等，已登记 BACKLOG L-34-09…15）。

---

## 变更记录

| 日期 | 原因 | 改动点 | 影响范围 |
|------|------|--------|----------|
| 2026-09-13 | 建立项目级总日志 | 依阶段八交付清单要求新建本文件；回填 v0.16.5 → v0.28.1 发布索引（来源 git tag + 提交记录），登记 v0.30.0 待交付 | 项目文档 |
| 2026-09-13 | v0.30.1 交付收尾 | 登记 v0.30.1（修复补丁）并新增版本概要节；v0.30.0 状态由「待交付」改为「已发布（由 tag `v0.30.1` 覆盖）」；补充 git 侧 tag 策略说明 | 项目文档 |
| 2026-09-13 | 仓库发布面更新 | 四语言 README（`README.md` / `.zh-CN` / `.ja` / `.ko`）新增「最新版本 — v0.30.1」板块（TaskGraph 内核 + v0.30.1 四项修复）与版本徽章；同步更新 GitHub 仓库 About 简介与 topics | README / GitHub 元数据 |
| 2026-09-17 | v0.31.0 交付收尾 | 登记 v0.31.0（大版本：文件工作台 + 交互区三层信息架构 + C1/C2/C3）并新增版本概要节；v0.30.2 状态由「git 收尾待执行」更正为「已发布（tag `v0.30.2`）」并补版本概要节；四语言 README「最新版本」板块更新至 v0.31.0 + 版本徽章 | 项目文档 / README |
| 2026-09-19 | v0.34.2 实现收尾 | 登记 v0.34.2（D56 面板取数栈 + 钉死数据源主机 / D56-c 竖排栏高度自适应折叠 / D57 随包示例未改动即升级）并新增版本概要节；**补登记 v0.34.0 与 v0.34.1 两条发布索引**（此前漏登记 —— v0.34.0 无 commit/tag，v0.34.1 已 tag 但未建文档目录，均在此如实标注） | 项目文档 |
| 2026-09-27 | v0.39.0 实现收尾 | 登记 v0.39.0（规划通道 + 统一解析器 + 子任务/重做/归档 + 失败重思考 + 六项判据缺陷 + 三处清创）发布索引；补记 v0.37.0 / v0.38.0 / v0.38.1 已在索引中但**本表长期缺口**（自 2026-09-19 起未追加行，此次一并补齐说明） | 项目文档 |
| 2026-09-27 | v0.39.0 收敛清账（第二轮） | ① 7 个全量红串行复验为 **6 环境红 / 1 代码红**：代码红 = `v018-todo-ui-and-summary` 旧断言随清创失效（反转）；环境红根因登记 **D191**：并发两个 `run-tests.mjs` 时 slot 目录与 TAP 日志名只按序号命名 → 夹具互踩 + 日志互相覆盖，**6/7 个红连报错原文都取不到**（架空纪律㉕的归因前提）；② 修 `app/scripts/run-tests.mjs`（临时目录/日志名按 `process.pid` 命名空间 + `prune` 跳过非本 run 的 slot，仅 2h 后回收陈年残留）+ 新增 **TC-HARN-004**（把命名表达式抽出**真执行**，并把判据锁到 `if` **首个条件**上）；③ 新增纪律 **㉝**（测试装置也要防"证据被毁"：同一时刻只跑一个 runner）+ **L-39-07/08**；④ 矩阵回填 **+2** → 合计 **2358**；缺陷登记补 **D191**（总 D178–D192） | 项目文档 / 测试装置（`app/scripts/`） |
| 2026-09-27 | v0.39.0 全量回归（第四轮） | `node scripts/run-tests.mjs` 全量 192 文件 / 2726s → **fail=9**；串行复跑 9 个 → **6 环境红**（`Brokered host mkdir/rename/link requires an available runtime file rule` —— 7 路并发耗尽沙箱文件规则池，D146/D164 同源）+ **1 已挂账抖动**（`fs/watch`，L-37-02）+ **2 真红**。真红共 3 条既有断言：`continuation-regen` TC-REGEN-003（D188 删 P8 死分支 → 反转为禁止回潮）、`tree-sync-enforce` TC-ENFORCE-002b（W4 加 import → 判据放宽）、TC-ENFORCE-004b（D180 加提前投递点 → 改分支感知）→ 复验 `fail=0`。**过程教训**：首轮「受影响子集」按名字联想挑目录，漏掉改动最重的 `agent/engine/__tests__` → 登记 **D193** + 新增纪律 **㉞**（子集由 diff 推导 + 收尾必须至少跑一次全量）。缺陷总数 **D178–D193（16 条）** | 项目文档 / 测试 |
| 2026-09-27 | v0.39.0 文档一致性自查（第三轮） | 逐条核对「代码是否与文档一致」补登记 **D192**：① 降级链 **5 层**被文档与代码注释写成"四级"（入口链式调 5 个 `parseXxx` + `PlanParseVia` 5 成员 + 矩阵 L1–L5 三处互证）；② §二模块树仍描述 `engine/plan-regex.ts` 为"薄封装保留导出名"，而该文件**已删除**（`PlanItemSource` 的 `'plan-regex'` 只剩数据留痕标签）。两处改到与事实一致，§二 留 ⚠️ 说明；新增 **L-39-09**（设计文档提到的文件缺机器校验）。缺陷总数 **D178–D192（15 条）**；用例数与合计**不变**（文档修正，未增删用例） | 项目文档 |
| 2026-09-27 | v0.39.0 打包交付 + 产物扫现场（第五轮） | 产出 macOS x64 `.app`（`release/mac/ArkWork.app`，557 MB，`app.asar` 版本 0.39.0 / Electron 33.4.11，非依赖条目 23 条全在白名单内）并逐项校验；**在 asar 里发现随包出货的历史冒烟残留** `/out/.arkwork/b2-smoke/result.json`（354 B，`ok:false`）→ 登记 **D194**：根因是 `dev/b2-smoke.ts` 早期用 `resolve(__dirname,'..','..','.arkwork',…)`（electron-vite 把主进程打进 `out/main/chunks/` → 落进被收进 asar 的 `out/`），源码早已改 `app.getAppPath()` 但现场没清、`electron-vite build` 也不清 `out/` → 删现场 + 重打包 + **TC-CLEAN-008/009**（含反向核验：注入反模式 `# fail 2`，还原 `# fail 0`）；新增纪律 **㉟**（修根因 ≠ 清现场）；`tar-stream@undefined` 警告归因为上游 dugite 维护者侧脚本依赖 → cosmetic 不修；新增 **L-39-10/11** | 交付物 / 项目文档 |
| 2026-09-27 | v0.39.0 失败诊断复查（第五轮·续） | **D195**：规划通道不可解析时只留分类词、**丢掉模型原文**（既有计划链从 v0.15 起一直记 200 字 `plan LLM raw`）→ 新通道没继承旧通道的诊断纪律；且 `skipped` 借用 `'aborted'` 与"用户中止"混淆。修：`planning/digest.ts` 新增 `clipRawForLog`（200 码点 / 裁首尾空白 / 换行折叠 `⏎` / 不劈代理对 / 标 `…(原文共 N 字符)`）+ `runner.ts` 原文**只进日志不进用户面**（C4）+ `PlannerSkipReason` 增 `'unparsable'`（TC-PLANCH-012/013）。**D196**：穷举 grep 发现 **4 处纯转发壳导出**（`runner.ts` 的 `draftFingerprint`、`project.ts` 的 `assigneeLabel` 连 import、`task-title.ts` 的两个多余导出、`shared/types/graph.ts` 的 `assigneeLabel` 定义）→ 全删 + **TC-CLEAN-010**（判据含"本模块未被别处门面转发"的排除 + 3 条检测器自检；首版缺该排除即误报 `llm-call.ts → isContextOverflowError`；Level 2 模块图因 20 条候选抽查 4 条全有真实消费者而**不入用例**）。缺陷总数 **D178–D196（19 条）**；用例 **+5** → 合计 **2363**；新增 **L-39-12** | 代码 / 项目文档 |
| 2026-09-27 | v0.39.0 空响应「假成功」修复（第六轮） | 用户实机日志暴露 **D197**（`empty-retry 1/2 → 2/2 → 第三次 POST ← 4096+57 tokens（仍空）→ ledger r15 by=seal:completed`）—— 空响应防御**只有入口没有出口**（非 `finish=length` 分支缺 `else`），空回合顺着「未调工具 ✓ + 清单无未完成项 ✓ + 未截断 ✓」被判为**最终答复**，`summary` 取空的 `thought` → 渲染层直接插值出一条**空白「答复」**而任务已 done；且 summary 兜底链 `?? safeSlice(thought,500)` **两级全空**（兜底等于没有兜底）。修：① `reason-phase.ts` 补缺失的第三级处置（补试用尽 → `emptyExhausted` + 诊断 warn 记 `finish`/`content`/`reasoning`/`actions`/`malformedToolCalls`/`outTokens`；常量 `EMPTY_RETRY_LIMIT` / `EMPTY_RESPONSE_ATTEMPTS` 为**单一事实源**）；② `loop.ts` 在 `runReasonPhase` 之后、**完成门禁之前**拦截 → `pauseForEmptyResponses`（paused + ask_user + turn_note 人话，**不封任何终态**，与 D52/D160/D168 同形）；③ `turn-end.ts` 新增纯函数 `resolveCompleteSummary`（三级兜底，**永不输出空串**，loop 与 turn-end 两处收尾共用）；④ 用例 **TC-EMPTYG-005**（终局类：拦截位置早于门禁 + 暂停不得封终态 + 诊断口径）+ **TC-EMPTYG-006**（抽纯函数区 `new Function` **真执行**真值表，含两级全空与代理对边界），并改写 TC-EMPTYG-001/003（上限引常量、修标题笔误 `031`→`003`）；⑤ **反向核验 4 注入全红**（删拦截 / summary 退回两级全空 / 暂停偷偷 `sealLedger` / 拦截挪到门禁之后），还原后复绿。缺陷总数 **D178–D197（20 条）**；用例 **+2** → 合计 **2365**；新增纪律 **㊲**（补上「入口」≠ 补上「出口」：带重试的容错机制必须显式写出重试用尽后的出路） | 代码 / 项目文档 / 测试 |
| 2026-09-27 | v0.39.0 实机 UI 验收（第八轮） | 用户在打包后的 ArkWork 里跑 `@@default` + `qwen3.5:9b` 遇到「空响应被当成功」（**D197**），要求「修复 + 用打包后的 agent 实测」。**① 复现**：局域网 9b 宿主离线（路由器 `192.168.31.1` 返 200 而 `192.168.31.57:11434` `curl exit=7` / ping 全丢）→ 改用**确定性空响应端点**（`/tmp/d197-stub-v2.py`，按 system prompt 分流：规划类回显式空计划 `[]` → `chatMode`；ReAct 推理类回流式空回合 `content="" / finish=stop / outTokens=57`）。**旧包**（含修复前代码）在**同一条判定路径**上：`empty-retry 1/2 → 2/2 →` **无出路** → `task_complete summary:""` + `status=done`，界面呈「已完成」而对话只有用户气泡、**无任何助手回复** = 用户报的空白答复。**② 修复验证**：新包同场景 → `empty LLM response exhausted after 3 attempts (finish=stop, content=0ch, reasoning=0ch, actions=0, malformedToolCalls=0, outTokens=57) — 交回 loop 优雅暂停` → `status=paused` + `ask_user` + `turn_note` + `broadcastTaskStatus`，**无 `task_complete`**、账本未封口（`revision=1` 且无 `sealed`），界面徽标 **⏸ 已暂停** + 底部「已暂停，等待你的指令…」「继续」「停止」。**③ 顺带抓到 D198**（见上）：DOM 直查证明暂停理由**没渲染**，且 D168 那条暂停同样如此 → 根因是渲染层**零处读 `pendingAskUser`**，与 D197 新增路径无关（是**既有**缺口，被本次实机验收照出来）→ 修复 + 新套件 5 条 + **反向核验 5/5 报红**。**工程发现**：从沙箱 shell 启动打包后的 Electron 必须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` + `--no-sandbox --disable-gpu --disable-dev-shm-usage`（否则以纯 Node 启动 → `bad option:`；或 Chromium 自沙箱初始化失败 → GPU/网络服务反复崩）；长驻辅助进程（桩 / 应用）必须走**后台任务**，`nohup … &` 会被 tool 调用结束时的进程组回收（曾导致「桩已死」被误读成「应用连不上」）。**新增用例 +5**（TC-ASKP-001..005）→ 新套件 68 → **73**、合计 **2365 → 2370**（闭合：2357 + 2 回填 + 5 + 2 + 5 − 1 EXCLUSIONS = 2370）。缺陷总数 **D178–D198（21 条）**；新增纪律 **㊳**。收尾：双 tsc `exit 0`（node/web 均零输出）；`ask-user-persisted-question` / `empty-response-guard` `fail=0`；门禁全绿。 | 代码 / 测试 / 项目文档 |
