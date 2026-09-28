# ArkWork User Guide (English)

[简体中文](./user-guide.zh-CN.md) | [日本語](./user-guide.ja.md) | [한국어](./user-guide.ko.md)

ArkWork is a local-first AI Agent desktop workbench. It exposes the full ReAct reasoning loop (Reason → Act → Observation): every step is visible in real time, can be paused and inspected at any moment, and every task remains traceable and reusable.

---

## Contents

1. [Installation](#1-installation)
2. [First Launch: Configure a Model](#2-first-launch-configure-a-model)
3. [Interface & Core Concepts](#3-interface--core-concepts)
4. [Daily Usage](#4-daily-usage)
5. [File workbench](#5-file-workbench)
6. [Agents & Skills](#6-agents--skills)
7. [Plugins](#7-plugins)
8. [Workbench](#8-workbench)
9. [Knowledge Base](#9-knowledge-base)
10. [MCP & Skill Marketplace](#10-mcp--skill-marketplace)
11. [Automations](#11-automations)
12. [Changing the UI Language](#12-changing-the-ui-language)
13. [Keyboard Shortcuts](#13-keyboard-shortcuts)
14. [Settings and permissions](#14-settings-and-permissions)
15. [Performance and local storage](#15-performance-and-local-storage)
16. [FAQ](#16-faq)

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
| **Plugin** | Extends ArkWork itself: plugins can contribute commands, right-dock panels and code views |
| **Conversation flow** | Three-layer information architecture: body (your messages and replies), process (thoughts / tool calls / observations) and collapsible process groups |
| **Right Dock** | The on-demand inspection area: todos / context / files / logs / browser / terminal |
| **Checkpoint** | Auto-saved every turn; roll back to any iteration with one click |
| **Preview Window** | Floating preview for Markdown / web pages / code / images / data tables |

### Memory L1 – L4

Memory settles layer by layer — from inside a task, to the workspace, to across workspaces. First-hand evidence stays in the lower layers; long-term content is only derived and written to the curated layer by end-of-task consolidation.

| Layer | Content |
|-------|---------|
| **L1 Working memory** | Per-turn entries of the current task (messages / thoughts / tool observations). It is the only first-hand evidence — distillation never deletes it |
| **L2 File memory** | Overflowing large results and step artifacts are written to files and read back on demand; they never sit in context |
| **L3a Curated memory** | Project memory lives in the workspace (travels with the project); user preferences stay in the global Agent space (shared across workspaces) |
| **L3b Archive** | At task wrap-up, L1 is archived into searchable historical entries while the originals are kept — re-viewable and searchable |
| **L4 User profile** | Cross-workspace long-term preferences, synthesized in batches on a cadence (first run / 24 hours / 5 tasks) rather than rewritten every time |

> End-of-task consolidation: when a task finishes, the model distills long-term content from L1 / L2 into a pending area that only takes effect on the next run; on failure it writes nothing at all.

---

## 4. Daily Usage

### Create and Run a Task

1. Type your request in the composer and press Enter
2. The Agent starts its Reason → Act loop; the conversation shows every inference step and tool call live
3. Pause / Resume / Cancel whenever you want to intervene
4. When finished, inspect todos, artifact files, context and logs in the right dock

### Parallel Execution

Independent work in the same turn is started concurrently: a single inference can trigger several tool calls that run in parallel with progress shown per dimension and never overwriting each other. Splittable sub-tasks are delegated to sub-agents that run in parallel, each with its own step stream and output. Work with ordering dependencies (write then read) still runs serially to avoid races.

### Control the Context

The right dock's **Context** panel is read-only and shows the knowledge-base / memory snippets injected into this task plus context usage; memory entries can be edited in the Memory Center.

### Roll Back to Any Iteration

Every iteration has a checkpoint. Pick a checkpoint in the task detail view to roll back; everything after it starts anew.

### Preview Artifacts

Click an artifact card in the conversation to open it in a floating preview (Markdown / browser / code highlighting / image / table). Drag it out to keep it as a standalone window.

---

## 5. File workbench

Open, edit and save workspace files right inside the app:

- **Jump by name**: use QuickOpen (`⌘P`); the right dock's **Files** tab shows the whole workspace tree — click a file to open it in the editor
- **Editor**: syntax highlighting, multiple cursors, find & replace and line operations. Saving is atomic (write a temp file, then swap), so you never end up with a half-written file
- **Conflict banner**: if a file changes on disk outside the app, a conflict banner appears — compare the diff and keep your change or take the disk version; nothing is overwritten silently
- **Boundary**: files inside the workspace are readable and writable; files outside it (for example referenced by an absolute path) open read-only with the reason shown, and writes are rejected

---

## 6. Agents & Skills

- **Create an agent**: open the agents page in the left nav → new, fill in name and persona, tick the skills to bind
- **Switch agents**: switch from the agents page or the task header; the agent's right-dock preferences are applied automatically
- **Built-in skills**: shell terminal, file read/write/edit, glob/grep search, fetch-url, web-search, session-search, kb-search, and 10+ more
- **Skill sources**: grouped as built-in / marketplace / imported; importing a zip unpacks the whole archive (all `.md` files and subdirectories) into the skill folder
- **Permission modes**: every tool call passes a permission gate; cycle modes with `Shift+Tab`, and tune allow policies in "Settings and permissions"

---

## 7. Plugins

Plugins extend what ArkWork itself can do: they can contribute commands, panels and code views.

1. In the abilities page's **Plugins** tab, create, install (pick a zip) and uninstall plugins
2. Before installing, ArkWork lists the permissions and capabilities a plugin requests — nothing is written to disk until you confirm
3. Contributed commands show up in QuickAction (`⌘K`); contributed panels and views appear as tabs in the right dock
4. Code plugins run in a separate host process and are constrained by a capability allow-list: a validation failure or crash affects only that plugin
5. On uninstall you can choose **Delete plugin data** to clean up the plugin's private key-value store as well

---

## 8. Workbench

The workbench hosts configuration capabilities: declare a way of working as a workbench Profile, and switching it changes the interface layout and the enabled capabilities.

1. Each Profile declares the layout, the plugins and skills to enable, right-dock tabs, the theme, and more; copy a built-in preset and adapt it
2. Creating and editing is wizard-driven — pick layout and capabilities step by step, no hand-written JSON
3. Activating a Profile applies what it declares; "what was declared" and "what actually took effect" are shown side by side on the same page, with degradations and validation problems explained in place as banners
4. Both profiles and activation reports can be exported and imported, so the same way of working can be synced across machines

---

## 9. Knowledge Base

Turn local documents into searchable private knowledge:

1. Open the **Knowledge Base** panel in the left nav
2. Import local files (PDF / Word / Markdown / plain text and other common formats)
3. Files are chunked and indexed automatically; documents move through parsing / indexed / failed states, and failures can be retried with one click
4. A two-level switch (session-level + global) is available; once enabled for a task, the agent can retrieve via the kb-search skill

---

## 10. MCP & Skill Marketplace

- **MCP**: add stdio MCP servers in settings; their tools are injected into the agent's toolkit
- **Marketplace**: browse and install community skills from the built-in market panel; installed skills appear in each agent's selectable list

---

## 11. Automations

Open the **Automations** panel in the left nav:

1. Create an automation and define its schedule with an alarm-style frequency or a custom cron expression (e.g. `0 9 * * 1-5` = weekdays at 09:00)
2. Fill in the task content and target workspace
3. It runs automatically on schedule; results are written back into the corresponding task's conversation and stay visible in the panel

---

## 12. Changing the UI Language

Go to **Settings → Appearance** and choose:

- 简体中文 (Chinese, default)
- English
- 日本語 (Japanese)
- 한국어 (Korean)

The system language is detected on first install; switching applies immediately, no restart needed.

---

## 13. Keyboard Shortcuts

| Keys | Action |
|------|--------|
| `⌘K` | Command palette (QuickAction) |
| `⌘P` | Quick file open |
| `⌘N` | New task |
| `⌘B` | Collapse / expand left sidebar |
| `⌘J` | Collapse / expand right dock |
| `⌘E` | Toggle floating preview window |
| `⌘,` | Settings |
| `⌘⇧W` | Workspace switcher |
| `⌘1` – `⌘7` | Jump to abilities: agents / skills / KB / memory / automations / settings / workbench |
| `⌥1` – `⌥6` | Jump to right-dock tabs: todos / context / files / logs / browser / terminal |
| `⇧Tab` | Cycle permission mode |
| `⌘/` or `⌘?` | Open / close the help center |
| `Esc` | Close overlay / panel by priority, or interrupt a run |

> On Windows / Linux, replace `⌘` with `Ctrl`, `⌥` with `Alt` and `⇧` with `Shift`.
> The in-app help center's shortcut table is authoritative — it is generated from the keybinding registry.

---

## 14. Settings and permissions

Settings is organized into tabs: **Models / Workspace / Knowledge / Appearance / Advanced**.

- **Models**: pick default and fallback models and configure API keys; supports OpenAI, Anthropic and compatible endpoints such as local Ollama / vLLM
- **Workspace**: switch the current workspace (one folder = one workspace), default knowledge base and file ignore rules
- **Appearance**: light / dark / follow system, plus font density — applies immediately, no restart
- **Permission rules**: shown by four levels of origin (managed / this workspace / project config / user config), each rule can be enabled or disabled, and hits are traceable in the logs
- **Remember this choice**: the checkbox on the interception overlay writes that decision as a rule (recorded to this workspace by default), so the same call won't interrupt you again
- **Advanced**: logs / graph diagnostics, read-only compression strategy and experimental switches

---

## 15. Performance and local storage

ArkWork makes performance trade-offs for machines without a dedicated GPU while staying local-first:

- **Motion discipline**: only cheap effects such as opacity changes and solid-colour breathing are kept — no blur, translate or continuously repainting animations
- **No frosted glass**: background blur has been removed entirely and overlays use solid-colour layering, avoiding per-frame compositing cost on GPU-less machines
- **Automatic degradation**: the UI degrades when the system enables "Reduce motion", and drops into a performance-lite mode when software rendering is detected — the interface becomes still immediately
- **Data directory**: redirected to `app/.dev-data` in development; in packaged builds it lives in the per-user data directory, with `arkwork-data` as the app data root
  - macOS: `~/Library/Application Support/ArkWork/`
  - Windows: `%APPDATA%\ArkWork\`
  - Linux: `~/.config/ArkWork/`
- **Privacy**: no telemetry is collected; conversations, memories and KB indexes stay local; network traffic goes only to the API endpoints you configure, and API keys are stored only in local configuration files

---

## 16. FAQ

**Q: The model "Test" fails.**
Check the baseURL (watch for a required `/v1` suffix), the apiKey, and whether your network needs a proxy. For local models, confirm the server is running (Ollama defaults to `http://127.0.0.1:11434`).

**Q: macOS denies access to some folders?**
That's macOS privacy protection (TCC). Grant access under *System Settings → Privacy & Security → Files and Folders*, or place your workspace in an already-authorized folder like Documents or Downloads.

**Q: A file link in the conversation won't open.**
Files outside the workspace open read-only with the reason shown. If a file inside the workspace still won't open, check whether it has been moved or deleted.

**Q: Where is my task data? Will it be lost?**
Everything is persisted locally (see above). Uninstalling the app does not delete that directory; back it up regularly.

**Q: How do I fully reset?**
Quit the app and delete the `arkwork-data` folder inside the data directory (this wipes all tasks and configuration — back up first).

**Q: Which providers are supported?**
OpenAI, Anthropic, Ollama, vLLM, and any OpenAI-compatible endpoint (DeepSeek, MiniMax, SiliconFlow, …).