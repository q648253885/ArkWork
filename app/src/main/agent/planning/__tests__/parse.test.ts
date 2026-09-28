/**
 * v0.39.0 详测 — 规划输出统一解析器（TC-PARSE-001…012）
 *
 * 依据：docs/versions/v0.39.0/04-system-design.md §6.2
 *       docs/versions/v0.39.0/testcases/00-cumulative-matrix.md TC-PARSE 组
 *
 * 全部**真执行**纯函数（无 IO / 无时钟 / 无随机，S6）。设计上有两条硬要求：
 *   · **宁缺毋滥** —— 普通正文绝不能被误判成清单（误判比漏判危险：它会让引擎
 *     替模型登记一份不是清单的清单，且 D176 产物门禁随后会卡住收尾）；
 *   · **不自证完成** —— 解析器产出的 `done` 一律降级 `todo`（S1，D181 解药：
 *     引擎不得替模型宣告完成，否则结合 I8 终态不可回退 → 不可自愈）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs planning/__tests__/parse
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePlannerOutput,
  parseJsonStrict,
  parseJsonFence,
  parseJsonRepair,
  parseChecklist,
  parseOutline,
  repairJson,
  sanitizeDraft,
} from '../parse.js'
import { PARSE_MAX_ITEMS, PARSE_MAX_TEXT } from '../types.js'

/* ---------------- L1/L2：JSON 家族 ---------------- */

test('TC-PARSE-001 L1 json-strict：整段裸 JSON 数组直接命中', () => {
  const r = parsePlannerOutput('[{"text":"写 PRD","status":"todo"},{"text":"写设计文档","status":"todo"}]')
  assert.ok(r, '应命中')
  assert.equal(r.via, 'json-strict')
  assert.deepEqual(
    r.draft.map((d) => d.text),
    ['写 PRD', '写设计文档'],
  )
  assert.equal(parseJsonStrict('  [{"text":"x"}]  ')?.via, 'json-strict', '允许首尾空白')
  assert.equal(parseJsonStrict('不是 JSON'), null)
  assert.equal(parseJsonStrict('{"items":[]}'), null, '顶层不是数组 → 交下一层')
})

test('TC-PARSE-002 L2 json-fence：代码块 + 对象包装（items/plan/tasks/steps）', () => {
  const fenced = parsePlannerOutput('先想一下：\n```json\n[{"text":"调研","status":"todo"},{"text":"编码","status":"todo"}]\n```')
  assert.ok(fenced)
  assert.equal(fenced.via, 'json-fence')
  assert.equal(fenced.draft.length, 2)

  for (const key of ['items', 'plan', 'tasks', 'steps']) {
    const r = parsePlannerOutput('```json\n{"' + key + '":[{"text":"A"},{"text":"B"}]}\n```')
    assert.ok(r, `包装键 ${key} 应被识别`)
    assert.deepEqual(r.draft.map((d) => d.text), ['A', 'B'])
  }
  assert.equal(parseJsonFence('没有代码块'), null)
})

test('TC-PARSE-003 L2 取**最后一个**合法块（模型常先写错再改对）', () => {
  const raw = [
    '草稿（作废）：',
    '```json',
    '[{"text":"废弃项","status":"todo"}]',
    '```',
    '最终：',
    '```json',
    '[{"text":"正确项A","status":"todo"},{"text":"正确项B","status":"todo"}]',
    '```',
  ].join('\n')
  const r = parsePlannerOutput(raw)
  assert.ok(r)
  assert.deepEqual(r.draft.map((d) => d.text), ['正确项A', '正确项B'], '不得把废弃草案当主草案')
})

test('TC-PARSE-004 L3 json-repair：注释 / 裸键 / 尾逗号 /（全单引号）', () => {
  // ① 行注释 + 裸键 + 尾逗号（弱模型最常见的三种坏味道叠加）
  const rawA = `思路：先拆三步。
[
  // 第一步
  { text: "调研现状", status: "todo" },
  { text: "设计接口", status: "todo" },
  { text: "实现", status: "todo" },
]`
  const a = parsePlannerOutput(rawA)
  assert.ok(a, '修补后应可解析')
  assert.equal(a.via, 'json-repair')
  assert.deepEqual(a.draft.map((d) => d.text), ['调研现状', '设计接口', '实现'])

  // ② 全单引号形态（整段不含双引号时才做单→双转换）
  const b = parsePlannerOutput("[{'text':'a','status':'todo'},{'text':'b','status':'todo'}]")
  assert.ok(b)
  assert.equal(b.via, 'json-repair')
  assert.deepEqual(b.draft.map((d) => d.text), ['a', 'b'])

  // ③ **已知边界**（有意为之，不修）：单引号键 + 双引号值混用不修补 ——
  //    整段含双引号时做单→双转换会破坏正文里的英文撇号（it's / don't），
  //    两种误伤的代价不对称：漏一层降级只是退回既有守卫链，而破坏正文是静默语义错误。
  assert.equal(
    parsePlannerOutput(`[{'text': "混用"},{"text":"正常"}]`),
    null,
    '混用引号 → 返回 null（宁缺毋滥；已知边界记入 BACKLOG）',
  )
})

test('TC-PARSE-005 L3 repairJson 必须字符串感知：URL / 路径里的 // 不得被当注释砍掉', () => {
  const raw = '[{"text":"拉取 https://example.com/a/b 的规范"},{"text":"写到 /tmp/x"}]'
  const repaired = repairJson(raw)
  assert.ok(repaired)
  assert.ok(repaired.includes('https://example.com/a/b'), '← URL 必须原样保留（朴素注释正则会砍成 https:）')
  const r = parsePlannerOutput(raw)
  assert.ok(r)
  assert.equal(r.draft[0]!.text, '拉取 https://example.com/a/b 的规范')
  // 块注释同样不得吞掉真实代码
  const r2 = parsePlannerOutput('[{"text":"a"}, /* 说明 */ {"text":"b"}]')
  assert.deepEqual(r2?.draft.map((d) => d.text), ['a', 'b'])
  assert.equal(parseJsonRepair('没有方括号'), null)
})

/* ---------------- L4/L5：弱模型形态 ---------------- */

test('TC-PARSE-006 L4 checklist：≥2 行才成立；单行易误伤', () => {
  const r = parsePlannerOutput('我的计划：\n- [ ] 调研\n- [x] 写大纲\n- [ ] 编码')
  assert.ok(r)
  assert.equal(r.via, 'checklist')
  assert.equal(r.draft.length, 3)
  // [x] 被 S1 降级为 todo（且不是 done）
  assert.equal(r.draft[1]!.status, 'todo')
  assert.match(r.draft[1]!.note ?? '', /未经执行验证/)
  assert.equal(parseChecklist('- [ ] 只有一项'), null, '单行 checklist 不得成立')
})

test('TC-PARSE-007 L5 outline：必须有计划类标题 + ≥2 条', () => {
  const r = parsePlannerOutput('## 执行计划\n1. 调研开源方案\n2. 产出调研文档\n3. 编写 PRD')
  assert.ok(r)
  assert.equal(r.via, 'outline')
  assert.equal(r.draft.length, 3)
  assert.equal(parseOutline('今天天气不错。\n1. 吃饭\n2. 睡觉'), null, '无计划标题 → 不得成立')
  assert.equal(parseOutline('## 任务清单\n1. 唯一一项'), null, '少于 2 条 → 不得成立')
})

test('TC-PARSE-008 L5 outline：遇到非列表段落即停（清单区块结束）', () => {
  const raw = ['## 任务清单', '1. 第一步', '2. 第二步', '', '以上是我的想法，接下来我解释一下理由：', '3. 顺带说一句无关的话'].join('\n')
  const r = parseOutline(raw)
  assert.ok(r)
  assert.deepEqual(r.draft.map((d) => d.text), ['第一步', '第二步'], '非列表段落之后的编号行不得再收（那是正文）')
})

test('TC-PARSE-009 ★ 宁缺毋滥：普通答复 / 空输入一律返回 null', () => {
  assert.equal(parsePlannerOutput(''), null)
  assert.equal(parsePlannerOutput('   '), null)
  assert.equal(parsePlannerOutput(null), null)
  assert.equal(parsePlannerOutput(undefined), null)
  assert.equal(parsePlannerOutput('你好，我可以帮你做这些事。'), null)
  assert.equal(parsePlannerOutput('已完成，2+3=5。'), null)
  assert.equal(parsePlannerOutput('```\n{"a":1}\n```'), null, 'fence 内不是清单 → null，不得当空清单落库')
  assert.equal(parsePlannerOutput('[]'), null, '空数组 → null（由调用方按 Tier-0 处理，不是"零项清单"）')
})

/* ---------------- 安全不变量 S1–S5 ---------------- */

test('TC-PARSE-010 ★★ S1（D181 解药）：解析出的 done 一律降级 todo 并留人话', () => {
  const r = parsePlannerOutput(
    '[{"text":"部署上线","status":"done"},{"text":"写文档","status":"done","note":"已产出 README"}]',
  )
  assert.ok(r)
  assert.deepEqual(r.draft.map((d) => d.status), ['todo', 'todo'], '引擎不得替模型宣告完成')
  assert.match(r.draft[0]!.note ?? '', /未经执行验证/)
  assert.match(r.draft[1]!.note ?? '', /已产出 README｜解析自正文，未经执行验证/, '原有 note 保留并被标注来源')
  assert.ok(r.warnings.some((w) => w.includes('降级为待做')), '降级必须留 warning（纪律⑨：不许静默）')
})

test('TC-PARSE-011 S2/S3：最多一个 doing；未知状态归 todo 并告警', () => {
  const r = parsePlannerOutput(
    '[{"text":"A","status":"doing"},{"text":"B","status":"doing"},{"text":"C","status":"weird"}]',
  )
  assert.ok(r)
  assert.deepEqual(r.draft.map((d) => d.status), ['doing', 'todo', 'todo'])
  assert.ok(r.warnings.some((w) => w.includes('同时只能有一项在进行中')))
  assert.ok(r.warnings.some((w) => w.includes('无法识别')))
})

test('TC-PARSE-012 S4/S5：截断 80 字 / 去重 / 去空 / 超 20 项截断', () => {
  const long = 'x'.repeat(PARSE_MAX_TEXT + 40)
  const many = Array.from({ length: PARSE_MAX_ITEMS + 5 }, (_, i) => ({ text: `项${i}`, status: 'todo' }))
  const r = sanitizeDraft(
    [{ text: long }, { text: long }, { text: '  ' }, { text: '唯一项' }, ...many],
    'json-strict',
  )
  assert.ok(r)
  assert.equal(r.items.length, PARSE_MAX_ITEMS, '超上限截断')
  const first = r.items[0]!
  assert.ok(first.text.length <= PARSE_MAX_TEXT, `截断后应 ≤ ${PARSE_MAX_TEXT} 字`)
  assert.equal(r.items.filter((i) => i.text.startsWith('xxx')).length, 1, '全等去重')
  assert.ok(!r.items.some((i) => i.text === ''), '空文本不得入列')
  assert.equal(sanitizeDraft([{ text: '   ' }], 'json-strict'), null, '全空 → null')
})
