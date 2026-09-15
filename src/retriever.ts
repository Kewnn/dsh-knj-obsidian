// src/retriever.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeTier } from './vault-store.ts'
import type { VaultStore } from './vault-store.ts'
import type { WikiCategory, WikiTier, WikiPage, Confidence } from './types.ts'

/** 正式分类全量清单（L1 索引命中后逐类回读；此前漏了 dictionaries/tables，导致字典/表结构页在 index-only 模式检索不到）。
 *  同时作为语义命中的分类白名单：_system/ 与 wiki-export/ 不在其中，故永不可被语义层命中。 */
export const RETRIEVAL_CATEGORIES: readonly WikiCategory[] = ['concepts', 'entities', 'references', 'synthesis', 'projects', 'dictionaries', 'tables']

/**
 * 基础匹配分。10/6/4/2 四项与上游 obsidian-wiki 的 graphrag 打分逐项对齐
 * （精确标题 / 标题 / 标签 / 摘要），使两套检索引擎对同一个库给出方向一致的排序。
 * index/semantic/body/graph 是本地扩展：上游 graph-query 压根不读正文，没有正文与
 * 图谱层，故这三项取较低的基础分，保证既有「前置层优先」语义在分数上也可读。
 */
export const MATCH_SCORE = {
  exactTitle: 10,
  title: 6,
  tag: 4,
  semantic: 3,
  summary: 2,
  index: 2,
  body: 1,
  graph: 0.5,
} as const

/** tier 权重（与上游一致）：core 1.3 / supporting 1.0 / peripheral 0.7。 */
export const TIER_WEIGHT: Record<WikiTier, number> = { core: 1.3, supporting: 1, peripheral: 0.7 }

/** 度加权：min(度 × 0.1, 2)，度 = 出链 + 入链（与上游 degree bonus 同式）。 */
const DEGREE_STEP = 0.1
const MAX_DEGREE_BONUS = 2

export interface RetrievalCandidate {
  page: string
  id: string
  category: WikiCategory
  title: string
  confidence: Confidence
  snippet: string
  matchedBy: 'title' | 'tag' | 'summary' | 'body' | 'graph' | 'index' | 'semantic'
  /** 相关性分数（越大越相关）= 基础匹配分 + 度加权，再乘 tier 权重。候选恒按此降序返回。 */
  score: number
  /** 归一化后的分层（core/supporting/peripheral），即打分所用的权重档位。 */
  tier: WikiTier
}

export interface RetrievalResult {
  candidates: RetrievalCandidate[]
  strategy: string
  totalPages: number
}

/** 语义召回命中（由调用方预先取好并已做边界过滤，保持 retrieve 为同步纯函数） */
export interface SemanticPageHit {
  id: string
  category: WikiCategory
  /** 后端给出的片段；缺省时按正文头部生成 */
  snippet?: string
}

export interface RetrievalOptions {
  mode?: 'auto' | 'index-only'
  maxCandidates?: number
  /** 为空/未提供时，下面所有分支与不含语义层时逐字节一致 */
  semanticHits?: SemanticPageHit[]
}

const MAX_SNIPPET = 200

/** 解析 [[wikilink]]：剥离锚点（#…）与别名（|…），与 lint.ts 保持一致 */
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g

/** 已解析页面 + 其所属分类（分类由目录决定，不用页面 frontmatter 自称的值）。 */
interface PageEntry {
  id: string
  category: WikiCategory
  page: WikiPage
}

export function retrieve(
  store: VaultStore,
  query: string,
  opts: RetrievalOptions = {},
): RetrievalResult {
  const mode = opts.mode ?? 'auto'
  const maxCandidates = opts.maxCandidates ?? 10
  const q = query.trim().toLowerCase()
  // 只读列举：检索不得触发 ensure()（零写入，全新 vault 也可直接检索）
  const pages = store.listPagesReadonly()
  const totalPages = pages.length

  if (!q) return { candidates: [], strategy: 'empty-query', totalPages }

  if (mode === 'index-only') {
    return { candidates: indexOnly(store, q, maxCandidates), strategy: 'index-only', totalPages }
  }

  // 单次装载：前置层匹配、正文匹配、度计算共用同一份已解析页面（readPage 自带 mtime 缓存）
  const entries: PageEntry[] = []
  for (const p of pages) {
    const page = store.readPage(p.id, p.category)
    if (page) entries.push({ id: p.id, category: p.category, page })
  }
  const degree = degreeMap(entries)

  // 语义召回：仅接受库内真实页面（幽灵/越界命中在此被剔除）
  const semanticHits = semanticCandidates(store, opts.semanticHits, pages, degree)
  const hasSemantic = semanticHits.length > 0

  // 前置层（frontmatter 级，均无需读正文）：标题 / 标签
  const frontHits: RetrievalCandidate[] = []
  let guardTriggered = false
  for (const e of entries) {
    const m = frontMatch(e, q)
    if (!m) continue
    if (m.guards) guardTriggered = true
    frontHits.push(candidate(e, m.layer, m.base, degree))
  }
  const frontIds = new Set(frontHits.map((c) => c.id))

  // 摘要层：**严格低于正文层的回退层**——只有当查询出现在摘要里、却不出现在该页正文里
  // （也不在标题/标签里）时才产生候选。
  //
  // 这条规则的意义在于它让「判断摘要是人工撰写还是机器派生」这件事**根本不必要**：
  // 派生摘要就是正文首行的副本，其内容必然也在正文里，因此永远走不到这里——既不会凭空
  // 多出候选，也不可能把本该标 body 的命中改判成 summary（连带换掉 L3 的居中 snippet）。
  // 而人工摘要可能含有正文里根本没有的措辞，那才是摘要层真正新增的召回。
  //
  // 早先的写法是拿磁盘上的摘要与 summarizeBody(正文) 比字符串来判断「是否人工撰写」，
  // 那是靠内容推断来源，会在两种情况下失效：正文首行含孤立 \r 时写入端会把它拍平成空格
  // 而比较用的是未拍平的原文（把机器派生误判成人工）；正文被编辑器改过之后旧摘要与正文
  // 不再相等（同样误判成人工）。改成「低于正文层」后这类误判不再影响匹配结果。
  const summaryHits: RetrievalCandidate[] = []
  for (const e of entries) {
    if (frontIds.has(e.id)) continue
    if (e.page.body.toLowerCase().includes(q)) continue // 正文能命中：交给正文层，别抢标签
    const summary = e.page.summary ?? ''
    if (!summary.toLowerCase().includes(q)) continue
    // snippet 同样受 MAX_SNIPPET 约束：摘要是外部输入，长度不受控
    summaryHits.push(candidate(e, 'summary', MATCH_SCORE.summary, degree, summary.slice(0, MAX_SNIPPET)))
  }

  // 成本护栏（既有契约，retriever.test.mjs 断言 strategy === 'title+tag'）：前置层出现
  // 标题/标签命中就不再下探正文。护栏的触发条件与改动前逐字一致，精确匹配与摘要命中只
  // 追加候选，因此这条路径上召回只增不减。
  if (!hasSemantic && guardTriggered) {
    return {
      candidates: rank([...frontHits, ...summaryHits], degree, maxCandidates),
      strategy: summaryHits.length > 0 ? 'title+tag+summary' : 'title+tag',
      totalPages,
    }
  }

  // 正文层：与改动前一致地扫全部页面（不排除前置层已命中的页）。这一点是必需的——
  // bodyHits 同时充当 L4 的种子集合，若把前置层命中页从这里剔除，那些页的一跳邻居就会
  // 整体消失（差分实测：query="版本号铁律" 时 dsh-knj-plugins 转入摘要命中后，它的邻居
  // dsh-agent-orchestration 被一并丢掉）。重复候选由下面的融合去重处理。
  const bodyHits: RetrievalCandidate[] = []
  for (const e of entries) {
    const idx = e.page.body.toLowerCase().indexOf(q)
    if (idx !== -1) bodyHits.push(candidate(e, 'body', MATCH_SCORE.body, degree, undefined, idx))
  }

  // L4：对 L3 命中的每个页面，取其出链邻居作为关联候选（matchedBy: 'graph'）
  const bodyIds = new Set(bodyHits.map((h) => h.id))
  const byId = new Map(entries.map((e) => [e.id, e]))
  const graphHits: RetrievalCandidate[] = []
  const seen = new Set<string>() // 多个正文命中共享同一邻居时只保留一份
  for (const hit of bodyHits) {
    for (const target of linkedPages(store, hit.id, hit.category)) {
      const te = byId.get(target)
      if (!te) continue
      if (bodyIds.has(target)) continue // 已命中不重复
      if (seen.has(target)) continue // 重复邻居去重
      seen.add(target)
      graphHits.push(candidate(te, 'graph', MATCH_SCORE.graph, degree))
    }
  }

  // 融合各层，按首次出现去重：既有层优先，故语义层与前置层/正文层命中同一页时，
  // matchedBy 与 score 一律取既有层（与语义层加入前的行为一致）。摘要层同理——它只在
  // 正文层不命中时才产生候选，所以它是天然的最后回退层，不会与正文层抢同一页。
  const merged: RetrievalCandidate[] = []
  const mergedIds = new Set<string>()
  for (const c of [...frontHits, ...bodyHits, ...summaryHits, ...graphHits, ...semanticHits]) {
    if (mergedIds.has(c.id)) continue
    mergedIds.add(c.id)
    merged.push(c)
  }

  const parts = ['title+tag']
  if (summaryHits.length > 0) parts.push('summary')
  if (bodyHits.length > 0) parts.push('body')
  if (graphHits.length > 0) parts.push('graph')
  if (hasSemantic) parts.push('semantic')
  return { candidates: rank(merged, degree, maxCandidates), strategy: parts.join('+'), totalPages }
}

/** 前置层匹配结果：layer 决定 matchedBy，base 是基础分，guards 决定是否触发成本护栏。 */
interface FrontMatch {
  layer: 'title' | 'tag'
  base: number
  /**
   * 是否触发「前置层命中即停、不下探正文」的成本护栏。
   *
   * **只有改动前就存在的两个条件（标题包含 / 标签包含）才算**。新增的「id 精确相等」
   * 只增加候选与分数，绝不能改变护栏触发条件：一个恰好等于某页 id 的查询在改动前是
   * 不命中前置层的（标题里没有这个 id），会正常下探正文、拿到所有引用它的页面；
   * 若让精确匹配触发护栏，这类查询就会提前返回、只给出该页本身，造成召回缩水。
   * （差分实测：query="dsh-agent-orchestration" 改动前返回 4 个引用页，让精确匹配触发
   * 护栏后只剩 1 个。）
   */
  guards: boolean
}

/**
 * 前置层匹配（标题 / 标签，均无需读正文）。
 * 与上游一致：一个查询对一页只取**最高**的那一档，不叠加（上游同样是 if/elif 链）。
 */
function frontMatch(e: PageEntry, q: string): FrontMatch | null {
  const title = e.page.title.toLowerCase()
  if (title.includes(q)) {
    // 精确命中（id 或标题与查询词完全相等）拿最高基础分；这是同一档内的分数细化，
    // 不改变「谁命中前置层」这件事。
    const exact = e.id.toLowerCase() === q || title === q
    return { layer: 'title', base: exact ? MATCH_SCORE.exactTitle : MATCH_SCORE.title, guards: true }
  }
  if (e.page.tags.some((t) => t.toLowerCase().includes(q))) {
    return { layer: 'tag', base: MATCH_SCORE.tag, guards: true }
  }
  // id 精确相等但标题不含查询词：产生候选并给最高分，但**不**触发护栏（见 guards 说明）。
  if (e.id.toLowerCase() === q) return { layer: 'title', base: MATCH_SCORE.exactTitle, guards: false }
  return null
}

/** 打分：基础分 + 度加权，再乘 tier 权重（与上游 graphrag._score 同式）。 */
function scoreOf(base: number, degree: number, tier: WikiTier): number {
  return (base + Math.min(degree * DEGREE_STEP, MAX_DEGREE_BONUS)) * TIER_WEIGHT[tier]
}

/**
 * 页面的 wikilink 度（出链 + 入链），只统计指向库内真实页的链接；
 * 同一页重复指向同一目标只计一次——否则一个反复引用同一页的文档会虚增双方度数。
 */
function degreeMap(entries: PageEntry[]): Map<string, number> {
  const degree = new Map<string, number>()
  const known = new Set(entries.map((e) => e.id))
  for (const e of entries) degree.set(e.id, 0)
  for (const e of entries) {
    const linked = new Set<string>()
    for (const m of e.page.body.matchAll(WIKILINK_RE)) {
      const target = m[1].trim()
      if (target === e.id || !known.has(target) || linked.has(target)) continue
      linked.add(target)
      degree.set(e.id, (degree.get(e.id) ?? 0) + 1)
      degree.set(target, (degree.get(target) ?? 0) + 1)
    }
  }
  return degree
}

/** 按 score 降序返回前 max 条；同分用度降序、页面路径升序兜底，使结果可复现且不依赖文件遍历顺序。 */
function rank(cands: RetrievalCandidate[], degree: Map<string, number>, max: number): RetrievalCandidate[] {
  return [...cands]
    .sort((a, b) =>
      b.score - a.score
      || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
      || (a.page < b.page ? -1 : a.page > b.page ? 1 : 0))
    .slice(0, max)
}

/** 把语义命中映射为候选；只接受库内真实页面，去重后保持后端给出的顺序。 */
function semanticCandidates(
  store: VaultStore,
  hits: SemanticPageHit[] | undefined,
  pages: { id: string; category: WikiCategory }[],
  degree: Map<string, number>,
): RetrievalCandidate[] {
  if (!hits || hits.length === 0) return []
  const known = new Set(pages.map((p) => `${p.category}/${p.id}`))
  const out: RetrievalCandidate[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const key = `${hit.category}/${hit.id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!known.has(key)) continue // 库内不存在的页面（含越界路径）直接丢弃
    const page = store.readPage(hit.id, hit.category)
    if (!page) continue
    out.push(candidate({ id: hit.id, category: hit.category, page }, 'semantic', MATCH_SCORE.semantic, degree, hit.snippet))
  }
  return out
}

/**
 * L1 快速层：只读 index.md 的命中行，不建全图。
 * 因此这里不做度加权（度为 0），分数只由基础分 × tier 权重构成；也刻意**不重排**——
 * index.md 的顺序是人工维护的目录顺序，比常量分排序更有信息量（见 spec 的「可牺牲」项）。
 */
function indexOnly(store: VaultStore, q: string, max: number): RetrievalCandidate[] {
  const out: RetrievalCandidate[] = []
  const noDegree = new Map<string, number>()
  const indexPath = join(store.wikiRoot, 'index.md')
  try {
    const lines = readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n').split('\n')
    for (const line of lines) {
      const m = line.match(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/)
      if (m && line.toLowerCase().includes(q)) {
        const id = m[1].trim()
        let page: WikiPage | null = null
        for (const cat of RETRIEVAL_CATEGORIES) {
          page = store.readPage(id, cat)
          if (page) break
        }
        if (page) {
          out.push(candidate({ id, category: page.category, page }, 'index', MATCH_SCORE.index, noDegree, line.trim().slice(0, MAX_SNIPPET)))
          if (out.length >= max) break
        }
      }
    }
  } catch {
    // index.md 缺失时 L1 无候选，降级交给调用方
  }
  return out
}

function candidate(
  e: PageEntry,
  matchedBy: RetrievalCandidate['matchedBy'],
  base: number,
  degree: Map<string, number>,
  snippetOverride?: string,
  matchIndex?: number,
): RetrievalCandidate {
  const tier = normalizeTier(e.page.tier)
  return {
    page: `${e.category}/${e.id}.md`,
    id: e.id,
    category: e.category,
    title: e.page.title,
    confidence: e.page.confidence,
    snippet: snippetOverride ?? snippet(e.page.body, matchedBy, matchIndex),
    matchedBy,
    score: scoreOf(base, degree.get(e.id) ?? 0, tier),
    tier,
  }
}

function snippet(body: string, matchedBy: RetrievalCandidate['matchedBy'], matchIndex?: number): string {
  if (matchedBy === 'title' || matchedBy === 'tag' || matchedBy === 'summary') {
    const first = body.split('\n').find((l) => l.trim().length > 0) ?? ''
    return first.slice(0, MAX_SNIPPET)
  }
  if (typeof matchIndex === 'number') {
    // L3：以命中位置为中心的窗口（±100，收拢到正文边界，≤200 字符）
    const start = Math.max(0, matchIndex - MAX_SNIPPET / 2)
    return body.slice(start, start + MAX_SNIPPET)
  }
  return body.slice(0, MAX_SNIPPET)
}

/**
 * 返回页面正文中的出链 target 列表（[[b]]、[[c|别名]]、[[d#锚点]] 均归一为 id，
 * 锚点与别名被剥离），供 L4 图谱遍历与跨页关联复用。
 */
export function linkedPages(store: VaultStore, id: string, category: WikiCategory): string[] {
  const page = store.readPage(id, category)
  if (!page) return []
  const out: string[] = []
  for (const m of page.body.matchAll(WIKILINK_RE)) {
    out.push(m[1].trim())
  }
  return out
}
