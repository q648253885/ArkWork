/* ============================================================
 * ArkWork — 新建插件脚手架（v0.35.0 · M10）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §7（脚手架入口）· PRD S1
 *
 * 为什么要有脚手架：**「插件开发」的门槛不该是「先读懂 3 份设计文档」**。
 * 从零手写 `plugin.json` 的作者 90% 会踩这三件事：
 *  ① 忘了 `schemaVersion`；② `provides.<kind>` 与 `kind` 不匹配；
 *  ③ Host 半写了 `export function apply` 却把文件叫 `main.js`（CJS 解析 → 语法错）。
 * 脚手架产出一份**开箱即通过校验**的最小工作集，作者只需改业务逻辑。
 *
 * ★ 三条纪律：
 *  ① **绝不覆盖已有目录**（作者手改过的代码比模板值钱）；
 *  ② **生成物必须自己先过校验**（`parsePluginManifest` 跑一遍，不过就不落盘）；
 *  ③ 每个文件都带**为什么**的注释 —— 模板的作用是教学，不是填空。
 * ============================================================ */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from '../system/logger.js'
import { pluginsDir, ensurePluginsDir, type PluginScope } from './store.js'
import { parsePluginManifest } from '@shared/utils/plugin-manifest'
import { bridgeClientSource } from '@shared/utils/plugin-view-bridge'
import { PLUGIN_SCHEMA_VERSION, type PluginKind } from '@shared/types/plugin'

export interface ScaffoldInput {
  /** 命名空间.名称（`^[a-z0-9-]+(\.[a-z0-9-]+)+$`） */
  id: string
  name: string
  kind: PluginKind
  scope: PluginScope
}

export interface ScaffoldResult {
  ok: boolean
  dir?: string
  files?: string[]
  reason?: 'bad-args' | 'exists' | 'invalid-manifest' | 'fs-error'
  /** 人话原因（reason='invalid-manifest' 时是校验问题摘要） */
  message?: string
}

/** 目录名取 id 末段（`ark.plugin.demo` → `demo`；与扫描约定一致，见 store.ts） */
export function scaffoldDirName(id: string): string {
  return id.split('.').pop() || id
}

/** 生成清单（**导出以供用例断言「模板自己先过校验」**） */
export function scaffoldManifest(input: ScaffoldInput): Record<string, unknown> {
  const short = scaffoldDirName(input.id)
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    version: '1.0.0',
    author: '',
    description: `${input.name}（由 ArkWork 脚手架生成）`,
    kind: input.kind,
    enabledByDefault: false,
    // 宿主兼容范围：写在脚手架上是给作者看的 —— 改窄会让插件在新宿主上被拒
    engines: { arkwork: '>=0.35.0' },
    // Host 半入口（CJS；要写 ESM 请改名为 .mjs）
    main: 'main.js',
    // Client 半入口（HTML；iframe 加载的就是它）
    renderer: 'index.html',
    // 懒激活：默认不自动起进程，打开视图时再激活（省内存）
    activation: [`onView:view:${short}`],
    // 能力声明：**默认拒绝**，模板给最小一组并在注释里标明每一项的用途
    permissions: ['tools.register', 'views.register'],
    provides: {
      views: [
        {
          viewRef: `view:${short}`,
          title: input.name,
          icon: 'Graph',
          placement: 'dock', // dock=右侧侧边栏；float=浮窗。插件只能在这两处加挂点
        },
      ],
      tools: [
        {
          name: `${short.replace(/-/g, '_')}_ping`,
          description: `示例工具：回显入参（${input.name}）`,
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: '要回显的文本' } },
          },
        },
      ],
    },
  }
}

/** Host 半模板（CJS —— 不用改名、不用配置，拷出来就能跑） */
function mainTemplate(input: ScaffoldInput, toolName: string): string {
  return `/* ============================================================
 * ${input.name} — Host 半（跑在 ArkWork 的 utilityProcess 里）
 *
 * 这是**唯一**能访问宿主的地方。规则只有三条：
 *   1. 只导出 \`apply(ctx)\`；宿主会调用它一次。
 *   2. 任何「注册/监听/开资源」都要用 \`ctx.effect(() => {...})\` 或
 *      \`ctx.ark.*.register()\` 登记，宿主才能在卸载时精确撤销。
 *   3. 访问宿主只能走 \`ctx.ark.*\`（没有 require / process 逃逸口）。
 *
 * 想写 ESM 语法？把本文件改名为 main.mjs，并同步改 plugin.json 的 main 字段。
 * ============================================================ */
const TOOL_NAME = '${toolName}'

module.exports = {
  apply(ctx) {
    ctx.ark.log('info', '${input.name} 已激活')

    // 卸载时宿主会逆序跑这里登记的所有清理函数
    ctx.effect(() => {
      ctx.ark.log('info', '${input.name} 已卸载')
    })

    // 宿主事件：只认白名单里的名字（写错会当场报错，而不是静默不触发）
    ctx.on('workspace:changed', () => {
      // 工作区文件变了 —— 在这里刷新你自己的数据
    })

    // 给模型加一个工具。名字必须先在 plugin.json 的 provides.tools 里声明过。
    ctx.ark.tools.register({
      name: TOOL_NAME,
      description: '示例工具：回显入参',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      handler: async (input) => {
        // 读工作区文件（需要 fs:workspace-read 权限）
        // const file = await ctx.ark.fs.read('README.md')
        return { ok: true, echo: input && input.text, at: new Date().toISOString() }
      },
    })
  },
}
`
}

/** Client 半模板（HTML + 经典脚本；无构建步骤） */
function htmlTemplate(input: ScaffoldInput): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${input.name}</title>
  <!--
    这个页面跑在 <iframe sandbox="allow-scripts"> 里：
      · 拿不到宿主 DOM / localStorage / cookie（这是**结构上**保证的，不是靠约定）；
      · 也不能直连网络（CSP connect-src 'none'）——
        要取数请调 call('data.request', { url }) 走宿主，或让 Host 半去取。
    样式请自己写。宿主不注入任何 CSS，避免「看起来像原生界面」造成误解。
  -->
  <style>
    :root { color-scheme: dark light; }
    body { margin: 0; padding: 12px; font: 13px/1.6 -apple-system, "PingFang SC", sans-serif;
           background: Canvas; color: CanvasText; }
    button { font: inherit; padding: 4px 10px; border-radius: 6px;
             border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
             background: color-mix(in srgb, CanvasText 8%, transparent); color: inherit; cursor: pointer; }
    pre { white-space: pre-wrap; word-break: break-all; opacity: .85; }
  </style>
</head>
<body>
  <div id="app">等待宿主握手…</div>
  <p><button id="ping">调用宿主工具（经 Host 半）</button></p>
  <pre id="out"></pre>
  <script src="./renderer.js"></script>
  <script>
    // 经典脚本：renderer.js 里的 call / onHostEvent 就在这个作用域里
    document.getElementById('ping').addEventListener('click', async () => {
      try {
        // 示例：向宿主报告尺寸（宿主会夹到合理区间）
        const size = await call('ui.resize', { w: 420, h: 360 })
        document.getElementById('out').textContent = '宿主接受尺寸：' + JSON.stringify(size)
      } catch (err) {
        document.getElementById('out').textContent = '调用失败：' + err.message
      }
    })
  </script>
</body>
</html>
`
}

/** README（作者唯一需要读的一页） */
function readmeTemplate(input: ScaffoldInput): string {
  return `# ${input.name}

由 ArkWork 脚手架生成的插件（id：\`${input.id}\`）。

## 目录

| 文件 | 作用 |
|---|---|
| \`plugin.json\` | 清单。**唯一的必需文件**；不写代码也可以只靠它做一个声明式插件 |
| \`main.js\` | Host 半。跑在独立进程里，导出一个 \`apply(ctx)\` |
| \`index.html\` | Client 半。跑在沙箱 iframe 里，宿主界面之外的独立页面 |
| \`renderer.js\` | Client 半的脚本（桥客户端已内置） |

## 三个必须知道的事实

1. **插件只能加挂点到「右侧侧边栏」与「浮窗」**。\`provides.views[].placement\`
   只接受 \`dock\` 与 \`float\`，别的值会被校验直接拒掉。
2. **权限默认拒绝**。要用哪个能力就得在 \`plugin.json\` 的 \`permissions\` 里写出来，
   没写的调用会拿到 \`E_PERMISSION_DENIED\`。
3. **卸载会精确撤销**。凡是没登记成 effect 的东西（定时器、订阅、临时文件），
   卸载后都会留下残留 —— 用 \`ctx.effect(() => cleanup())\` 登记。

## 调试

- 改了 \`plugin.json\`：在「能力 → 插件」点**重新扫描**。
- 改了 \`main.js\`：点该插件的**重载**（会重建 Host 半进程）。
- 改了 \`index.html\` / \`renderer.js\`：关掉再打开视图即可（资源不缓存）。
- Host 半的 \`console.log\` 会带 \`[plugin:${input.id}]\` 前缀进宿主日志。
`
}

/* ============================================================
 * 生成
 * ============================================================ */
export function scaffoldPlugin(input: ScaffoldInput): ScaffoldResult {
  const id = String(input.id ?? '').trim()
  const name = String(input.name ?? '').trim()
  if (!id || !name) return { ok: false, reason: 'bad-args', message: 'id 与 name 都不能为空' }

  const manifest = scaffoldManifest({ ...input, id, name })
  // ★ 纪律②：生成物必须先自己过一遍校验。模板写错了却让作者去排查，是最差的体验。
  const parsed = parsePluginManifest(manifest)
  if (!parsed.manifest) {
    const msg = parsed.issues
      .filter((i) => i.level === 'error')
      .map((i) => `${i.rule} ${i.path}: ${i.message}`)
      .join('；')
    return { ok: false, reason: 'invalid-manifest', message: msg }
  }

  const root = ensurePluginsDir(input.scope)
  const dir = join(root, scaffoldDirName(id))
  if (existsSync(dir)) {
    return { ok: false, reason: 'exists', dir, message: `目录已存在，脚手架不会覆盖：${dir}` }
  }

  const toolName = parsed.manifest.provides.tools?.[0]?.name ?? 'demo_ping'
  const files: Array<[string, string]> = [
    ['plugin.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['main.js', mainTemplate({ ...input, id, name }, toolName)],
    ['index.html', htmlTemplate({ ...input, id, name })],
    ['renderer.js', bridgeClientSource({ pluginName: name })],
    ['README.md', readmeTemplate({ ...input, id, name })],
  ]

  try {
    mkdirSync(dir, { recursive: true })
    for (const [rel, content] of files) writeFileSync(join(dir, rel), content, 'utf-8')
  } catch (err) {
    logger.warn('System', `[plugin] 脚手架写入失败：${String(err)}`)
    return { ok: false, reason: 'fs-error', message: String(err) }
  }

  logger.info('System', `[plugin] 已生成脚手架 ${id} → ${dir}`)
  return { ok: true, dir, files: files.map(([f]) => f) }
}

/** 供 UI 展示「会生成哪些文件」（不落盘） */
export function scaffoldPreviewFiles(): string[] {
  return ['plugin.json', 'main.js', 'index.html', 'renderer.js', 'README.md']
}

export { pluginsDir }
