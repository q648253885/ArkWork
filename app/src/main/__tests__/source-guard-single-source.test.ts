/* ============================================================
 * v0.36.0（B9.3 · D101/D102）—— 注释剥离器**唯一真源**守卫
 *
 * D101 建立了 `shared/utils/source-guard.ts`，但 v0.36.0 收尾普查发现
 * 收敛**不彻底**：全仓仍有 9 个测试文件自写 «块注释+行注释 正则替换»
 * （D102，已在本版收敛）。这些自写件有两个真实危害：
 *   ① 朴素 `replace(/\/\/.*$/gm,'')` 会把**字符串里的 `//`**（`'https://…'`）
 *      整段删掉 —— 守卫在悄悄改变被测对象；
 *   ② 每份实现各自演化，行为不一致（有的只删行注释、有的不剥缩进）。
 * 因此不能只靠「这次改了」，必须让**新增**也被拦下（纪律⑧：唯一事实源）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs source-guard-single-source
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'
// v0.38.0（D158）：全仓快照每进程只扫一次（此前 TC-D102-001 与 TC-D102-002 各自全仓读一遍）
import { getRepoScan } from '@shared/utils/repo-scan'

const SRC_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SELF = 'shared/utils/source-guard.ts'
const REPO = getRepoScan(SRC_ROOT)

/** 允许保留的唯一实现（真源自身） */
const ALLOWLIST = new Set([SELF])

/** 自写剥离器的指纹（用字面量 includes，避免正则双重转义带来的假红） */
const hasAdhoc = (code: string): boolean =>
  code.includes('replace(/\\/\\*') && code.includes('[\\s\\S]*?')

/** 抽出自写剥离器所在文件（相对 src/） */
function findAdhocStrippers(): string[] {
  const hits: string[] = []
  for (const abs of REPO.testSide) {
    const rel = abs.slice(SRC_ROOT.length + 1)
    if (rel.startsWith('test/')) continue // electron 桩等非源码
    const code = stripComments(REPO.raw(abs))
    if (hasAdhoc(code) && !ALLOWLIST.has(rel)) hits.push(rel)
  }
  return hits
}

test('TC-D102-001 ★ 全仓测试/守卫文件中不得再自写注释剥离器（D101/D102 唯一真源）', () => {
  const hits = findAdhocStrippers()
  assert.deepEqual(
    hits,
    [],
    `以下文件自写了注释剥离器，请改用 @shared/utils/source-guard 的 stripComments：\n${hits.join('\n')}`,
  )
})

test('TC-D102-002 ★ 真源本身存在且被足量消费（防「抽出来但没人用」）', () => {
  const files = REPO.all.filter((p) => REPO.raw(p).includes('stripComments('))
  assert.ok(files.length >= 10, `stripComments 的消费方应 ≥10 处，实际 ${files.length} —— 收敛可能被回退`)
})

test('TC-D102-003 检测器自检：指纹能识别朴素实现、且不误伤合规写法', () => {
  // 有判别力 —— 朴素实现必须命中（否则 TC-D102-001 是空转的永真断言）
  assert.ok(hasAdhoc("const code = src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')"), '检测器漏判朴素实现')
  // 不误伤 —— 合规写法（走真源）不得命中
  assert.equal(hasAdhoc('const code = stripComments(src)'), false, '合规写法被误判')
})
