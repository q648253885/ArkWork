/* ============================================================
 * ArkWork — 统一 Node ESM loader（v0.27.0 R0 单份真源）
 * 合并自原 store/__tests__ 与 fault-tolerance/__tests__ 两份漂移副本。
 *
 * 职责：
 *  1. 'electron' → src/test/electron-stub.mjs
 *  2. 各处 system/logger 导入 → src/test/logger.stub.mjs
 *  3. '@shared/*' 别名解析（与 tsconfig.paths 一致）
 *
 * 对不涉及以上三类的模块零副作用——因此所有套件可以统一挂本 loader
 * 运行，不再需要区分「哪些测试要带 loader」。
 *
 * 使用方式：
 *   cd app
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test <files...>
 * ============================================================ */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'
import { existsSync } from 'node:fs'

const hereUrl = import.meta.url
const ELECTRON_STUB_URL = new URL('./electron-stub.mjs', hereUrl).href
const LOGGER_STUB_URL = new URL('./logger.stub.mjs', hereUrl).href

// 从本 loader 所在目录上溯到 app/ 根（src/test → app/）
const HERE_DIR = dirname(fileURLToPath(hereUrl))
const APP_ROOT = pathResolve(HERE_DIR, '../')

const CANDIDATE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/** 尝试将无扩展名模块路径解析为实际文件（优先精确文件，再试 index） */
function resolveAliasFile(base) {
  if (existsSync(base)) return base
  for (const ext of CANDIDATE_EXT) {
    if (existsSync(base + ext)) return base + ext
  }
  for (const ext of CANDIDATE_EXT) {
    if (existsSync(pathResolve(base, 'index' + ext))) return pathResolve(base, 'index' + ext)
  }
  return null
}

/** @type {import('node:module').resolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron' || specifier.startsWith('electron/')) {
    return { url: ELECTRON_STUB_URL, shortCircuit: true, format: 'module' }
  }
  if (
    specifier.endsWith('/system/logger.js') ||
    specifier.endsWith('/system/logger.ts') ||
    specifier.endsWith('/system/logger') ||
    specifier === '../system/logger.js' ||
    specifier === '../system/logger'
  ) {
    return { url: LOGGER_STUB_URL, shortCircuit: true, format: 'module' }
  }
  if (specifier.startsWith('@shared/')) {
    const rel = specifier.slice('@shared/'.length)
    const target = resolveAliasFile(pathResolve(APP_ROOT, 'src/shared', rel))
    if (target) {
      return {
        url: pathToFileURL(target).href,
        shortCircuit: true,
        format: 'module',
      }
    }
  }
  return nextResolve(specifier, context)
}

// 防止 pathToFileURL 未使用警告
void pathToFileURL
