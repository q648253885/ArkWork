// 一次性合脚本：把子代理产出的三个 JSON 合并进 renderer/i18n/locales/{zh,en,ja,ko}.json
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = '/Users/gongzheng/ai/ArkWork/app'
const LOCALE_DIR = `${ROOT}/src/renderer/i18n/locales`
const SOURCES = [
  '/tmp/arkwork-i18n/settings-content.json',
  '/tmp/arkwork-i18n/skills-panel.json',
  '/tmp/arkwork-i18n/command-palette.json',
  '/tmp/arkwork-i18n/help-center.json',
  '/tmp/arkwork-i18n/composer-editors.json',
  '/tmp/arkwork-i18n/sidebar-leftnav.json',
  '/tmp/arkwork-i18n/dock.json',
  '/tmp/arkwork-i18n/preview.json',
  '/tmp/arkwork-i18n/panels.json',
  '/tmp/arkwork-i18n/app-topbar-centerstage.json',
  '/tmp/arkwork-i18n/runtime-panels.json',
  '/tmp/arkwork-i18n/quickaction.json',
  '/tmp/arkwork-i18n/browser-dock.json',
  '/tmp/arkwork-i18n/misc-components.json',
  '/tmp/arkwork-i18n/store-meta.json',
  '/tmp/arkwork-i18n/store-slices.json',
  '/tmp/arkwork-i18n/plan-status.json',
]
const LANGS = ['zh', 'en', 'ja', 'ko']

function flattenKeys(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flattenKeys(v, path, out)
    else out.push(path)
  }
  return out
}
for (const src of SOURCES) {
  const data = JSON.parse(readFileSync(src, 'utf8'))
  const keys = Object.fromEntries(LANGS.map((l) => [l, flattenKeys(data[l]).sort()]))
  for (const l of LANGS) {
    const same = JSON.stringify(keys[l]) === JSON.stringify(keys.zh)
    console.log(`${src.split('/').pop()}: ${l} 键集与 zh ${same ? '一致' : '不一致!'} (${keys[l].length})`)
    if (!same) {
      const diff = keys[l].filter((x) => !keys.zh.includes(x))
      console.log('   差异:', diff)
    }
  }
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = target[k] && typeof target[k] === 'object' ? deepMerge(target[k], v) : v
    } else {
      target[k] = v
    }
  }
  return target
}

function expandFlat(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const parts = k.split('.')
    let node = out
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || {}
      node = node[parts[i]]
    }
    node[parts[parts.length - 1]] = v
  }
  return out
}

for (const lang of LANGS) {
  let merged = {}
  for (const src of SOURCES) {
    const data = JSON.parse(readFileSync(src, 'utf8'))
    merged = deepMerge(merged, data[lang])
  }
  const fpath = `${LOCALE_DIR}/${lang}.json`
  const existing = JSON.parse(readFileSync(fpath, 'utf8'))
  deepMerge(existing, merged)
  writeFileSync(fpath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
  console.log(`${lang}.json 已合并，总键数 ${flattenKeys(existing).length}`)
}