// src/semantic.ts
// qmd（Quick Markdown Search）语义检索层：把外部 CLI 的语义命中映射为库内页面命中。
//
// 设计约束（真源：docs/2026-09-13-qmd-integration-spec.md）：
//   - 只读：检索路径零写入 —— 绝不在此创建 collection、触发索引或下载模型
//   - 降级安全：探测失败 / 超时 / 非零退出 / 非法输出一律降级为纯 L1–L4，绝不抛出
//   - 边界收窄：只接受七个正式分类目录下的 .md；_system/（会话归档）与 wiki-export/ 永不可命中
//   - 语义层默认关闭：未提供 backend 时，返回值与 retrieve() 完全一致
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { retrieve, RETRIEVAL_CATEGORIES } from './retriever.ts'
import type { RetrievalResult, SemanticPageHit } from './retriever.ts'
import type { VaultStore } from './vault-store.ts'
import type { WikiCategory } from './types.ts'

const execFileAsync = promisify(execFile)

/** 语义后端返回的原始命中（形态对齐 qmd：文件路径 + 可选分数/片段） */
export interface SemanticRawHit {
  path: string
  score?: number
  snippet?: string
}

/** 语义后端：只做「查询 → 原始命中」，不感知 vault 结构（便于用假后端单测） */
export interface SemanticBackend {
  name: string
  search(query: string, opts?: { limit?: number }): Promise<SemanticRawHit[]>
}

export interface SemanticProbe {
  available: boolean
  reason?: string
}

export interface SemanticUnavailable {
  reason: string
}

export type SemanticRetrievalResult = RetrievalResult & { semanticUnavailable?: SemanticUnavailable }

export interface SemanticRetrieveOptions {
  /** 未提供 / null = 语义层关闭 → 返回值与 retrieve() 逐字段一致 */
  semantic?: SemanticBackend | null
  mode?: 'auto' | 'index-only'
  maxCandidates?: number
  /** 传给后端的候选上限 */
  limit?: number
}

const PROBE_TIMEOUT_MS = 5000

/** 探测 qmd 是否可用（只跑 --version，不产生任何写入）。失败返回原因而非抛出。 */
export async function probeQmd(opts: { binaryPath?: string } = {}): Promise<SemanticProbe> {
  const bin = opts.binaryPath?.trim() || 'qmd'
  // 绝对/带路径分隔符 → 明确指定了文件，先做存在性检查（错误信息更可读）
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    if (!existsSync(bin)) return { available: false, reason: `qmd 可执行文件不存在：${bin}` }
  }
  try {
    await execFileAsync(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true })
    return { available: true }
  } catch (error) {
    return { available: false, reason: `qmd 探测失败：${(error as Error)?.message ?? String(error)}` }
  }
}

/**
 * 把后端返回的原始路径命中映射为库内页面命中。
 * 任何越界/非正式分类/非 .md 的路径一律丢弃（含 _system/ 与 wiki-export/）。
 */
export function mapHitsToPages(wikiRoot: string, hits: readonly SemanticRawHit[] | undefined): SemanticPageHit[] {
  const out: SemanticPageHit[] = []
  if (!hits) return out
  const root = resolve(wikiRoot)
  for (const hit of hits) {
    if (!hit || typeof hit.path !== 'string') continue
    const rel = relative(root, resolve(hit.path))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue // vault 之外
    const parts = rel.split(/[\\/]+/).filter((s) => s.length > 0)
    if (parts.length !== 2) continue // 只接受 <category>/<file>.md，_system/… 这类深层路径天然被排除
    const [category, file] = parts
    if (!RETRIEVAL_CATEGORIES.includes(category as WikiCategory)) continue // 白名单：_system / wiki-export 不可能通过
    if (!file.toLowerCase().endsWith('.md')) continue
    const id = file.slice(0, -3)
    if (!id) continue
    out.push(hit.snippet ? { id, category: category as WikiCategory, snippet: hit.snippet } : { id, category: category as WikiCategory })
  }
  return out
}

/**
 * 带语义层的检索：先取语义命中，再交给同步纯函数 retrieve() 融合。
 * 后端缺失/抛错/返回非法值时降级为纯 L1–L4，并在结果上标注 semanticUnavailable。
 */
export async function retrieveWithSemantic(
  store: VaultStore,
  query: string,
  opts: SemanticRetrieveOptions = {},
): Promise<SemanticRetrievalResult> {
  const base = { mode: opts.mode, maxCandidates: opts.maxCandidates }
  if (!opts.semantic) return retrieve(store, query, base) // 语义关闭：与现状完全一致（不加任何字段）

  let hits: SemanticRawHit[]
  try {
    hits = await opts.semantic.search(query, { limit: opts.limit ?? opts.maxCandidates ?? 10 })
  } catch (error) {
    return { ...retrieve(store, query, base), semanticUnavailable: { reason: (error as Error)?.message ?? String(error) } }
  }
  if (!Array.isArray(hits)) {
    return { ...retrieve(store, query, base), semanticUnavailable: { reason: '语义后端返回了非数组结果' } }
  }
  return retrieve(store, query, { ...base, semanticHits: mapHitsToPages(store.wikiRoot, hits) })
}
