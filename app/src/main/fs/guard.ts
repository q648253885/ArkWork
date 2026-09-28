/* ============================================================
 * ArkWork — Main: FS Guard（路径边界 + 只读七原因）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.1 / §4.3.1 / §5.2 / §7.2
 *
 * 本模块是**全仓库唯一的路径边界实现**（TC-GUARD-001）：
 *  `assertInWorkspace` 原为 ipc/fs.ts:20 的局部函数，v0.31.0 提升到这里。
 *  任何新增写类频道都必须先过本模块，**不得另写一份 startsWith 判定**
 *  （多份实现并存 → 漏一处即越界写，是 §7.2 明令禁止的形态）。
 *
 * 设计取舍：
 *  - 纯函数核心（isInsideRoot / pickReadonlyReason）与 IO 外壳分离，
 *    使 TC-GUARD-002/003/005 可密闭断言（node:test + 真实临时目录）。
 *  - symlink 逃逸必须 `realpath` 后再比对（TC-GUARD-003）；因此
 *    `assertInWorkspace` 是 **async**（旧实现是 sync，调用点是 async handler，无损）。
 * ============================================================ */
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { getWorkspaceDir } from '../store/db.js'
import { getUiLocale, tFor } from '../i18n/messages.js'
import { FsError } from '@shared/utils/fs-error'
import { ARKWORK_DIRNAME } from '@shared/utils/paths'
import type { ReadonlyReason } from '@shared/types/fs'

/**
 * agent 自身内容区（用户文件树与编辑器写入一律拒绝）。
 * **自 v0.31.0 B2 起定义在 `@shared/utils/paths`** —— renderer 也需要拦 `.arkwork`
 * （否则 `.arkwork` 下产物会探成「可编辑」，用户在编辑器里改一个存不下去的文件），
 * 常量只保留一处定义，此处转出以维持既有导入点（`guard.test.ts`）。
 */
export { ARKWORK_DIRNAME }

/**
 * 只读原因判定顺序（§4.3.1）：先硬后软、先永久后临时。
 * 顺序**有意为之**：一个「越界的 GBK 二进制超大只读文件」应该报越界，
 * 而不是报 non-utf8 —— 因为越界是用户无法通过转码解决的问题。
 */
export const READONLY_PRECEDENCE: readonly ReadonlyReason[] = [
  'deleted',
  'outside-workspace',
  'binary',
  'too-large',
  'permission',
  'agent-writing',
  'non-utf8',
] as const

/**
 * 纯函数：路径归一化后判定 target 是否落在 root 之内（含 root 自身）。
 * 注意 `resolve` 已消化 `..` / `.` / 重复分隔符，因此 `root/a/../../etc` 会被判越界。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r) return true
  return t.startsWith(r + sep)
}

/**
 * 纯函数：从候选只读原因中按 READONLY_PRECEDENCE 取优先级最高者。
 * 全部为 null / 空数组 → null（可编辑）。
 */
export function pickReadonlyReason(
  candidates: ReadonlyArray<ReadonlyReason | null | undefined>,
): ReadonlyReason | null {
  for (const reason of READONLY_PRECEDENCE) {
    if (candidates.includes(reason)) return reason
  }
  return null
}

/** 纯函数：工作区相对路径；越界时返回 null（不抛，供只读卡片展示用） */
export function relativeToRoot(root: string, target: string): string | null {
  if (!isInsideRoot(root, target)) return null
  const r = resolve(root)
  const t = resolve(target)
  if (t === r) return ''
  return t.slice(r.length + 1)
}

/** 纯函数：是否位于 `.arkwork` 内容区（工作区相对路径首段判定） */
export function isInArkworkArea(root: string, target: string): boolean {
  const rel = relativeToRoot(root, target)
  if (rel === null) return false
  const first = rel.split(sep)[0]
  return first === ARKWORK_DIRNAME
}

/** `realpath` 容错版：路径不存在时逐级上溯到最近存在的祖先，再拼回剩余段 */
async function realpathOfNearestExisting(absPath: string): Promise<string> {
  let current = resolve(absPath)
  const tail: string[] = []
  // 最多上溯 64 级，防御异常深路径造成的死循环
  for (let i = 0; i < 64; i++) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) return resolve(absPath)
      tail.push(current.slice(parent.length + 1))
      current = parent
    }
  }
  return resolve(absPath)
}

/**
 * 用户面路径归一化（**唯一实现**）。
 *
 * 为什么需要（v0.36.3 · D115）：交互区里的文件路径来自工具卡 / 搜索结果，是
 * **工作区相对路径**（如 `src/main/java/...`）。而 `resolve(p)` 对相对路径按
 * **主进程 `process.cwd()`** 解析 ⇒ 明明在工作区内也被判越界，用户点谁都打不开。
 * 归一化后：相对路径以**工作区根**为基准，绝对路径原样 —— 与用户心智一致。
 *
 * @param absOrRel 绝对或工作区相对路径
 * @param root 工作区根（缺省取当前工作区）
 * @returns 归一化后的绝对路径（**不判越界**，越界判定见 `assertInWorkspace`）
 */
export function resolveUserPath(absOrRel: string, root: string = getWorkspaceDir()): string {
  return isAbsolute(absOrRel) ? resolve(absOrRel) : resolve(root, absOrRel)
}

/**
 * 用户面只读判定：realpath 归一化后给出「是否在工作区内」，**不抛越界错**。
 *
 * 口径（用户裁决）：交互区点击的文件「存在即可读」，越界只约束 LLM 工具面。
 * 工作区外**不是拒绝**，而是「只读原因 = outside-workspace」（编辑器标只读、写盘被拒）。
 */
export async function probeReadablePath(
  absOrRel: string,
  root: string = getWorkspaceDir(),
): Promise<{ absPath: string; insideWorkspace: boolean }> {
  const ws = resolve(root)
  const target = resolveUserPath(absOrRel, ws)
  const realWs = await realpathOfNearestExisting(ws)
  const realTarget = await realpathOfNearestExisting(target)
  return { absPath: target, insideWorkspace: isInsideRoot(realWs, realTarget) }
}

/**
 * 路径边界断言：仅允许工作区内的路径。
 *
 * 两道检查：
 *  ① 字面归一化（`resolveUserPath` 后 startsWith）—— 挡住 `../` 逃逸，
 *     且**相对路径以工作区根为基准**（D115，否则交互区相对路径恒判越界）；
 *  ② `realpath` 后比对 —— 挡住 **symlink 逃逸**（TC-GUARD-003）。
 *     写新文件时目标尚不存在，故对「最近存在的祖先」做 realpath 再拼回。
 *
 * @returns 归一化后的绝对路径（调用方应使用返回值，而非原始入参）
 */
export async function assertInWorkspace(
  absPath: string,
  root: string = getWorkspaceDir(),
): Promise<string> {
  const ws = resolve(root)
  const target = resolveUserPath(absPath, ws)
  if (!isInsideRoot(ws, target)) {
    throw new FsError(
      'E_PATH_OUTSIDE_WORKSPACE',
      tFor(getUiLocale(), 'fs.pathOutsideWorkspace', { path: absPath }),
      { path: absPath, root: ws },
    )
  }
  const realWs = await realpathOfNearestExisting(ws)
  const realTarget = await realpathOfNearestExisting(target)
  if (!isInsideRoot(realWs, realTarget)) {
    throw new FsError(
      'E_PATH_OUTSIDE_WORKSPACE',
      tFor(getUiLocale(), 'fs.pathOutsideWorkspace', { path: absPath }),
      { path: absPath, root: realWs, realTarget },
    )
  }
  return target
}

/**
 * `.arkwork` 内容区保留断言（TC-GUARD-004）。
 * 沿用 `artifacts.ts:validateArtifactPath` 的纪律：agent 自身内容区不接受用户文件写入。
 * 注意：**agent 任务文件写入（fs:write-task-file）不走这里** —— 那是 agent 内核自己的域。
 */
export function assertNotInArkwork(absPath: string, root: string = getWorkspaceDir()): void {
  if (isInArkworkArea(root, absPath)) {
    throw new FsError(
      'E_ARKWORK_RESERVED',
      tFor(getUiLocale(), 'fs.arkworkReserved', { path: absPath }),
      { path: absPath, root },
    )
  }
}

/** 写类频道的统一入口：边界 + 保留区两道断言 */
export async function assertWritableTarget(
  absPath: string,
  root: string = getWorkspaceDir(),
): Promise<string> {
  const target = await assertInWorkspace(absPath, root)
  assertNotInArkwork(target, root)
  return target
}

/** 错误码 → 只读原因映射（渲染层只读卡片用；§5.2 错误码表） */
export function reasonFromErrorCode(code: string): ReadonlyReason | null {
  if (code === 'E_PATH_OUTSIDE_WORKSPACE') return 'outside-workspace'
  if (code === 'E_NOT_FOUND') return 'deleted'
  return null
}
