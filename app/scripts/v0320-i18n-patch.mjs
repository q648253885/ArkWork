#!/usr/bin/env node
/* ============================================================
 * ArkWork — v0.32.0 i18n 键批量注入
 * 用途：一次性把交互区进程折叠（flow.fold / flow.viewmode / flow.turn）与
 *       Workbench Profile（profile.*）的新增键写入四语言 locale。
 * 幂等：已存在的键不覆盖（保护人工校正）。
 * 用法：node scripts/v0320-i18n-patch.mjs [--force]
 * ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = ['zh', 'en', 'ja', 'ko']
const FORCE = process.argv.includes('--force')

/** 嵌套键路径 → 四语言取值：[path, zh, en, ja, ko] */
const PATCH = [
  // ---- 交互区进程折叠：摘要文案（04 §1.4）----
  ['flow.fold.thinking', '思考过程', 'Thinking process', '思考プロセス', '사고 과정'],
  ['flow.fold.tools', '工具调用', 'Tool calls', 'ツール呼び出し', '도구 호출'],
  ['flow.fold.running', '进行中', 'Running', '実行中', '진행 중'],
  ['flow.fold.sep', '，', ', ', '、', ', '],
  ['flow.fold.read', '已读取 {{n}} 个文件', 'Read {{n}} file(s)', '{{n}} 件のファイルを読み取り', '{{n}}개 파일 읽음'],
  ['flow.fold.edit', '已修改 {{n}} 个文件', 'Edited {{n}} file(s)', '{{n}} 件のファイルを編集', '{{n}}개 파일 수정'],
  ['flow.fold.delete', '已删除 {{n}} 个文件', 'Deleted {{n}} file(s)', '{{n}} 件のファイルを削除', '{{n}}개 파일 삭제'],
  ['flow.fold.move', '已移动 {{n}} 个文件', 'Moved {{n}} file(s)', '{{n}} 件のファイルを移動', '{{n}}개 파일 이동'],
  ['flow.fold.search', '搜索 {{n}} 次', 'Searched {{n}} time(s)', '{{n}} 回検索', '{{n}}회 검색'],
  ['flow.fold.execute', '执行 {{n}} 条命令', 'Ran {{n}} command(s)', '{{n}} 件のコマンドを実行', '{{n}}개 명령 실행'],
  ['flow.fold.fetch', '检索 {{n}} 个来源', 'Fetched {{n}} source(s)', '{{n}} 件のソースを取得', '{{n}}개 출처 조회'],
  ['flow.fold.other', '调用 {{n}} 次其他工具', 'Called {{n}} other tool(s)', 'その他のツールを {{n}} 回呼び出し', '기타 도구 {{n}}회 호출'],
  ['flow.fold.expandAria', '展开{{name}}', 'Expand {{name}}', '{{name}}を展開', '{{name}} 펼치기'],
  ['flow.fold.collapseAria', '收起{{name}}', 'Collapse {{name}}', '{{name}}を折りたたむ', '{{name}} 접기'],
  // ---- 视图模式三档（v0.31.0 空壳 → 本版接线）----
  ['flow.viewmode.compact', '紧凑', 'Compact', 'コンパクト', '컴팩트'],
  ['flow.viewmode.standard', '标准', 'Standard', '標準', '표준'],
  ['flow.viewmode.verbose', '详尽', 'Verbose', '詳細', '상세'],
  // ---- 轮头 / 轮尾（硬编码中文 → i18n）----
  ['flow.turn.status.running', '运行中', 'Running', '実行中', '실행 중'],
  ['flow.turn.status.done', '已完成', 'Done', '完了', '완료'],
  ['flow.turn.status.failed', '失败', 'Failed', '失敗', '실패'],
  ['flow.turn.status.paused', '已暂停', 'Paused', '一時停止', '일시정지'],
  ['flow.turn.status.cancelled', '已取消', 'Cancelled', 'キャンセル', '취소'],
  ['flow.turn.toolsCount', '{{n}} 次工具', '{{n}} tool calls', 'ツール {{n}} 回', '도구 {{n}}회'],
  ['flow.turn.collapse', '收起本轮', 'Collapse turn', 'このターンを折りたたむ', '이 턴 접기'],
  ['flow.turn.expand', '展开本轮', 'Expand turn', 'このターンを展開', '이 턴 펼치기'],

  // ---- Workbench Profile（插件模式，03-interaction §四）----
  ['profile.switcher.aria', '切换工作台（{{kbd}}）', 'Switch workbench ({{kbd}})', 'ワークベンチを切り替え（{{kbd}}）', '워크벤치 전환({{kbd}})'],
  ['profile.menu.import', '导入 Profile…', 'Import profile…', 'Profile をインポート…', 'Profile 가져오기…'],
  ['profile.menu.snapshot', '查看装配快照', 'View composition snapshot', '構成スナップショットを表示', '구성 스냅샷 보기'],
  ['profile.menu.manage', '管理 Profile…', 'Manage profiles…', 'Profile を管理…', 'Profile 관리…'],
  ['profile.menu.empty', '没有可用的工作台', 'No workbench available', '利用可能なワークベンチがありません', '사용 가능한 워크벤치 없음'],
  ['profile.namespace', '记忆命名空间', 'Memory namespace', 'メモリ名前空間', '메모리 네임스페이스'],
  ['profile.source.builtin', '内置', 'Built-in', '組み込み', '내장'],
  ['profile.source.user', '用户', 'User', 'ユーザー', '사용자'],
  ['profile.toast.switched', '已切换到 {{name}}', 'Switched to {{name}}', '{{name}} に切り替えました', '{{name}}(으)로 전환됨'],
  ['profile.toast.failed', '切换失败：{{reason}}', 'Switch failed: {{reason}}', '切り替えに失敗：{{reason}}', '전환 실패: {{reason}}'],
  ['profile.report.title', '激活报告', 'Activation report', 'アクティベーション レポート', '활성화 보고서'],
  ['profile.report.ok', '已激活 {{name}}（{{id}} v{{version}}）· {{ms}}ms', 'Activated {{name}} ({{id}} v{{version}}) · {{ms}}ms', '{{name}}（{{id}} v{{version}}）を有効化 · {{ms}}ms', '{{name}}({{id}} v{{version}}) 활성화 · {{ms}}ms'],
  ['profile.report.failed', '激活失败', 'Activation failed', 'アクティベーションに失敗', '활성화 실패'],
  ['profile.report.stillActive', '当前仍生效：{{name}}', 'Still active: {{name}}', '現在も有効：{{name}}', '현재 적용 중: {{name}}'],
  ['profile.report.layers', '五层装配', 'Composition layers', '5 層の構成', '5개 계층 구성'],
  ['profile.report.layer.agents', '智能体', 'Agents', 'エージェント', '에이전트'],
  ['profile.report.layer.tools', '工具与技能', 'Tools & skills', 'ツールとスキル', '도구 및 스킬'],
  ['profile.report.layer.ui', '界面', 'UI', 'UI', 'UI'],
  ['profile.report.layer.data', '数据', 'Data', 'データ', '데이터'],
  ['profile.report.layer.auto', '自动化', 'Automation', '自動化', '자동화'],
  ['profile.report.degraded', '降级与警告', 'Degradations & warnings', '縮退と警告', '성능 저하 및 경고'],
  ['profile.report.issues', '校验问题', 'Validation issues', '検証の問題', '검증 문제'],
  ['profile.report.none', '无', 'None', 'なし', '없음'],
  ['profile.report.close', '关闭', 'Close', '閉じる', '닫기'],
  ['profile.report.snapshot', '装配快照', 'Composition snapshot', '構成スナップショット', '구성 스냅샷'],
  ['profile.report.resolvedAt', '解析于 {{time}}', 'Resolved at {{time}}', '{{time}} に解決', '{{time}}에 해석됨'],
  ['profile.import.title', '导入 Profile', 'Import profile', 'Profile のインポート', 'Profile 가져오기'],
  ['profile.import.hint', '粘贴 workbench.json 内容', 'Paste workbench.json content', 'workbench.json の内容を貼り付け', 'workbench.json 내용 붙여넣기'],
  ['profile.import.valid', '校验通过，已导入', 'Validation passed, imported', '検証に合格し、インポートしました', '검증 통과, 가져왔습니다'],
  ['profile.import.invalid', '校验失败，未导入', 'Validation failed, not imported', '検証に失敗、インポートされませんでした', '검증 실패, 가져오지 않음'],
  ['profile.import.parseError', '不是合法的 JSON', 'Not valid JSON', '有効な JSON ではありません', '유효한 JSON이 아닙니다'],
  ['profile.import.submit', '导入', 'Import', 'インポート', '가져오기'],
  ['profile.import.cancel', '取消', 'Cancel', 'キャンセル', '취소'],
  ['profile.delete', '删除', 'Delete', '削除', '삭제'],
  ['profile.delete.builtinDenied', '内置工作台不可删除', 'Built-in workbench cannot be deleted', '組み込みワークベンチは削除できません', '내장 워크벤치는 삭제할 수 없습니다'],
  ['profile.delete.activeDenied', '当前生效的工作台不可删除', 'Active workbench cannot be deleted', '現在有効なワークベンチは削除できません', '현재 활성 워크벤치는 삭제할 수 없습니다'],
  ['profile.ns.shared', '跨工作台共享', 'Shared across workbenches', 'ワークベンチ間で共有', '워크벤치 간 공유'],
  ['profile.agentsCount', '{{n}} 个智能体', '{{n}} agent(s)', 'エージェント {{n}} 個', '에이전트 {{n}}개'],
  ['keybind.switchProfile', '切换工作台', 'Switch workbench', 'ワークベンチを切り替え', '워크벤치 전환'],
]

/** 写入嵌套键（不覆盖已存在，除非 --force） */
function setPath(obj, path, value) {
  const segs = path.split('.')
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {}
    cur = cur[k]
  }
  const last = segs[segs.length - 1]
  if (cur[last] !== undefined && !FORCE) return false
  cur[last] = value
  return true
}

let totalAdd = 0
for (let li = 0; li < LOCALES.length; li++) {
  const loc = LOCALES[li]
  const file = join(ROOT, 'src/renderer/i18n/locales', `${loc}.json`)
  const json = JSON.parse(readFileSync(file, 'utf-8'))
  let add = 0
  for (const row of PATCH) {
    const value = row[li + 1]
    if (setPath(json, row[0], value)) add++
  }
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf-8')
  console.log(`${loc}: +${add} keys (合计叶子 ${countLeaves(json)})`)
  totalAdd += add
}
console.log(`done. 共新增 ${totalAdd} 条键值（4 语言 × ${PATCH.length} 键 = ${PATCH.length * 4}）`)

function countLeaves(o) {
  let n = 0
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) n += countLeaves(v)
    else n++
  }
  return n
}
