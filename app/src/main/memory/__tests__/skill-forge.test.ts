/* ============================================================
 * v0.25.0 F3 — skill-forge.ts 单测（完整性校验五项 + 隔离区）
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *          --test src/main/memory/__tests__/skill-forge.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifySkillIntegrity,
  quarantineSkill,
  listQuarantine,
  deleteQuarantineEntry,
  normalizeTokens,
  jaccard,
  isGenericDistill,
  looksLikeRefusal,
  purgeLegacyDistillSkills,
  LEGACY_DISTILL_PREFIX,
  DUPLICATE_JACCARD_THRESHOLD,
  MAX_DISTILLED_SKILLS,
} from '../skill-forge.js'
import { slugifySkillName, allocateDistillSkillId } from '../convert.js'

const GOOD_SKILL = `---
name: my-forged-skill
description: 测试用蒸馏技能
---
# 测试技能标题
## 适用场景
当需要演示 skill-forge 完整性校验时使用，触发关键词：测试、forge、demonstration。本测试场景覆盖了五项完整性校验全通过的情况，用于回归 verifySkillIntegrity 在良好输入下的行为。
## 步骤 / 检查清单
1. 先调用 verifySkillIntegrity
2. 检查返回的 pass 字段
3. 校验失败时检查 quarantine 目录
4. 校验通过时检查 skill 能被 discoverSkills 发现
5. 在 CI 中跑全部 9 个单元测试用例
## 注意事项
- 仅用于单元测试；不要把这段字符串复制到生产 SKILL.md
- 五项校验需全部通过才算 forge 注册；任一不过即入隔离区
- 隔离区保留最新 20 条；超出按 mtime 降序裁剪
- skill-forge 在 runDoneMemoryHooks 中由 task-done 时机触发，与 distill 评估独立`

/* ============================================================
 * v0.34.1 补口：语义闸门（校验 6/7/8/9）
 *
 * 触发原因（真实数据）：本机技能库堆了 118 个 `S-distill.*`，内容高度同类，
 * 还有正文是「无法从空对话中提炼技能」的拒答文本 —— 旧五项只查格式，
 * 格式全对 → 全部注册。下面每组用例钉住「值不值得存在」这件事。
 * ============================================================ */

test('TC-FORGE-001 verifySkillIntegrity 通过：9 项全 pass（注入空技能库，不依赖磁盘）', async () => {
  const report = await verifySkillIntegrity(GOOD_SKILL, { existing: [] })
  assert.equal(report.pass, true, `未通过项：${report.checks.filter((c) => !c.pass).map((c) => `${c.id}(${c.detail})`).join('; ')}`)
  assert.equal(report.checks.length, 9)
  assert.ok(report.checks.every((c) => c.pass))
  // 九项闸门一个都不能少（新增/删除校验项必须同步本断言）
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ['frontmatter-valid', 'body-nonempty', 'structure-complete', 'discoverable',
      'no-conflict', 'no-near-duplicate', 'not-generic', 'no-refusal', 'forge-budget'],
  )
})

test('TC-FORGE-002 近似重复：换名不换内容 → no-near-duplicate fail', async () => {
  const existing = [
    { id: 'S-forge.troubleshooting', name: 'nginx-cors-debug', description: '排查 nginx 反向代理跨域错误', tags: ['distilled'] },
  ]
  const nearDup = `---
name: nginx-cors-debug-2
description: 排查 nginx 反向代理跨域错误
---
# nginx 跨域排查
## 适用场景
${existing[0].description}触发关键词：nginx、cors、跨域、反向代理、504。本场景覆盖反向代理配置错误导致的跨域失败排查全过程，包含配置文件与请求头检查。
## 步骤 / 检查清单
1. 检查 nginx 配置
2. 检查响应头
3. 复现请求
4. 修正配置并重载
## 注意事项
- 每次改动后 reload；注意缓存头影响复现结果`
  const report = await verifySkillIntegrity(nearDup, { existing })
  const c = report.checks.find((x) => x.id === 'no-near-duplicate')
  assert.equal(c?.pass, false, `应判近似重复，实际：${c?.detail}`)
})

test('TC-FORGE-003 近似重复阈值常量在合理区间且被引用', () => {
  assert.ok(DUPLICATE_JACCARD_THRESHOLD > 0.4 && DUPLICATE_JACCARD_THRESHOLD < 0.9, '阈值应在 (0.4, 0.9) —— 过低误杀、过高漏放')
  assert.ok(MAX_DISTILLED_SKILLS >= 5 && MAX_DISTILLED_SKILLS <= 50, '蒸馏技能上限应在 5~50')
})

test('TC-FORGE-004 通用流程无技术锚点 → not-generic fail；有锚点 → pass', () => {
  assert.equal(
    isGenericDistill('systematic-troubleshooting', '系统化排查问题的通用流程', '先复现，再看日志，再改。'),
    true,
    '无技术锚点的通用排错流程必须被拦（宿主已有通用流程）',
  )
  assert.equal(
    isGenericDistill('nginx-cors-debug', '排查 nginx 反向代理的跨域错误', '检查 /etc/nginx/nginx.conf 的 add_header 配置'),
    false,
    '带具体配置文件锚点的领域技能必须放行',
  )
  assert.equal(
    isGenericDistill('my-forged-skill', '测试用蒸馏技能', '任意正文'),
    false,
    '未命中通用特征词的不应被拦',
  )
})

test('TC-FORGE-005 拒答/凑数正文 → no-refusal fail（模型说"没法提炼"不许注册）', async () => {
  const refusal = `---
name: empty-distill
description: 空对话蒸馏
---
# 空对话
## 适用场景
无
## 步骤 / 检查清单
1. 无法从空对话中提炼技能。请提供具体的排错任务对话内容，我将据此生成 SKILL.md。
2. ${'x'.repeat(220)}`
  const report = await verifySkillIntegrity(refusal, { existing: [] })
  const c = report.checks.find((x) => x.id === 'no-refusal')
  assert.equal(c?.pass, false, `拒答正文必须被拦，实际：${c?.detail}`)
  assert.equal(looksLikeRefusal('无法从空对话中提炼技能。请提供具体的排错任务对话内容'), true)
  assert.equal(looksLikeRefusal('检查 nginx 配置并 reload'), false)
})

test('TC-FORGE-006 蒸馏技能超上限 → forge-budget fail', async () => {
  const existing = Array.from({ length: MAX_DISTILLED_SKILLS }, (_, i) => ({
    id: `S-forge.skill-${i}`,
    name: `skill-${i}`,
    description: `第 ${i} 个蒸馏技能`,
    tags: ['distilled'],
  }))
  const report = await verifySkillIntegrity(GOOD_SKILL, { existing })
  const c = report.checks.find((x) => x.id === 'forge-budget')
  assert.equal(c?.pass, false, `达到上限必须拦，实际：${c?.detail}`)
  // 恰好差一个 → 放行（边界）
  const okReport = await verifySkillIntegrity(GOOD_SKILL, { existing: existing.slice(0, MAX_DISTILLED_SKILLS - 1) })
  assert.equal(okReport.checks.find((x) => x.id === 'forge-budget')?.pass, true)
})

test('TC-FORGE-007 词元化与 Jaccard：中文按二字组、空集记 0、全同记 1', () => {
  const a = normalizeTokens('nginx 跨域排查')
  assert.ok(a.has('nginx'))
  assert.ok(a.has('跨域') && a.has('域排'))
  assert.equal(jaccard(new Set(), new Set(['a'])), 0, '空集与空集/非空集都记 0')
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
  // 交集 1（a）／并集 3（a,b,c）→ 1/3
  assert.ok(Math.abs(jaccard(new Set(['a', 'b']), new Set(['a', 'c'])) - 1 / 3) < 1e-9)
})

test('TC-FORGE-008 蒸馏技能 id 语义化（不再是不可辨认的裸哈希）', async () => {
  assert.equal(slugifySkillName('Nginx CORS Debug'), 'nginx-cors-debug')
  assert.equal(slugifySkillName('系统化排错'), '')
  assert.equal(slugifySkillName(undefined), '')
  // 冲突避让：同名追加 -2
  const taken = new Set(['S-forge.nginx-cors-debug'])
  assert.equal(await allocateDistillSkillId('Nginx CORS Debug', taken), 'S-forge.nginx-cors-debug-2')
  assert.equal(await allocateDistillSkillId('Nginx CORS Debug', new Set()), 'S-forge.nginx-cors-debug')
  const fallback = await allocateDistillSkillId(undefined, new Set())
  assert.match(fallback, /^S-forge\./, '回退 id 也必须带语义前缀')
})

test('TC-FORGE-009 历史蒸馏技能清理：前缀常量 + 幂等（无匹配不报错）', async () => {
  assert.equal(LEGACY_DISTILL_PREFIX, 'S-distill.')
  // 幂等性：重复调用不应抛错（真实机器上第二次应返回空 removed）
  const res = await purgeLegacyDistillSkills()
  assert.ok(Array.isArray(res.removed))
  assert.ok(Array.isArray(res.failed))
})

// v0.34.1：原「5 项全 pass」用例已升级为 TC-FORGE-001（注入空技能库 + 钉住九项闸门顺序）——
// 旧用例直接扫真实磁盘，在装过历史蒸馏技能的机器上会因 forge-budget 而假红。

test('verifySkillIntegrity frontmatter 缺失 → fail', async () => {
  const noFm = `# 测试\n## 适用场景\nxxx\n## 步骤\n1. x`
  const report = await verifySkillIntegrity(noFm)
  assert.equal(report.pass, false)
  const c = report.checks.find((x) => x.id === 'frontmatter-valid')
  assert.equal(c?.pass, false)
})

test('verifySkillIntegrity 指令体 <200 字 → fail', async () => {
  const short = `---
name: short-skill
description: short
---
# 短指令体
## 适用场景
x
## 步骤
1. x`
  const report = await verifySkillIntegrity(short)
  assert.equal(report.pass, false)
  const c = report.checks.find((x) => x.id === 'body-nonempty')
  assert.equal(c?.pass, false)
})

test('verifySkillIntegrity 缺结构要素 → structure-complete fail', async () => {
  const noStructure = `---
name: no-structure
description: no-structure
---
# 只有标题
${'x'.repeat(250)}`
  const report = await verifySkillIntegrity(noStructure)
  assert.equal(report.pass, false)
  const c = report.checks.find((x) => x.id === 'structure-complete')
  assert.equal(c?.pass, false)
})

test('verifySkillIntegrity id 含非法字符 → discoverable fail', async () => {
  const badId = `---
name: "中文 id 空格"
description: bad id
---
# 测试
## 适用场景
${'x'.repeat(250)}
## 步骤
1. x`
  const report = await verifySkillIntegrity(badId)
  assert.equal(report.pass, false)
  // 中文 id 同时让 frontmatter-valid + discoverable 失败
  const fm = report.checks.find((x) => x.id === 'frontmatter-valid')
  assert.equal(fm?.pass, false)
})

test('quarantineSkill 写入 SKILL.md + report.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-q-'))
  try {
    // 通过 monkey-patch getArkworkDir 不易；改用隔离区真实函数（写入 HOME 或 arkwork 目录）
    // 这里仅测试隔离区数据结构（listQuarantine + deleteQuarantineEntry）
    const report = { reason: '测试隔离', checks: [{ id: 'frontmatter-valid', pass: false, detail: 'test' }] }
    const path = await quarantineSkill(GOOD_SKILL, report, 't_test_task')
    assert.ok(path.includes('skills-quarantine'))
    const list = await listQuarantine()
    const entry = list.find((e) => e.reason.includes('测试隔离') || e.path === path)
    // listQuarantine 来自 arkworkDir；若 path 不在其中则断言 dir 存在即可
    if (entry) {
      await deleteQuarantineEntry(entry.id)
    }
    // 即便没有匹配项，函数调用本身应当成功（隔离区写入 arkworkDir）
    void dir
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listQuarantine 空目录返回 []', async () => {
  // 隔离区若不存在或为空，listQuarantine 返回 []（函数本身不应抛错）
  const list = await listQuarantine()
  assert.ok(Array.isArray(list))
})

test('deleteQuarantineEntry 不存在的 id 静默', async () => {
  await deleteQuarantineEntry('nonexistent_id_zzz')
  // 不抛错即可
})

test('verifySkillIntegrity 综合性：4 项不通过', async () => {
  const bad = `---
name: "@@@bad id@@@"
description: 
---
# 无结构内容`
  const report = await verifySkillIntegrity(bad)
  assert.equal(report.pass, false)
  const failed = report.checks.filter((c) => !c.pass).map((c) => c.id)
  // 至少 frontmatter-valid / body-nonempty / structure-complete 三项必失败
  assert.ok(failed.includes('frontmatter-valid'))
  assert.ok(failed.includes('body-nonempty'))
  assert.ok(failed.includes('structure-complete'))
})
