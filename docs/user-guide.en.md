# ArkWork User Guide (English)

[简体中文](./user-guide.zh-CN.md) | [日本語](./user-guide.ja.md) | [한국어](./user-guide.ko.md)

ArkWork is a local-first AI Agent desktop workbench. It exposes the full ReAct reasoning loop (Reason → Act → Observation): every step is visible in real time, can be paused and inspected at any moment, and every task remains traceable and reusable.

---

## Contents

1. [Installation](#1-installation)
2. [First Launch: Configure a Model](#2-first-launch-configure-a-model)
3. [Interface & Core Concepts](#3-interface--core-concepts)
4. [Daily Usage](#4-daily-usage)
5. [Agents & Skills](#5-agents--skills)
6. [Knowledge Base](#6-knowledge-base)
7. [MCP & Skill Marketplace](#7-mcp--skill-marketplace)
8. [Automations](#8-automations)
9. [Changing the UI Language](#9-changing-the-ui-language)
10. [Keyboard Shortcuts](#10-keyboard-shortcuts)
11. [Data Storage & Privacy](#11-data-storage--privacy)
12. [FAQ](#12-faq)

---

## 1. Installation

### Option A: Download an Installer (Recommended)

Go to the [Releases](../../releases) page of this repository and download the package for your platform:

| Platform | File |
|----------|------|
| macOS | `ArkWork-x.x.x-x64.dmg` |
| Windows | `ArkWork-Setup-x.x.x-x64.exe` |

**macOS**: open the dmg and drag ArkWork into *Applications*.
**Windows**: run the installer and follow the prompts.

### Option B: Run from Source

Requirements: Node.js ≥ 18, npm.

```bash
git clone https://github.com/<your-account>/ArkWork.git
cd ArkWork/app
npm install
npm run dev          # start in dev mode
npm run build:mac    # package for macOS
npm run build:win    # package for Windows
```

---

## 2. First Launch: Configure a Model

ArkWork ships without a bundled LLM — connect at least one provider:

1. Open Settings with `⌘,`
2. Go to the **Models** tab → click **Add Model**
3. Fill in:
   - **id / name**: custom identifier and display name
   - **kind**: provider type — `openai` / `anthropic` / `ollama` / `vllm`
   - **baseURL**: API endpoint (any OpenAI-compatible endpoint works)
   - **apiKey**: your key (leave empty for local models such as Ollama)
4. Click **Test** to verify connectivity, then save
5. Switch models any time via the model chip at the bottom of the composer

> Tip: any OpenAI-compatible endpoint (DeepSeek, MiniMax, vLLM, LM Studio, …) can be added with the `openai` kind.

---

## 3. Interface & Core Concepts

```
┌──────┬──────────────────────────┬───────────┐
│ Left │      Center Stage        │ Right Dock│
│ Nav  │      (conversation)      │(task ctx) │
└──────┴──────────────────────────┴───────────┘
```

| Concept | Description |
|---------|-------------|
| **Workspace** | One folder = one isolated workspace. Tasks, memories and knowledge bases live on disk inside it |
| **Task** | A full Agent session. Saves input, memory, step stream and artifact files; supports continuation and export |
| **Agent** | An executor with a persona. Create different agents for different jobs and bind skills to them |
| **Skill** | An atomic capability an agent can call (shell, file I/O, web fetch, …); more can be installed from the marketplace |
| **ThoughtStream** | Narrative view merging thoughts and tool calls into readable units — expanded live while running, collapsed when done |
| **Checkpoint** | Auto-saved every turn; roll back to any iteration with one click |
| **Preview Window** | Floating preview for Markdown / web pages / code / images / data tables |

### The Four-Layer Memory System

| Layer | Content |
|-------|---------|
| L1 Working memory | Bullet points of the current task — **tick/untick each item** to decide whether it enters the next turn's context |
| L2 File memory | Artifact files produced during the task |
| L3 Curated / Archive | Long-term knowledge distilled automatically, plus historical archives |
| L4 User profile | Cross-task preferences and habits |

---

## 4. Daily Usage

### Create and Run a Task

1. Type your request in the composer and press Enter
2. The Agent starts its Reason → Act loop; ThoughtStream shows every inference step and tool call live
3. Pause / Resume / Cancel whenever you want to intervene
4. When finished, inspect L1 memory, artifact files and logs in the right dock

### Control the Context

In the L1 memory panel, each item's checkbox decides whether it is injected into the next turn's context — unticking irrelevant items saves tokens and keeps the agent focused.

### Roll Back to Any Iteration

Every iteration has a checkpoint. Pick a checkpoint in the task detail view to roll back; everything after it starts anew.

### Preview Artifacts

Click an artifact card in the conversation to open it in a floating preview (Markdown / browser / code highlighting / image / table). Drag it out to keep it as a standalone window.

---

## 5. Agents & Skills

- **Create an agent**: open the agents page in the left nav → new, fill in name and persona, tick the skills to bind
- **Quick switch**: `⌘1~9` cycles through your agents
- **Built-in skills**: shell terminal, file read/write/edit, glob/grep search, fetch-url, web-search, session-search, kb-search, and 10+ more
- **Permission modes**: every tool call passes a permission gate; tune allow policies in settings (e.g. auto-approve read-only commands)

---

## 6. Knowledge Base

Turn local documents into searchable private knowledge:

1. Open the **Knowledge Base** panel in the left nav
2. Import local files (PDF / Word / Markdown / plain text and other common formats)
3. Files are chunked and indexed automatically
4. Enable the KB for a task and the agent can retrieve from it via the kb-search skill

---

## 7. MCP & Skill Marketplace

- **MCP**: add stdio MCP servers in settings; their tools are injected into the agent's toolkit
- **Marketplace**: browse and install community skills from the built-in market panel; installed skills appear in each agent's selectable list

---

## 8. Automations

Open the **Automations** panel in the left nav:

1. Create an automation and define its schedule with a cron expression (e.g. `0 9 * * 1-5` = weekdays at 09:00)
2. Fill in the task content and target workspace
3. It runs automatically on schedule; execution history stays in the panel

---

## 9. Changing the UI Language

Go to **Settings → Language** and choose:

- 简体中文 (Chinese, default)
- English
- 日本語 (Japanese)
- 한국어 (Korean)

The system language is detected on first install; switching applies immediately, no restart needed.

---

## 10. Keyboard Shortcuts

| Keys | Action |
|------|--------|
| `⌘K` | Command palette |
| `⌘P` | Quick file open |
| `⌘B` | Toggle sidebar |
| `⌘,` | Settings |
| `⌘1~9` | Switch agent |
| `Esc` | Close overlay / sidebar / interrupt run |
| `Enter` / `Shift+Enter` | Send / newline |
| `↑` (empty input) | Recall previous message |

> On Windows / Linux, replace `⌘` with `Ctrl`.

---

## 11. Data Storage & Privacy

ArkWork is **local-first**:

- All data (tasks, memories, checkpoints, KB indexes, model config) lives in the per-user data directory:
  - macOS: `~/Library/Application Support/ArkWork/`
  - Windows: `%APPDATA%\ArkWork\`
  - Linux: `~/.config/ArkWork/`
- No telemetry is collected; network traffic goes only to the API endpoints you configure
- API keys are stored only in local configuration files

---

## 12. FAQ

**Q: The model "Test" fails.**
Check the baseURL (watch for a required `/v1` suffix), the apiKey, and whether your network needs a proxy. For local models, confirm the server is running (Ollama defaults to `http://127.0.0.1:11434`).

**Q: macOS denies access to some folders?**
That's macOS privacy protection (TCC). Grant access under *System Settings → Privacy & Security → Files and Folders*, or place your workspace in an already-authorized folder like Documents or Downloads.

**Q: Where is my task data? Will it be lost?**
Everything is persisted locally (see above). Uninstalling the app does not delete that directory; back it up regularly.

**Q: How do I fully reset?**
Quit the app and delete the `arkwork-data` folder inside the data directory (this wipes all tasks and configuration — back up first).

**Q: Which providers are supported?**
OpenAI, Anthropic, Ollama, vLLM, and any OpenAI-compatible endpoint (DeepSeek, MiniMax, SiliconFlow, …).
