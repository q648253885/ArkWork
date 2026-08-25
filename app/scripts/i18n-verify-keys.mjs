// 一次性校验：扫描 renderer 源码中所有 i18n.t()/t() 的 key，验证 zh.json 中存在
// （临时脚本，用完即删）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = '/Users/gongzheng/ai/ArkWork/app/src/renderer'
const zh = JSON.parse(readFileSync('/Users/gongzheng/ai/ArkWork/app/src/renderer/i18n/locales/zh.json', 'utf8'))
const en = JSON.parse(readFileSync('/Users/gongzheng/ai/ArkWork/app/src/renderer/i18n/locales/en.json', 'utf8'))

function lookup(obj, key) {
  let node = obj
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

const files = []
// keyPrefix 映射（与组件 useTranslation 配置保持一致）
const KEY_PREFIX = {
  'components/ModelSwitcher.tsx': 'modelswitcher',
  'components/RunConsole.tsx': 'runconsole',
  'components/ThoughtStream.tsx': 'thought',
}
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walk(p)
    } else if (/\.(tsx?|jsx?)$/.test(extname(name))) {
      files.push(p)
    }
  }
}
walk(ROOT)

// 匹配 t('key') / t("key") / i18n.t('key')，key 为点分路径（不匹配动态拼接）
const RE = /\bt\(\s*['"]([a-zA-Z][a-zA-Z0-9_.]*)['"]\s*[,)]/g
const missing = []
let total = 0
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  // 排除 import i18n 行自身；逐行扫描
  for (const m of src.matchAll(RE)) {
    const key = m[1]
    const rel = f.replace(ROOT + '/', '')
    const fullKey = KEY_PREFIX[rel] ? `${KEY_PREFIX[rel]}.${key}` : key
    total++
    if (lookup(zh, fullKey) === undefined) {
      missing.push({ file: rel, key: fullKey, rawKey: key })
    }
  }
}

console.log(`扫描 ${files.length} 个文件，共 ${total} 个静态 t() key`)
console.log(`zh.json 缺失：${missing.length} 个`)
// 分类：去掉首段前缀后命中 → 前缀错位；否则真缺失
const shifted = []
const realMissing = []
for (const m of missing) {
  const stripped = m.key.split('.').slice(1).join('.')
  if (stripped && lookup(zh, stripped) !== undefined) shifted.push({ ...m, stripped })
  else realMissing.push(m)
}
// 真缺失再分类：是否存在某顶层段 S 使 S.key 命中 → 组件缺 keyPrefix
const sections = Object.keys(zh).filter((k) => zh[k] && typeof zh[k] === 'object')
const prefixed = []
const lost = []
for (const m of realMissing) {
  const hit = sections.filter((s) => lookup(zh, `${s}.${m.key}`) !== undefined)
  if (hit.length > 0) prefixed.push({ ...m, sections: hit })
  else lost.push(m)
}
console.log(`\n== 前缀错位（去掉首段后命中，${shifted.length} 个）==`)
for (const { file, key, stripped } of shifted) {
  console.log(`  ${file}: ${key}  →  ${stripped}`)
}
console.log(`\n== 可用 keyPrefix 修复（key 存在于某顶层段，${prefixed.length} 个）==`)
const byFile = {}
for (const { file, key, sections: secs } of prefixed) {
  byFile[file] = byFile[file] || new Set()
  secs.forEach((s) => byFile[file].add(s))
}
for (const [file, secs] of Object.entries(byFile)) console.log(`  ${file}: keyPrefix 候选 ${[...secs].join('/')}`)
console.log(`\n== 真缺失（${lost.length} 个）==`)
for (const { file, key } of lost) {
  console.log(`  ${file}: ${key}`)
}