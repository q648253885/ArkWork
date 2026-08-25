# ArkWork

**English** | [简体中文](./README.zh-CN.md) | [日本語](./docs/user-guide.ja.md) | [한국어](./docs/user-guide.ko.md)

> A local-first AI Agent workbench — making the ReAct reasoning loop **visible, controllable, and reusable**.

![License](https://img.shields.io/badge/license-MIT-green) ![Electron](https://img.shields.io/badge/Electron-33-47848F) ![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

## Why ArkWork

In most AI products, the Agent's reasoning is a black box: you can't debug it, can't intervene mid-run, and can't control what goes into context. ArkWork turns the ReAct loop into a first-class object that is:

- **Visible** — every Reason / Act / Observation step streams in real time, is persisted, and can be expanded and inspected.
- **Controllable** — Pause / Resume / Cancel at any moment; tick or untick each L1 working-memory item to decide whether it enters the next turn's context.
- **Reusable** — Tasks are first-class citizens: input + L1 memory + step stream + L2 artifact files are fully saved, with chat continuation and export.

## Features

- Three-pane workspace (global nav / conversation stage / task dock) plus a floating Preview Window (Markdown, browser, code, image, data table)
- Four-layer memory system (working / file / curated + archive / user profile) with distillation pipeline and automatic L1 compaction
- ThoughtStream narrative step view — merged thought-and-tool units with live status and collapse-on-done
- Context token metering: usage ring on the composer, injection budget ring in the context panel, share in the status bar
- Agents with personas; 10+ built-in skills (shell, fetch-url, web-search, session-search, kb-search, …)
- Knowledge base: local file chunking & indexing with MiniSearch full-text search, enable per task
- MCP support (stdio) + skill marketplace
- Checkpoints: auto-saved every turn, roll back to any iteration
- Multi-provider LLM support (OpenAI / Anthropic / Ollama / vLLM / any OpenAI-compatible endpoint)
- Workspace isolation — one folder, one isolated workspace; tasks and memories stored locally
- Dark / light themes, UI in 简体中文 · English · 日本語 · 한국어
- Cross-platform desktop app (macOS / Windows / Linux)

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Electron 33 + Node.js (ESM) |
| Build | electron-vite 2.3 + Vite 5 + electron-builder 26 |
| Frontend | React 18.3 + TypeScript 5.6 + Tailwind CSS 3.4 + Zustand 5 |
| LLM SDK | `@anthropic-ai/sdk` + `openai` |
| Persistence | File system (JSON / JSONL), no database |

## Quick Start

Requirements: Node.js ≥ 18, npm.

```bash
git clone https://github.com/<your-account>/ArkWork.git
cd ArkWork/app
npm install
npm run dev
```

In dev mode the main process uses `.dev-data/` as userData, the Vite dev server listens on `http://localhost:5174/`, and the Electron window opens automatically.

Build installers:

```bash
npm run build:mac    # macOS dmg + zip (x64) → app/release/
npm run build:win    # Windows nsis installer (x64)
```

### Configure a Model

On first launch open **Settings → Models** (`⌘,`):

1. Click **Add Model**
2. Fill in id / name / kind (`openai` / `anthropic` / `ollama` / `vllm`) / baseURL / apiKey
3. Click **Test** to verify connectivity
4. Save, then switch models any time via the model chip at the bottom of the composer

## Documentation

| Language | User Guide |
|----------|------------|
| 简体中文 | [docs/user-guide.zh-CN.md](./docs/user-guide.zh-CN.md) |
| English | [docs/user-guide.en.md](./docs/user-guide.en.md) |
| 日本語 | [docs/user-guide.ja.md](./docs/user-guide.ja.md) |
| 한국어 | [docs/user-guide.ko.md](./docs/user-guide.ko.md) |

The guides cover installation, model configuration, core concepts (workspace / task / agent / skill / memory / knowledge base), daily workflows, keyboard shortcuts, FAQ, and troubleshooting.

## Project Structure

```
ArkWork/
├── app/                        # Electron application
│   ├── src/
│   │   ├── main/               # Main process (agent engine / memory / kb /
│   │   │                       #   automation / mcp / checkpoint / ipc / llm /
│   │   │                       #   store / fs / browser …)
│   │   ├── preload/            # Preload bridge (contextBridge)
│   │   ├── renderer/           # Renderer process (React UI, i18n ×4 locales)
│   │   ├── shared/             # Shared types & utilities
│   │   └── test/               # Test infrastructure (electron stub loader)
│   ├── scripts/                # Unified test runner + i18n tooling
│   └── build-resources/        # App icons & packaging resources
├── docs/                       # User documentation (multilingual guides)
└── README.md
```

## Keyboard Shortcuts

| Keys | Action |
|------|--------|
| `⌘K` | Command palette |
| `⌘P` | Quick file open |
| `⌘B` | Toggle sidebar |
| `⌘,` | Settings |
| `⌘1~9` | Switch agent |
| `Esc` | Close overlay / sidebar / interrupt |
| `Enter` / `Shift+Enter` | Send / newline |
| `↑` (empty input) | Recall previous message |

## Testing

```bash
cd app
npm test            # unified runner: auto-discovers src/**/__tests__/*.test.ts(x)
npm run typecheck   # tsc for node & web configs
```

## License

[MIT](./LICENSE)
