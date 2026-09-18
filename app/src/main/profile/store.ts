/* ============================================================
 * ArkWork — Workbench Profile 持久化（v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.9
 *
 * 存储：`{userData}/arkwork-data/profiles.json`（单文件 JSON 对象）
 *   {
 *     schemaVersion: '1.0',
 *     activeProfileId: 'wb.base',
 *     userProfiles: WorkbenchProfile[],       // 用户导入（含本地改内置的同 id 覆盖）
 *     lastSnapshot?: CompositionSnapshot,     // 上次装配快照（可追溯 / 可 diff）
 *     updatedAt: number
 *   }
 *
 * 复用既有 `JsonDoc`（`store/db.ts:151`，原子写 tmp+rename），**不新建存储原语**。
 * 读取损坏 → 回退默认并 warn（继承 `readJson` 的 fallback 语义），
 * 绝不因 profile 数据损坏导致应用起不来。
 * ============================================================ */
import { join } from 'node:path'
import { getArkworkDir, JsonDoc } from '../store/db.js'
import { logger } from '../system/logger.js'
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID } from './builtins.js'
import { parseManifest } from '@shared/utils/profile-manifest'
import { PROFILE_SCHEMA_VERSION, type CompositionSnapshot, type WorkbenchProfile } from '@shared/types/profile'

export interface ProfilesDoc {
  schemaVersion: string
  activeProfileId: string
  userProfiles: WorkbenchProfile[]
  lastSnapshot?: CompositionSnapshot
  updatedAt: number
}

const FALLBACK: ProfilesDoc = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  activeProfileId: DEFAULT_PROFILE_ID,
  userProfiles: [],
  updatedAt: 0,
}

let doc: JsonDoc<ProfilesDoc> | null = null
/** 内存态：避免每次读盘（激活是热路径） */
let cached: ProfilesDoc | null = null

function docRef(): JsonDoc<ProfilesDoc> {
  if (!doc) doc = new JsonDoc<ProfilesDoc>(join(getArkworkDir(), 'profiles.json'), FALLBACK)
  return doc
}

/** 读（带内存缓存）。userProfiles 逐项过 parseManifest —— 磁盘数据可能被手改坏 */
export async function readProfilesDoc(): Promise<ProfilesDoc> {
  if (cached) return cached
  const raw = await docRef().read()
  const userProfiles: WorkbenchProfile[] = []
  if (Array.isArray(raw.userProfiles)) {
    for (const item of raw.userProfiles) {
      const { profile, issues } = parseManifest(item, 'user')
      if (profile) userProfiles.push(profile)
      else {
        logger.warn(
          'System',
          `[profile] 跳过非法的用户 manifest（${issues.map((i) => i.path).join(',')}）`,
        )
      }
    }
  }
  cached = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    activeProfileId:
      typeof raw.activeProfileId === 'string' && raw.activeProfileId
        ? raw.activeProfileId
        : DEFAULT_PROFILE_ID,
    userProfiles,
    lastSnapshot: raw.lastSnapshot,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
  return cached
}

async function persist(next: ProfilesDoc): Promise<void> {
  cached = { ...next, updatedAt: Date.now() }
  await docRef().write(cached)
}

/** 全部可解析的 profile（内置 ∪ 用户；同 id 时用户覆盖内置，便于本地改内置台） */
export async function listProfiles(): Promise<WorkbenchProfile[]> {
  const d = await readProfilesDoc()
  const userIds = new Set(d.userProfiles.map((p) => p.id))
  return [...BUILTIN_PROFILES.filter((b) => !userIds.has(b.id)), ...d.userProfiles]
}

/** 单查（用户优先） */
export async function getProfile(id: string): Promise<WorkbenchProfile | null> {
  const all = await listProfiles()
  return all.find((p) => p.id === id) ?? null
}

export async function getActiveProfileId(): Promise<string> {
  const d = await readProfilesDoc()
  // 引用的 profile 已被删除 → 回落默认（绝不进入「activeProfileId 指向不存在」的死态）
  const all = await listProfiles()
  if (!all.some((p) => p.id === d.activeProfileId)) return DEFAULT_PROFILE_ID
  return d.activeProfileId
}

export async function getActiveProfile(): Promise<WorkbenchProfile | null> {
  return getProfile(await getActiveProfileId())
}

export async function setActiveProfileId(id: string, snapshot?: CompositionSnapshot): Promise<void> {
  const d = await readProfilesDoc()
  await persist({ ...d, activeProfileId: id, lastSnapshot: snapshot ?? d.lastSnapshot })
}

export async function saveLastSnapshot(snapshot: CompositionSnapshot): Promise<void> {
  const d = await readProfilesDoc()
  await persist({ ...d, lastSnapshot: snapshot })
}

export async function getLastSnapshot(): Promise<CompositionSnapshot | null> {
  return (await readProfilesDoc()).lastSnapshot ?? null
}

/** 落盘一个用户 profile（同 id 覆盖） */
export async function upsertUserProfile(profile: WorkbenchProfile): Promise<void> {
  const d = await readProfilesDoc()
  const rest = d.userProfiles.filter((p) => p.id !== profile.id)
  await persist({ ...d, userProfiles: [...rest, { ...profile, source: 'user' }] })
}

/** 删除用户 profile（内置不可删、生效中不可删） */
export async function deleteUserProfile(
  id: string,
): Promise<{ ok: boolean; reason?: 'builtin' | 'active' }> {
  const d = await readProfilesDoc()
  if (BUILTIN_PROFILES.some((b) => b.id === id)) return { ok: false, reason: 'builtin' }
  if (d.activeProfileId === id) return { ok: false, reason: 'active' }
  await persist({ ...d, userProfiles: d.userProfiles.filter((p) => p.id !== id) })
  return { ok: true }
}

/** 测试与工作区切换用：清内存缓存（下次读盘） */
export function invalidateProfilesCache(): void {
  cached = null
  doc = null
}
