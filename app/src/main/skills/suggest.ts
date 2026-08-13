/* ============================================================
 * ArkWork — Skill Suggestion (v0.15.0)
 * 基于 workspace 特征推荐技能
 * ============================================================ */
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import type { SkillMetadata } from '@shared/types/ipc'

interface SuggestionRule {
  matcher: (workspaceDir: string) => boolean
  reason: string
  build: (workspaceDir: string) => Partial<SkillMetadata>
}

const RULES: SuggestionRule[] = [
  {
    matcher: (ws) => existsSync(join(ws, 'package.json')),
    reason: '检测到 package.json → 推荐 Node 生态技能',
    build: () => ({
      id: 'suggest.npm-tools',
      name: 'npm-tools',
      displayName: 'npm 工具集',
      description: 'npm 包管理、脚本运行、依赖分析',
      category: 'coding',
      tags: ['npm', 'node'],
    }),
  },
  {
    matcher: (ws) => existsSync(join(ws, 'requirements.txt')) || existsSync(join(ws, 'pyproject.toml')),
    reason: '检测到 Python 项目 → 推荐 Python 生态技能',
    build: () => ({
      id: 'suggest.python-tools',
      name: 'python-tools',
      displayName: 'Python 工具集',
      description: 'pip、venv、pytest 集成',
      category: 'coding',
      tags: ['python', 'pip'],
    }),
  },
  {
    matcher: (ws) => existsSync(join(ws, '.git')),
    reason: '检测到 Git 仓库 → 推荐 Git 工作流技能',
    build: () => ({
      id: 'suggest.git-flow',
      name: 'git-flow',
      displayName: 'Git Flow 工作流',
      description: 'Git 工作流辅助，规范分支',
      category: 'coding',
      tags: ['git', 'workflow'],
    }),
  },
  {
    matcher: (ws) => {
      const docs = join(ws, 'docs')
      if (!existsSync(docs)) return false
      try {
        return readdirSync(docs).some((f) => f.endsWith('.md') || f.endsWith('.markdown'))
      } catch {
        return false
      }
    },
    reason: '检测到 docs 目录含 Markdown → 推荐文档类技能',
    build: () => ({
      id: 'suggest.doc-tools',
      name: 'doc-tools',
      displayName: '文档工具集',
      description: 'Markdown 解析、文档生成',
      category: 'document',
      tags: ['markdown', 'doc'],
    }),
  },
]

export function suggestSkillsForWorkspace(workspaceDir: string): SkillMetadata[] {
  if (!workspaceDir) return []
  const items: SkillMetadata[] = []
  for (const rule of RULES) {
    if (!rule.matcher(workspaceDir)) continue
    const partial = rule.build(workspaceDir)
    items.push({
      id: partial.id ?? '',
      name: partial.name ?? '',
      displayName: partial.displayName ?? '',
      description: partial.description ?? '',
      category: (partial.category as SkillMetadata['category']) ?? 'other',
      tags: partial.tags ?? [],
      version: '1.0.0',
      author: { name: 'ArkWork' },
      keywords: [],
      downloads: 0,
      rating: 0,
      ratingCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contextCostEstimate: { baseline: 50, active: 1200, perTurn: 320 },
      compatibility: { minArkWorkVersion: '0.15.0', os: ['macos', 'linux', 'windows'], dependencies: [] },
      source: 'builtin',
      featured: false,
      deprecated: false,
    })
  }
  return items
}