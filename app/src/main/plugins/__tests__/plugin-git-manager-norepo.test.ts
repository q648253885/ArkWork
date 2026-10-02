/* ============================================================
 * ArkWork — Git 面板「非仓库空态」用例（v0.45.0 · R-G · TC-GITP3）
 *
 * 用户实机反馈：非 git 仓库时面板直出红字 `git status 失败：fatal: not a
 * git repository (or any of the parent directories): .git` —— 看不懂、
 * 样式难看、没有出路。本套件钉住：
 *  ① errSpeak 真值表（stderr → 一句人话，未命中透传 —— 抽纯函数区真跑，
 *     与 TC-GITP2 同一可测性接缝，纪律⑫：断言语义不是源码 grep）；
 *  ② isNotRepoError 判定（驱动 body.norepo 空态切换）；
 *  ③ 空态结构守卫：#norepo 卡 + 初始化按钮 + 操作面隐藏 CSS + 事件绑定。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-git-manager-norepo
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { filesOf } from '../sample-plugins.js'
import { stripComments } from '@shared/utils/source-guard'

const GIT_ID = 'ark.plugin.git-manager'
const PURE_START = '/* @@ARKWORK-PURE:START@@ */'
const PURE_END = '/* @@ARKWORK-PURE:END@@ */'

function panelPure(): {
  errSpeak: (m: unknown) => string
  isNotRepoError: (m: unknown) => boolean
} {
  const html = filesOf(GIT_ID)!['panel.html']!
  const a = html.indexOf(PURE_START)
  const b = html.indexOf(PURE_END)
  assert.ok(a >= 0 && b > a, '纯函数区标记必须在（可测性接缝）')
  return new Function(
    `${html.slice(a + PURE_START.length, b)}\nreturn { errSpeak: errSpeak, isNotRepoError: isNotRepoError }`,
  )()
}

test('TC-GITP3-001 ★ errSpeak 真值表：常见 stderr → 一句人话', () => {
  const { errSpeak } = panelPure()
  assert.equal(errSpeak('git status 失败：fatal: not a git repository (or any of the parent directories): .git'), '当前工作区不是 Git 仓库')
  assert.equal(errSpeak('nothing to commit, working tree clean'), '没有可提交的内容')
  assert.equal(errSpeak("fatal: The current branch main has no upstream branch.\nhint: ..."), '当前分支还没有关联远程分支，无法拉取 / 推送')
  assert.equal(errSpeak('! [rejected]        main -> main (fetch first)'), '推送被拒绝：远程有新提交，请先拉取再推送')
  assert.equal(errSpeak('error: failed to push some refs to github.com/x/y.git'), '推送被拒绝：远程有新提交，请先拉取再推送')
  assert.equal(errSpeak('fatal: refusing to merge unrelated histories: non-fast-forward'), '推送被拒绝：本地与远程历史不一致，请先拉取')
  assert.equal(errSpeak('fatal: unable to access: Could not resolve host: github.com'), '网络不通：无法连接远程仓库')
  assert.equal(errSpeak('git@github.com: Permission denied (publickey).'), '认证失败：请检查远程仓库的访问权限 / 凭据')
})

test('TC-GITP3-002 errSpeak 兜底：未知错误透传原文（诚实优先，不编造）', () => {
  const { errSpeak } = panelPure()
  const weird = 'fatal: some unknown failure with 中文与符号 !@#'
  assert.equal(errSpeak(weird), weird)
  assert.equal(errSpeak(''), '')
  assert.equal(errSpeak(null), '')
})

test('TC-GITP3-003 ★ isNotRepoError：只认 not a git repository（空态唯一判据）', () => {
  const { isNotRepoError } = panelPure()
  assert.equal(isNotRepoError('git status 失败：fatal: not a git repository (or any of the parent directories): .git'), true)
  assert.equal(isNotRepoError('NOT A GIT REPOSITORY'), true, '大小写不敏感')
  assert.equal(isNotRepoError('fatal: unable to access'), false)
  assert.equal(isNotRepoError(''), false)
  assert.equal(isNotRepoError(null), false)
})

test('TC-GITP3-004 空态结构守卫：#norepo 卡 + 初始化按钮 + body.norepo 隐藏操作面 + 事件绑定', () => {
  const html = stripComments(filesOf(GIT_ID)!['panel.html']!)
  // 空态卡与按钮
  assert.match(html, /id="norepo"/, '空态卡必须在')
  assert.match(html, /id="btn-norepo-init"/, '初始化仓库按钮必须在')
  assert.match(html, /当前工作区不是 Git 仓库/, '空态标题人话（D111：不直出命令行原文）')
  // body.norepo 时操作面全部隐藏（拉取/推送/tabs/三个 tab 内容/错误条）
  assert.match(html, /body\.norepo \.bar button/)
  assert.match(html, /body\.norepo \.tabs/)
  assert.match(html, /body\.norepo #tab-changes/)
  assert.match(html, /body\.norepo #tab-history/)
  assert.match(html, /body\.norepo #tab-branches/)
  // 事件绑定与 busy 集成
  assert.match(html, /btn-norepo-init'\)\.addEventListener\('click', initRepo/, '空态按钮必须绑 initRepo')
  assert.match(html, /initRepo/, 'initRepo 函数必须在')
  assert.match(html, /'btn-commit', 'btn-refresh', 'btn-push', 'btn-pull', 'btn-branch-create', 'btn-norepo-init'/, 'busy 清单必须含空态按钮（防并发点击）')
  // 错误条结构（人话 + 原文折叠）
  assert.match(html, /id="err-text"/, '错误条必须有人话槽')
  assert.match(html, /id="err-raw"/, '错误条必须有原文折叠槽（details）')
  assert.match(html, /function showErr\(e\)/, '')
})
