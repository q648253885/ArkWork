/* ============================================================
 * v0.32.0 i18n 注入脚本（四语言 parity）
 *
 * 为什么用脚本而不是手改：四个 locale 文件的键必须**完全同源**，
 * 手改极易漏一门语言（既有 CI 有 parity 校验，漏了会红）。脚本一次
 * 性注入顶层 `profile` 段，并对已有键做存在性检查（已存在则跳过）。
 *
 * 用法：node scripts/v0320-i18n-profile.mjs
 * ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(root, 'src/renderer/i18n/locales')

const STRINGS = {
  zh: {
    'profile.switcher.label': '切换工作台',
    'profile.switcher.desc': '工作台是一组能力的装配：切换后 Dock 面板、首页模块、记忆域与快捷指令整体改变',
    'profile.switcher.cap': '当前：{{name}}',
    'profile.switcher.aria': '切换工作台',
    'profile.switcher.unknown': '未知工作台',
    'profile.list.empty': '暂无可用工作台',
    'profile.source.builtin': '内置',
    'profile.meta.line': '记忆域 {{namespace}} · {{agents}} 个智能体 · {{caps}} 项能力',
    'profile.homeModule.open': '打开本工作台的首页模块',
    'profile.reject.hint': '上次切换到 {{id}} 未成功，点击查看原因',
    'profile.degraded.count': '{{count}} 项能力未生效',
    'profile.degraded.blockingCount': '{{count}} 项必需能力缺失',
    'profile.degraded.layer.agents': '智能体',
    'profile.degraded.layer.tools': '工具',
    'profile.degraded.layer.ui': '界面',
    'profile.degraded.layer.data': '数据',
    'profile.degraded.layer.auto': '定时任务',
    'profile.degraded.layer.unknown': '未知',
  },
  en: {
    'profile.switcher.label': 'Switch workbench',
    'profile.switcher.desc': 'A workbench is a composition of capabilities — switching changes Dock panels, home module, memory namespace and quick prompts together',
    'profile.switcher.cap': 'Current: {{name}}',
    'profile.switcher.aria': 'Switch workbench',
    'profile.switcher.unknown': 'Unknown workbench',
    'profile.list.empty': 'No workbench available',
    'profile.source.builtin': 'Built-in',
    'profile.meta.line': 'Memory {{namespace}} · {{agents}} agents · {{caps}} capabilities',
    'profile.homeModule.open': 'Open this workbench home module',
    'profile.reject.hint': 'Last switch to {{id}} failed — click to see why',
    'profile.degraded.count': '{{count}} capabilities not active',
    'profile.degraded.blockingCount': '{{count}} required capabilities missing',
    'profile.degraded.layer.agents': 'Agents',
    'profile.degraded.layer.tools': 'Tools',
    'profile.degraded.layer.ui': 'UI',
    'profile.degraded.layer.data': 'Data',
    'profile.degraded.layer.auto': 'Automation',
    'profile.degraded.layer.unknown': 'Unknown',
  },
  ja: {
    'profile.switcher.label': 'ワークベンチを切り替え',
    'profile.switcher.desc': 'ワークベンチは能力の構成です。切り替えると Dock パネル・ホームモジュール・記憶領域・ショート入力がまとめて変わります',
    'profile.switcher.cap': '現在：{{name}}',
    'profile.switcher.aria': 'ワークベンチを切り替え',
    'profile.switcher.unknown': '不明なワークベンチ',
    'profile.list.empty': '利用可能なワークベンチがありません',
    'profile.source.builtin': '内蔵',
    'profile.meta.line': '記憶領域 {{namespace}} · エージェント {{agents}} · 能力 {{caps}}',
    'profile.homeModule.open': 'このワークベンチのホームを開く',
    'profile.reject.hint': '前回の {{id}} への切り替えは失敗しました。クリックして理由を表示',
    'profile.degraded.count': '{{count}} 件の能力が未適用',
    'profile.degraded.blockingCount': '{{count}} 件の必須能力が不足',
    'profile.degraded.layer.agents': 'エージェント',
    'profile.degraded.layer.tools': 'ツール',
    'profile.degraded.layer.ui': 'UI',
    'profile.degraded.layer.data': 'データ',
    'profile.degraded.layer.auto': '自動実行',
    'profile.degraded.layer.unknown': '不明',
  },
  ko: {
    'profile.switcher.label': '워크벤치 전환',
    'profile.switcher.desc': '워크벤치는 능력의 조합입니다. 전환하면 Dock 패널·홈 모듈·메모리 네임스페이스·바로가기 프롬프트가 함께 바뀝니다',
    'profile.switcher.cap': '현재: {{name}}',
    'profile.switcher.aria': '워크벤치 전환',
    'profile.switcher.unknown': '알 수 없는 워크벤치',
    'profile.list.empty': '사용 가능한 워크벤치가 없습니다',
    'profile.source.builtin': '기본 제공',
    'profile.meta.line': '메모리 {{namespace}} · 에이전트 {{agents}} · 능력 {{caps}}',
    'profile.homeModule.open': '이 워크벤치의 홈 모듈 열기',
    'profile.reject.hint': '지난번 {{id}} 전환이 실패했습니다. 클릭해 이유를 확인하세요',
    'profile.degraded.count': '{{count}}개 능력이 적용되지 않음',
    'profile.degraded.blockingCount': '{{count}}개 필수 능력 누락',
    'profile.degraded.layer.agents': '에이전트',
    'profile.degraded.layer.tools': '도구',
    'profile.degraded.layer.ui': 'UI',
    'profile.degraded.layer.data': '데이터',
    'profile.degraded.layer.auto': '자동화',
    'profile.degraded.layer.unknown': '알 수 없음',
  },
}

/** 按点号路径写入嵌套对象 */
function setPath(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}

for (const [locale, strings] of Object.entries(STRINGS)) {
  const file = join(DIR, `${locale}.json`)
  const json = JSON.parse(readFileSync(file, 'utf-8'))
  let added = 0
  let skipped = 0
  for (const [key, value] of Object.entries(strings)) {
    // 已存在则跳过（脚本可安全重跑）
    const parts = key.split('.')
    let cur = json
    let exists = true
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
      else {
        exists = false
        break
      }
    }
    if (exists) {
      skipped++
      continue
    }
    setPath(json, key, value)
    added++
  }
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf-8')
  console.log(`${locale}: +${added} / skip ${skipped}`)
}
console.log('done')
