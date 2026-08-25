/* ============================================================
 * ArkWork — 全文检索引擎抽象（v0.8.0）
 * L3b 档案记忆与知识库共用，避免重复实现。
 * 默认实现 MiniSearch（纯 JS、零原生依赖，避开 better-sqlite3 的
 * electron-rebuild 打包坑）；FTS5 作为备选实现留口——替换本模块
 * 的具体实现即可，调用方接口不变。
 * 设计文档：versions/v0.8.0/01-memory.md §5.1 / 02-knowledge-base.md §4
 * ============================================================ */
import MiniSearch from 'minisearch'

/** 可索引文档：必须有 id，其余字段由调用方约定 */
export interface SearchDoc {
  id: string
  [key: string]: unknown
}

/** 检索命中结果 */
export interface SearchHit {
  id: string
  score: number
  /** 命中字段内容快照（storeFields 配置的字段会带回） */
  fields: Record<string, unknown>
}

export interface SearchEngineOptions {
  /** 建立倒排索引的字段 */
  fields: string[]
  /** 命中时一并返回的字段（用于展示，不参与索引） */
  storeFields: string[]
  /** 字段权重（boost）：值越大命中加权越高 */
  weights?: Record<string, number>
}

/**
 * 全文检索引擎接口。
 * L3b 档案与知识库均依赖此抽象；具体实现可替换（MiniSearch / FTS5）。
 *
 * v0.9.1 §Task 7：toJSON/loadJSON 明确为字符串契约。
 *  MiniSearch 自家的 toJSON() 已返回 JSON 字符串，loadJSON() 接收的是 JSON 字符串；
 *  早期使用 unknown/对象化是契约错误，会出现 "[object Object]" is not valid JSON。
 *  此处现在严格传递字符串，调用方也按字符串存入磁盘。
 */
export interface ArchiveSearchEngine {
  add(doc: SearchDoc): void
  addMany(docs: SearchDoc[]): void
  remove(id: string): void
  search(query: string, limit?: number): SearchHit[]
  size(): number
  /** 索引快照（防抖落盘用）—— JSON 字符串 */
  toJSON(): string
  /** 接受 JSON 字符串（与 toJSON 对称） */
  loadJSON(snapshot: string): void
}

/**
 * MiniSearch 实现 — v0.8.0 默认引擎。
 * 支持前缀匹配 + 模糊匹配（fuzzy 0.2，容错 1-2 字符），字段加权。
 */
export class MiniSearchEngine implements ArchiveSearchEngine {
  private ms: MiniSearch<SearchDoc>
  private opts: SearchEngineOptions
  private count = 0

  constructor(opts: SearchEngineOptions) {
    this.opts = opts
    this.ms = new MiniSearch<SearchDoc>({
      fields: opts.fields,
      storeFields: opts.storeFields,
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: opts.weights,
      },
    })
  }

  add(doc: SearchDoc): void {
    this.ms.add(doc)
    this.count += 1
  }

  addMany(docs: SearchDoc[]): void {
    if (docs.length === 0) return
    this.ms.addAll(docs)
    this.count += docs.length
  }

  remove(id: string): void {
    try {
      this.ms.discard(id)
      this.count = Math.max(0, this.count - 1)
    } catch {
      // 文档不存在则忽略
    }
  }

  search(query: string, limit = 10): SearchHit[] {
    const q = query.trim()
    if (!q) return []
    const results = this.ms.search(q, {
      prefix: true,
      fuzzy: 0.2,
      boost: this.opts.weights,
    })
    return results.slice(0, limit).map((r) => {
      const { id, score, ...fields } = r as Record<string, unknown>
      return {
        id: String(id),
        score: score as number,
        fields,
      }
    })
  }

  size(): number {
    return this.count
  }

  toJSON(): string {
    // v0.9.1 §Task 7：JSON 字符串契约。
    // MiniSearch 运行时 toJSON() 返回 plain object，loadJSON() 用 JSON.parse(json)
    // 处理字符串——二者必须经过 JSON.stringify 转换才能"出"、"入"对得上。
    return JSON.stringify(this.ms.toJSON())
  }

  loadJSON(snapshot: string): void {
    if (typeof snapshot !== 'string' || snapshot.trim() === '') {
      // 防御：旧版本可能错误地把对象化后的字符串塞进来
      throw new Error('MiniSearch 快照必须是 JSON 字符串（toJSON 输出）')
    }
    // 运行时：MiniSearch.loadJSON 内部会 JSON.parse(snapshot) — 所以传入必须为字符串
    this.ms = MiniSearch.loadJSON(snapshot, {
      fields: this.opts.fields,
      storeFields: this.opts.storeFields,
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: this.opts.weights,
      },
    })
    // loadJSON 后无法可靠回填 count，用空查询估算
    // MiniSearch 不暴露 documentCount，这里近似为 0；调用方应在 load 后重建索引或自行计数
    this.count = 0
  }
}
