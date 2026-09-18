# ArkWork 跨版本欠账总账（BACKLOG）

> 建立：2026-09-18（v0.33.0）｜ 来源要求：`docs/versions/v0.32.2/00-release-goal.md` C-1
> **纪律**：每版发布前必须过一遍本文件。凡新版本承认的遗留项，**必须在此登记**（只写在当版 `03-system-design.md` 的遗留节 = 必然沉没，B4/B5/B6 沉没三版即此因）。
> 状态取值：`open`（未动）/ `doing`（本版在做）/ `done`（已交付）/ `dropped`（明确不做）

---

## 一、版本归属

| 来源版本 | 遗留项数 | 去向版本 | 状态 |
|---|---|---|---|
| v0.31.0 | L1–L16 | 部分并入 v0.33.0，其余 v0.33.1 | 部分 done |
| v0.32.0 | L1–L13 | 大部分并入 v0.33.0 D 线/B 线 | 部分 done |
| v0.32.1 | 2 项（超时常量 / 401 配置） | 政策项，不影响代码 | open |
| v0.32.2 | A/B/C 三线 | A 线并入 v0.33.0；B 线顺延 v0.33.1；C 线由本文件承接 | 部分 done |
| **v0.33.0** | **L-33-01…14** | v0.33.1 / v0.34.0 / 独立版本 | open |

---

## 二、v0.33.0 遗留（L-33-01…14）

| # | 项 | 影响 | 去向 | 状态 |
|---|---|---|---|---|
| L-33-01 | `data.kind === 'mcp'` 真实拉取（需受控数据通道 + 权限确认，不能绕过 `ToolConfirm`） | 面板无法直接消费 MCP 数据 | v0.33.1 | open |
| L-33-02 | `data.kind ∈ {task, kb}` 数据源 | 面板无法直读任务/知识库 | v0.33.1 | open |
| L-33-03 | `ui.action` 消费端迁移（preview 工具栏 + 选中动作注册表） | 插件动作只入槽不可用 | v0.33.1 | open |
| L-33-04 | `agents[].modelPreference` 真生效 | 垂直台无法指定模型偏好 | v0.33.1 | open |
| L-33-05 | `data.kbCollections` 默认视野收敛 | 跨台任务创建界面噪音 | v0.33.1 | open |
| L-33-06 | `data.workspaceTemplate` 模板实例化 + `defaultWorkspaceAssociation` 自动激活 | 新台冷启动无目录结构 | v0.33.1 | open |
| L-33-07 | `automation[]` 真注册（autoSlot → automation 模块） | 垂直台的定时任务只登记 | v0.33.1 | open |
| L-33-08 | profile 目录热重载（chokidar，正本 03 §6 开发体验） | 改 manifest 需手动重新导入 | v0.33.1 | open |
| L-33-09 | `agents[].personaRef` 解析（读包内 persona 文件） | 只能用内联 personaText | v0.33.1 | open |
| L-33-10 | 插件面板 Tab 拖拽重排（需 `Record<profileId, PanelPrefs>`） | 顺序只能改 manifest | v0.33.1 | open |
| L-33-11 | `core/` + `ns/<name>/` 双层画像**破坏性迁移**（L3/L4 落盘路径改写 + 存量搬移 + 回滚） | 域隔离尚未彻底（注入侧已分域） | 独立版本 | open |
| L-33-12 | 插件市场 / 签名 / 信任分级 T0–T3（正本 07） | 无第三方分发通道 | v0.34.0 | open |
| L-33-13 | 沙箱 iframe 面板逃生舱（正本 04 §4） | 宿主组件库覆盖不了的面板无法实现 | 触发式立项 | open |
| L-33-14 | B5 renderer 侧文件工作台（v0.31.0 欠账：chokidar 接线 / 活文件树 / Goto Anything / 选中动作 / 另存恢复 / 产物卡片） | 文件工作台 renderer 侧仍缺 | v0.33.1 | open |

## 三、v0.31.0 / v0.32.0 遗留（节选）

| # | 项 | 去向 | 状态 |
|---|---|---|---|
| L4（v0.32.0） | 存量注册表全部迁槽（`sidebarRegistry` / keymap / 动作注册表） | v0.33.0 做 `ui.renderer` / `ui.theme` / `ui.panel`；其余 v0.33.1 | 部分 done |
| L6（v0.32.0） | `personaRef` 解析 | 见 L-33-09 | open |
| L7（v0.32.0） | 记忆命名空间落盘路径改写 | 见 L-33-11 | open |
| L8（v0.32.0） | `defaultWorkspaceAssociation` 自动激活 | 见 L-33-06 | open |
| L10（v0.32.0） | profile Dock 顺序与用户偏好双源 | v0.33.0 以「顺序真源唯一 = manifest」消解（内置六 Tab 仍归用户偏好） | done |
| L11（v0.32.0） | `profile:import` 无 UI 入口 | v0.33.0 D 线接上 | done |
| L13（v0.31.0） | 零裸符号门禁 | 保持 | done |
| L16（v0.31.0） | `tool_call` 流式前移剥离未做 | v0.33.1 | open |

## 四、政策项（不影响代码，长期 open）

| # | 项 | 说明 |
|---|---|---|
| P-01 | 120s LLM 超时常量是否放宽 | 策略议题，v0.32.1 已明确未动 |
| P-02 | 401 `Please bind your Alibaba Cloud account` | ModelScope 端点需账号绑定，属配置问题非代码 |

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-09-18 | 建立（v0.33.0 E-1）；登记 v0.31.0/v0.32.0/v0.32.1/v0.32.2/v0.33.0 遗留 |
