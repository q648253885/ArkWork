# v0.24.3 — 能力中心容器化（插件 Tab 补 Agent→MCP 链路）

> 「文档驱动开发 · 模式 B 快速通道」下的 bug 修复：v0.24.2 上线后用户反馈
> 「Agent 只能感知技能、感知不到插件」。本文档追溯修复与回归。

## 修改说明（铁律①最小化落地）

**改什么**：把已 connected MCP server 的 tools 注入 `listSkills()`，
`engine.assembleTools` 在白名单中合并 `agent.defaultMcpIds` / `task.mcpIds`
（之前只看 `defaultSkillIds` / `skillIds`），前端 `createTask` 与续聊路径
同步透传 `mcpIds`。

**为什么**：v0.24.2 引入了 PluginsPanel 管理 UI，但 Agent 与 MCP tools
之间缺桥接层：MCP server 即使已 connected + 发现了 N 个工具，LLM
工具集永远是空（listSkills 仅扫 `{arkworkDir}/skills/` 文件夹）。
类型层 `mcpRef?: { serverId, toolName }` 与运行时 `callMcpTool` 路由就绪，
唯独缺「谁负责把 MCP tool 转成 Skill 并纳入工具集」——这是设计遗漏，
不是代码逻辑 bug。

**影响模块**：`agent/registry.ts`（listSkills 注入 + 抽出纯函数 `mcpServersToSkills`）、
`agent/engine.ts`（assembleTools 合并 MCP 白名单）、`mcp/client.ts`（connect/disconnect
触发 skill 缓存失效）、`renderer/store.ts`（createTask 透传 + 续聊合并）、
新增测试 `agent/__tests__/mcp-injection.test.ts`。

**未改动**：`McpServer` / `Skill` 类型不变；`mcp/client.ts` 既有协议
不变；`PluginsPanel.tsx` UI 零变更；设计 token 不动。

## 涉及文件

| 模块 | 路径 | 变更 |
| --- | --- | --- |
| 技能注册表 | `app/src/main/agent/registry.ts` | `listSkills` 注入 MCP；新增导出 `mcpServersToSkills` 纯函数 |
| 引擎 | `app/src/main/agent/engine.ts` | `assembleTools` 合并 `defaultMcpIds` / `task.mcpIds` |
| MCP 客户端 | `app/src/main/mcp/client.ts` | connect/disconnect 成功路径触发 `invalidateSkillCache` |
| 渲染端 store | `app/src/renderer/store.ts` | `createTask` 透传 `mcpIds`；续聊路径合并 `mcpIds` |
| 回归测试 | `app/src/main/agent/__tests__/mcp-injection.test.ts` | 新建（5 个纯函数用例） |
| 端到端冒烟 | `app/scripts/verify-mcp-injection.ts` + `app/scripts/_echo-mcp-server.py` | 新建（真实起 python MCP server + 6 步链路断言） |

## 验证

| 项 | 工具 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc --noEmit -p tsconfig.node.json` + `tsconfig.web.json` | ✅ 零错误 |
| 构建 | `electron-vite build`（main + preload + renderer 三 bundle） | ✅ 1.94s + 48ms + 8.10s |
| 新增单测 | `tsx --test src/main/agent/__tests__/mcp-injection.test.ts` | ✅ 5/5 通过 |
| 关联回归 | agent 模块全部 21 个测试套件 | ✅ 20/21 通过；`engine-async-robustness` 4/6（与本次无关，v0.24.x 既有 baseline 失败，git stash 验证过） |
| 端到端冒烟 | `scripts/verify-mcp-injection.ts`（真实起 python3 MCP echo server） | ✅ 6/6 Step 通过；git stash 修复后 Step 3 失败 → 反证修复必要性 |

## 设计决策

| 维度 | 选择 | 理由 |
| --- | --- | --- |
| 注入时机 | `listSkills()` 内运行时注入（不落盘） | MCP 状态实时变化（connect/disconnect/error），落盘会与运行时脱钩；运行时注入天然反映「当前可见」的 tool |
| ID 命名 | `M-{namespace}.{toolName}` | 与 `mcp-servers.ts` 的 server id 命名空间 `M-{slug}` 对齐；engine 的合并可走 serverId → tool 集合反查 |
| 缓存失效 | connect / disconnect 成功后调 `invalidateSkillCache` | MCP 状态变化是显式用户操作，触发 cache 失效即可；不必 heartbeat 周期失效 |
| 路径 | 走纯函数 `mcpServersToSkills` 抽出 | 测试可独立断言（不依赖 listSkills 的全套初始化）；与 registry 解耦 |
| 循环依赖规避 | 走 dynamic import（已有先例，registry→client.ts） | client.ts 不依赖 registry；保持单向约定 |
| `assembleTools` 合并策略 | serverId 集合 → 遍历 skills 命中 `source==='mcp'` 的 id 加入 | 比「直接合并 id」更稳：避免 skillIds 注入与 mcpIds 注入两条路径产生 id 冲突 |

## 不做的事

- ❌ 不持久化 MCP tools 到文件夹（运行时注入即可，避免双写漂移）
- � 不改 `McpServer` / `Skill` 类型
- ❌ 不改 PluginsPanel UI（v0.24.2 已就绪）
- ❌ 不动 design token / 既有 MCP 协议

## 风险

- `listSkills()` 现在依赖 `listMcpServers()`：mcp 模块加载失败时 catch
  + warn，不阻塞主路径（builtin skill 仍可见，Agent 仍可工作）。
- `assembleTools` 改为 serverId 集合反查：每轮 LLM 调用前 O(n) 遍历 skills；
  N 通常 < 50，可忽略；若后续接入大量 MCP server 需评估。
- 续聊路径 `appendMessage` 内部自动 cancel + run：合并 mcpIds 后下一次
  run 会重新走 `assembleTools`，无需手动 runTask。

## 打包产物

- `app/release/mac/ArkWork.app`（556 MB，identity=null 未签名）
  - v0.24.3 = v0.24.2 UI 容器化 + v0.24.3 MCP→Agent 桥接修复
- `app/release/ArkWork-0.24.3-x64.zip`（186 MB，distributable）
- `.dmg` 未产出：electron-builder dmgbuild 阶段 sandbox 拒绝写 `/dev/rdisk2s1`；
  `.app` 与 `.zip` 已就绪，dmg 用户可自行 `hdiutil create -srcfolder` 补做
- 老 v0.24.1 `.app` 已备份至 `app/release/mac-archive/ArkWork-0.24.1.app`
- 冒烟：`open release/mac/ArkWork.app` → 3s 后 `pkill -f ArkWork` → PID 存活后干净退出
- asar 内容核查：`npx asar extract` + grep `mcpServersToSkills`/`invalidateSkillCache` → 21 处命中
