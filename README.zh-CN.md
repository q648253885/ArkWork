# ArkWork

[English](./README.md) | **简体中文** | [日本語](./docs/user-guide.ja.md) | [한국어](./docs/user-guide.ko.md)

> 本地优先的 AI Agent 工作台 — 让 ReAct 推理循环**可见、可控、可复用**。

![License](https://img.shields.io/badge/license-MIT-green) ![Electron](https://img.shields.io/badge/Electron-33-47848F) ![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

## 它解决什么问题

主流 AI 产品的 Agent 推理是黑盒：用户无法调试、无法在中间状态介入、上下文不可控。ArkWork 把 ReAct 循环变成一等对象：

- **可见** — 每一步 Reason / Act / Observation 实时推送、持久化、可展开查看。
- **可控** — 任意时刻可 Pause / Resume / Cancel；L1 工作记忆每条可勾选，决定是否进入下一轮上下文。
- **可复用** — Task 是头等公民：完整保存输入 + L1 记忆 + 步骤流 + L2 产物文件，支持续聊与导出。

## 核心特性

- 三栏工作区（全局导航 / 对话主角 / 任务坞）+ 浮窗预览（Markdown / 浏览器 / 代码 / 图片 / 数据表）
- L1–L4 四层记忆体系：工作记忆 / 文件记忆 / 策展+档案记忆 / 用户画像，含蒸馏管线与 L1 自动压缩
- ThoughtStream 叙事流：思考-工具融合单元，运行实时状态、完成后折叠
- 上下文 token 计量：Composer 用量圆环 + ContextPanel 注入预算环 + StatusBar 占比
- Agent 体系：智能体 CRUD + 人格字段；内置 10+ 技能（shell / fetch-url / web-search / session-search / kb-search 等）
- 知识库：本地文件切块索引 + MiniSearch 全文检索，任务级启用
- MCP 支持（stdio）+ 技能市场
- Checkpoint 检查点：每轮自动存档，可回滚到任意迭代
- 多 Provider 支持（OpenAI / Anthropic / Ollama / vLLM / 自定义 OpenAI 兼容端点）
- 工作区隔离：一个文件夹一个独立工作区，任务与记忆本地落盘
- 暗色 / 浅色双主题，界面支持简体中文 · English · 日本語 · 한국어
- 跨平台桌面应用（macOS / Windows / Linux）

## 技术栈

| 层面 | 选型 |
|------|------|
| 运行时 | Electron 33 + Node.js（ESM） |
| 构建 | electron-vite 2.3 + Vite 5 + electron-builder 26 |
| 前端 | React 18.3 + TypeScript 5.6 + Tailwind CSS 3.4 + Zustand 5 |
| LLM SDK | `@anthropic-ai/sdk` + `openai` |
| 持久化 | 文件系统（JSON / JSONL），无数据库 |

## 快速开始

前置要求：Node.js ≥ 18，npm。

```bash
git clone https://github.com/<your-account>/ArkWork.git
cd ArkWork/app
npm install
npm run dev
```

开发模式下：主进程以 `.dev-data/` 作为 userData，Vite dev server 监听 `http://localhost:5174/`，Electron 窗口自动打开。

打包安装包：

```bash
npm run build:mac    # macOS dmg + zip (x64)，产物在 app/release/
npm run build:win    # Windows nsis 安装器 (x64)
```

### 配置模型

首次启动打开 **设置 → 模型**（`⌘,`）：

1. 点击「添加模型」
2. 填写 id / name / kind（`openai` / `anthropic` / `ollama` / `vllm`）/ baseURL / apiKey
3. 点击「测试」确认连通
4. 保存后即可在 Composer 底部模型 chip 随时切换

## 使用文档

| 语言 | 使用指南 |
|------|----------|
| 简体中文 | [docs/user-guide.zh-CN.md](./docs/user-guide.zh-CN.md) |
| English | [docs/user-guide.en.md](./docs/user-guide.en.md) |
| 日本語 | [docs/user-guide.ja.md](./docs/user-guide.ja.md) |
| 한국어 | [docs/user-guide.ko.md](./docs/user-guide.ko.md) |

使用指南覆盖：安装、模型配置、核心概念（工作区 / 任务 / 智能体 / 技能 / 记忆 / 知识库）、日常操作流程、快捷键、常见问题与故障排除。

## 目录结构

```
ArkWork/
├── app/                        # Electron 应用
│   ├── src/
│   │   ├── main/               # 主进程（agent 引擎 / memory / kb / automation /
│   │   │                       #   mcp / checkpoint / ipc / llm / store /
│   │   │                       #   fs / browser …）
│   │   ├── preload/            # Preload 桥（contextBridge）
│   │   ├── renderer/           # 渲染进程（React UI，i18n 四语言）
│   │   ├── shared/             # 共享类型与工具
│   │   └── test/               # 测试基建（electron 桩 loader）
│   ├── scripts/                # 统一测试 runner + i18n 工具
│   └── build-resources/        # 应用图标与打包资源
├── docs/                       # 用户文档（多语言使用指南）
└── README.md
```

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `⌘K` | 命令面板 |
| `⌘P` | 文件快速切换（QuickOpen） |
| `⌘B` | 切换侧栏 |
| `⌘,` | 设置 |
| `⌘1~9` | 切换 Agent |
| `Esc` | 关闭浮层 / 侧栏 / 中断 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |
| `↑`（空输入时） | 召回上一条 |

## 测试

```bash
cd app
npm test            # 统一 runner：自动发现 src/**/__tests__/*.test.ts(x)
npm run typecheck   # tsc 校验 node & web 两套 tsconfig
```

## License

[MIT](./LICENSE)
