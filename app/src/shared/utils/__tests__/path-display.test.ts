/* ============================================================
 * v0.33.1 W3 — path-display.ts 单测（展示层路径工具）
 *
 * 重点回归：Windows 反斜杠路径（`D:\a\b\c.ts`）的 basename/
 * dirname/截短展示；混合分隔符；纯函数零依赖密闭。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/shared/utils/__tests__/path-display.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseNameOf, dirNameOf, shortPathOf } from '../path-display.js'

test('baseNameOf POSIX 路径', () => {
  assert.equal(baseNameOf('/Users/foo/bar/baz.ts'), 'baz.ts')
})

test('baseNameOf Windows 盘符路径（回归：split(/) 整串直出）', () => {
  assert.equal(baseNameOf('D:\\travel_code\\ai\\report.md'), 'report.md')
})

test('baseNameOf 混合分隔符', () => {
  assert.equal(baseNameOf('D:\\work/sub\\file.txt'), 'file.txt')
  assert.equal(baseNameOf('C:/Users\\x\\y.js'), 'y.js')
})

test('baseNameOf 末尾分隔符与纯分隔符安全', () => {
  assert.equal(baseNameOf('/a/b/'), 'b')
  assert.equal(baseNameOf('/'), '/')
  assert.equal(baseNameOf(''), '')
})

test('baseNameOf 相对路径与裸文件名', () => {
  assert.equal(baseNameOf('src/index.ts'), 'index.ts')
  assert.equal(baseNameOf('README.md'), 'README.md')
})

test('dirNameOf POSIX / Windows / 根边界', () => {
  assert.equal(dirNameOf('/Users/foo/bar.ts'), '/Users/foo')
  assert.equal(dirNameOf('D:\\a\\b\\c.ts'), 'D:\\a\\b')
  assert.equal(dirNameOf('/root.ts'), '')
  assert.equal(dirNameOf('name.ts'), '')
})

test('shortPathOf 短路径原样返回', () => {
  assert.equal(shortPathOf('D:\\a\\b.ts'), 'D:\\a\\b.ts')
})

test('shortPathOf 长路径从分隔符边界截断并加 … 前缀', () => {
  const long = 'D:\\very\\long\\prefix\\' + 'x'.repeat(60) + '\\tail.ts'
  const out = shortPathOf(long, 56)
  assert.ok(out.startsWith('…'))
  assert.ok(out.endsWith('tail.ts'))
  assert.ok(out.length <= 57)
})
