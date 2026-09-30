/* ============================================================
 * ArkWork — path-links 纯函数用例（TC-PLINK，v0.42.0 新增）
 * 侧栏清单「关联处理」增强的判据层：把产物摘要里的类路径 token 切成
 * 可点击分段。误判 = 把普通句子切碎成假链接；漏判 = 用户必须自己去
 * 工作区找文件。真值表钉死正/负例（纪律⑧：表驱动穷举关键分支）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs path-links
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  linkifyWorkspacePaths,
  looksLikePathToken,
  trimToken,
} from '../path-links'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

describe('path-links · TC-PLINK', () => {
  it('TC-PLINK-001 looksLikePathToken 正例：分隔符 + 常见形态', () => {
    const cases = [
      'src/app.ts',
      'src/app.ts:12',
      'app/renderer/main.tsx',
      'C:\\Users\\x\\y.ts',
      'docs/PROJECT-MAP.md,',
    ]
    for (const c of cases) assert.equal(looksLikePathToken(c), true, `「${c}」应判为路径`)
  })

  it('TC-PLINK-002 looksLikePathToken 负例：URL / 纯词 / 时间 / 口语目录 / 过短', () => {
    const cases = [
      'https://example.com/a.ts', // URL
      'http://x/y', // URL
      'hello', // 纯词
      '12:30', // 时间
      'src/', // 口语化目录引用（清洗后无分隔符）
      'a/b', // 过短（<3）
      'v1.2.3', // 版本号（无分隔符）
      '', // 空串
    ]
    for (const c of cases) assert.equal(looksLikePathToken(c), false, `「${c}」不应判为路径`)
  })

  it('TC-PLINK-003 trimToken：首尾标点清洗 + 行号后缀解析 + lead 偏移', () => {
    assert.deepEqual(trimToken('src/app.ts'), { path: 'src/app.ts', line: null, lead: 0 })
    assert.deepEqual(trimToken('"src/app.ts"'), { path: 'src/app.ts', line: null, lead: 1 })
    assert.deepEqual(trimToken('src/app.ts,'), { path: 'src/app.ts', line: null, lead: 0 })
    assert.deepEqual(trimToken('src/app.ts:12'), { path: 'src/app.ts', line: 12, lead: 0 })
    assert.deepEqual(trimToken('(src/app.ts:12),'), { path: 'src/app.ts', line: 12, lead: 1 })
    // 尾分隔符也清洗：`src/` → `src`（口语化目录引用，交由分隔符判据排除）
    assert.deepEqual(trimToken('src/'), { path: 'src', line: null, lead: 0 })
    // 数字结尾不是标点：时间不被误吃
    assert.deepEqual(trimToken('12:30'), { path: '12', line: 30, lead: 0 })
  })

  it('TC-PLINK-004 linkifyWorkspacePaths：混合句切分正确，text 段拼接与输入逐字一致', () => {
    const input = '修改了 src/app.ts 和 README.md，新增 12 行；参见 docs/guide.md:8。'
    const segs = linkifyWorkspacePaths(input)
    const paths = segs.filter((s) => s.kind === 'path').map((s) => s.value)
    // 「README.md，」清洗后无分隔符不误判；两个真路径命中，行号解析正确
    assert.deepEqual(paths, ['src/app.ts', 'docs/guide.md'])
    const guide = segs.find((s) => s.kind === 'path' && s.value === 'docs/guide.md')
    assert.equal(guide?.line, 8)
    // 无损性：全部分段按序拼接 = 输入
    assert.equal(segs.map((s) => s.value).join(''), input)
  })

  it('TC-PLINK-005 linkifyWorkspacePaths 边界：空串 / 纯文本 / 连续路径 / 首尾路径', () => {
    assert.deepEqual(linkifyWorkspacePaths(''), [])
    assert.deepEqual(
      linkifyWorkspacePaths('没有任何路径的一句话'),
      [{ kind: 'text', value: '没有任何路径的一句话' }],
    )
    // 连续路径（顿号分隔）
    const two = linkifyWorkspacePaths('src/a.ts、src/b.ts')
    assert.deepEqual(
      two.filter((s) => s.kind === 'path').map((s) => s.value),
      ['src/a.ts', 'src/b.ts'],
    )
    // 文本以路径开头 / 结尾
    assert.equal(linkifyWorkspacePaths('src/a.ts 开头')[0]?.kind, 'path')
    assert.equal(linkifyWorkspacePaths('结尾 src/a.ts').at(-1)?.kind, 'path')
  })

  it('TC-PLINK-006 接线契约：TodoPanel 是消费方（导入 + 渲染 FileLink），摘要非空才切分', () => {
    // 纪律⑭：接线类代码必须断言调用点存在（纯函数全对但没人调 = 死代码）
    const todo = readFileSync(new URL('../../components/dock/TodoPanel.tsx', import.meta.url), 'utf-8')
    assert.match(todo, /linkifyWorkspacePaths/, 'TodoPanel 必须消费 linkifyWorkspacePaths（关联处理增强）')
    assert.match(todo, /<FileLink/, 'path 段必须经 FileLink 渲染（openDoc 同一门面）')
  })
})
