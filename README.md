# ArkWork

> Local-first AI Agent workbench — ReAct loop **visible, controllable, reusable**.
>
> 本地优先的 AI Agent 工作台桌面应用：让 ReAct 推理循环对用户而言"可见、可控、可复用"。

## 它解决什么问题

主流 AI 产品的 Agent 推理是黑盒，用户无法调试、无法在中间状态介入、上下文不可控。ArkWork 把 ReAct 循环变成可观察、可干预、可追溯的一等对象：

- **可见** — 每一步 Reason / Act / Observation 实时推送、持久化、可展开查看。
- **可控** — 任意时刻可 Pause / Resume / Cancel；L1 记忆每条可勾选决定是否进入下一轮上下文。
- **可复用** — Task 是头等公民，完整保存输入 + L1 记忆 + 步骤流 + L2 产物文件，支持续聊与导出。

## 核心特性

- LeftNav 全局导航 + CenterStage 对话主角 + RightDock 任务上下文（WorkBuddy 式左右分工），PreviewWindow 浮窗预览（Markdown/浏览器/代码/图片/数据表）
- L1-L4 四层记忆体系：工作记忆 / 文件记忆 / 策展+档案记忆 / 用户画像，含蒸馏管线与 L1 自动压缩
- ThoughtStream 叙事流步骤展示（思考-工具融合单元，运行实时状态 + 完成折叠）
- 上下文 token 计量：Composer CtxRing 用量圆环 + ContextPanel 注入预算环 + StatusBar 占比
- Agent 体系：智能体 CRUD + 人格字段，内置 Skill 10 个（含 shell / fetch-url / session-search / kb-search）
- 知识库：本地文件切块索引 + MiniSearch 全文检索 + 任务级启用
- MCP 支持（stdio）+ 腾讯 SkillHub 技能市场
- Checkpoint 检查点：每轮自动存档，可回滚到任意迭代
- 多 LLM Provider 支持（OpenAI / Anthropic / Ollama / vLLM / 自定义 OpenAI 兼容端点）
- 工作区隔离（每个文件夹一个独立工作区，任务与记忆本地落盘）
- 暗色 / 浅色双主题，跨平台桌面应用（macOS / Windows / Linux）

## 技术栈

| 层面 | 选型 |
|------|------|
| 运行时 | Electron 33 + Node.js（ESM） |
| 构建 | electron-vite 2.3 + Vite 5 + electron-builder 26 |
| 前端 | React 18.3 + TypeScript 5.6 + Tailwind CSS 3.4 + Zustand 5 |
| LLM SDK | `@anthropic-ai/sdk` + `openai` |
| 持久化 | 文件系统（JSON / JSONL），无数据库 |

## 快速开始

### 前置要求

- Node.js ≥ 18
- npm（或兼容包管理器）

### 安装与运行

```bash
cd app
npm install
npm run dev
```

开发模式下：
- 主进程通过 `.dev-data/` 目录作 userData（绕开 macOS TCC 限制）
- Vite dev server 监听 `http://localhost:5174/`
- Electron 窗口自动打开

### 打包

```bash
cd app
npm run build:mac    # macOS dmg + zip (x64)
```

产物位于 `app/release/`。

## 目录结构

```
ArkWork/
├── app/                    # Electron 应用
│   ├── src/
│   │   ├── main/           # 主进程（agent / memory / kb / automation / mcp / checkpoint / ipc / llm / store / fs）
│   │   ├── preload/        # Preload 桥（contextBridge）
│   │   ├── renderer/       # 渲染进程（React UI：LeftNav / CenterStage / RightDock / PreviewWindow / ...）
│   │   └── shared/         # 共享类型与工具
│   ├── package.json
│   ├── electron.vite.config.ts
│   └── tailwind.config.js
└── docs/                   # 项目文档
    ├── 00-opensource-research.md  # 开源调研（v0.3.0 基线）
    ├── 01-prd.md           # 产品文档（v0.3.0 基线）
    ├── 02-interaction.md   # 交互文档（v0.3.0 基线）
    ├── 03-system-design.md # 系统设计文档（对齐当前实现）
    ├── 04~06-*.md          # 测试与 UX 校验报告（v0.3.0）
    ├── CURRENT.md          # 当前进度
    ├── CHANGELOG.md        # 变更记录（v0.1.0–v0.10.0）
    ├── ux-redesign/        # UX 重设计提案 + tokens + mockup
    ├── versions/           # 各版本增量设计文档（v0.1.0–v0.9.0）
    └── archive/            # 旧文档归档
```

详细架构与模块职责见 [docs/03-system-design.md](./docs/03-system-design.md)。

## 配置模型

首次启动需在 **设置 → 模型** 中配置至少一个 LLM Provider：

1. ⌘, 打开设置
2. 模型 Tab → 添加模型
3. 填写 id / name / kind（openai/anthropic/ollama/vllm）/ baseURL / apiKey
4. 点击「测试」确认连通
5. 保存后即可在 Composer 底部 Model chip 切换

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `⌘K` | 命令面板 |
| `⌘P` | 文件快速切换（QuickOpen） |
| `⌘B` | 切换侧栏 |
| `⌘E` / `⌘J` | 切换侧栏（兼容别名） |
| `⌘,` | 设置 |
| `⌘1~9` | 切换 Agent |
| `Esc` | 关闭浮层 / 侧栏 / 中断 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |
| `↑`（空输入时） | 召回上一条 |

## 文档

- [当前进度 CURRENT](./docs/CURRENT.md)
- [变更记录 CHANGELOG](./docs/CHANGELOG.md)
- [系统设计文档（当前实现基线）](./docs/03-system-design.md)
- [产品文档 PRD（v0.3.0 基线）](./docs/01-prd.md)
- [交互文档（v0.3.0 基线）](./docs/02-interaction.md)
- [各版本增量设计](./docs/versions/)

### 用户产物（按版本归档）

面向最终用户的 README 与使用手册，按版本归档在 `products/` 下，不混入 `.arkwork/` 目录：

- [products/react-core-skills-integration/](./products/react-core-skills-integration/) — v0.15.0 react-core-skills 集成与 Agent+技能+侧边栏可组合架构
  - [产品 README](./products/react-core-skills-integration/README.md)
  - [用户使用手册](./products/react-core-skills-integration/USER_MANUAL.md)

## License

MIT
