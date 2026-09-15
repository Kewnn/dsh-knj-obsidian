// src/taxonomy.ts
// 受控标签词表（controlled vocabulary）—— 分层设计，对齐上游 obsidian-wiki 的 tag-taxonomy：
//
//   L1 基础层：随插件分发（taxonomy.base.md），只装 **Type 轴 + 跨项目通用别名**，所有库共享。
//   L3 库级层：<vault>/_meta/taxonomy.md，只装 Domain（领域）与 Project（项目/模块）。
//
// 生效词表 = L1 ∪ L3，同词以 L3 为准。
//
// 为什么这样分：迁移到知识内容完全不同的项目时，Type 轴是**项目无关**的，所以随插件到位、
// 零配置；而 Domain/Project 本来就该由素材涌现（「≥2 页才升表」）。刻意**不做**用户级共享层
// （~/.dsh 下）——它不随项目走，迁移时反而是负资产。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VaultStore } from './vault-store.ts'

/** 每页标签上限（对齐上游 tag-taxonomy 的 "max 5 tags per page"）。 */
export const TAG_LIMIT = 5

/** 词表相对 .wiki 的路径（库级层）。与上游 _meta/taxonomy.md 同路径。 */
export const TAXONOMY_REL = '_meta/taxonomy.md'

/** Type 轴的小节名。文件里可写作「Type — 知识类型」，解析后 section 必须正好是它。 */
export const TYPE_SECTION = 'Type'

/**
 * 系统标签组前缀：上游预留 visibility/ 用于可见性（public/internal/pii）。
 * 约定：不计入 TAG_LIMIT、不参与别名映射、审计时单独报告而不算「未知标签」。
 */
export const SYSTEM_TAG_PREFIX = 'visibility/'

/** 条目来源层：base = 随插件的共享层；vault = 本库层。 */
export type TagOrigin = 'base' | 'vault'

export interface TaxonomyEntry {
  tag: string
  section: string
  description: string
  aliases: string[]
  origin: TagOrigin
}

export interface Taxonomy {
  entries: TaxonomyEntry[]
  /** 规范词集合（两层并集） */
  canonical: Set<string>
  /** 别名 → 规范词（两层并集，库级优先） */
  aliases: Map<string, string>
  /** 出现顺序的小节名（基础层在前） */
  sections: string[]
  /** 基础层提供的规范词（用于判定「本库新增的 Type 词」） */
  baseTags: Set<string>
  /** 基础层是否提供了有效词条 */
  hasBase: boolean
  /** 是否存在有效的库级词表文件 */
  hasVaultFile: boolean
}

/** 基础词表的路径：包根（lib/ 的上一级）。安装副本即 node_modules/dsh-knj-obsidian/taxonomy.base.md。 */
export function baseTaxonomyPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'taxonomy.base.md')
}

/** 读基础词表原文；缺失或读失败返回 null（调用方据此降级为「无基础词表」，绝不抛错）。 */
function readBaseText(): string | null {
  const file = baseTaxonomyPath()
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 解析词表 markdown。可解析的条目格式（其余内容一律当散文忽略）：
 *
 *   ## Domain
 *   - `dsh` — DSH 宿主本体：插件体系、会话机制、编排工具
 *     - aliases: deepseek-harness, plugins
 *
 * 即：`## ` 开小节（`—` 之后的中文注解不进入 section 标识）；`- \`词\``（行首无缩进）
 * 声明一个规范词，`—` 之后是说明；紧随其后的缩进 `- aliases:` 行给该词挂别名。
 * 规则段落里的普通 `- 说明` 不会被误收，因为规范词行**必须**以反引号包裹的词开头。
 */
export function parseTaxonomy(text: string, origin: TagOrigin = 'vault'): Taxonomy {
  const entries: TaxonomyEntry[] = []
  const sections: string[] = []
  let section = ''
  let current: TaxonomyEntry | null = null

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = raw.match(/^##\s+(.+?)\s*$/)
    if (head) {
      // 小节名取 `—` 之前的部分：文件里可以是「Domain — 领域」这种双语标题，
      // 但 section 标识要保持为 Domain / Type / Project，否则下游按 section 分组会被装饰文字打散。
      section = head[1].split('—')[0].trim()
      if (!sections.includes(section)) sections.push(section)
      current = null
      continue
    }
    const item = raw.match(/^-\s+`([^`]+)`\s*(?:—\s*(.*))?$/)
    if (item) {
      current = { tag: item[1].trim(), section, description: (item[2] ?? '').trim(), aliases: [], origin }
      entries.push(current)
      continue
    }
    const alias = raw.match(/^\s+-\s+aliases:\s*(.+?)\s*$/)
    if (alias && current) {
      for (const a of alias[1].split(',')) {
        const clean = a.trim().replace(/^`|`$/g, '')
        if (clean) current.aliases.push(clean)
      }
    }
  }

  return finish(entries, sections, { hasBase: origin === 'base' && entries.length > 0, hasVaultFile: origin === 'vault' && entries.length > 0 })
}

/** 由条目与小节构造 Taxonomy（别名只收「不是规范词」的，规范词优先）。 */
function finish(entries: TaxonomyEntry[], sections: string[], flags: { hasBase: boolean; hasVaultFile: boolean }): Taxonomy {
  const canonical = new Set(entries.map((e) => e.tag))
  const aliases = new Map<string, string>()
  for (const e of entries) {
    for (const a of e.aliases) {
      if (canonical.has(a)) continue
      // 先到先得：同一别名两层都登记时保留先写入的（merge 时基础层先写，库级会覆盖）
      if (!aliases.has(a)) aliases.set(a, e.tag)
    }
  }
  const baseTags = new Set(flags.hasBase ? entries.map((e) => e.tag) : [])
  return { entries, canonical, aliases, sections, baseTags, hasBase: flags.hasBase, hasVaultFile: flags.hasVaultFile }
}

/**
 * 合并两层：基础层在前，库级层覆盖同名词（描述/别名），但保持基础层的顺序。
 * 任一层为 null 都可以；两层都空则返回 null。
 */
export function mergeTaxonomies(base: Taxonomy | null, vault: Taxonomy | null): Taxonomy | null {
  const baseEntries = base?.entries ?? []
  const vaultEntries = vault?.entries ?? []
  if (baseEntries.length === 0 && vaultEntries.length === 0) return null

  const byTag = new Map<string, TaxonomyEntry>()
  for (const e of baseEntries) byTag.set(e.tag, e)
  // Map.set 对已存在的键保持首次插入顺序，因此基础层的位置不被打乱，值是库级的
  for (const e of vaultEntries) byTag.set(e.tag, e)

  const entries = [...byTag.values()]
  const sections = [...base?.sections ?? []]
  for (const s of vault?.sections ?? []) if (!sections.includes(s)) sections.push(s)

  // 别名：基础层先写，库级层覆盖同别名；规范词一律不参与
  const canonical = new Set(entries.map((e) => e.tag))
  const aliases = new Map<string, string>()
  for (const e of baseEntries) for (const a of e.aliases) if (!canonical.has(a)) aliases.set(a, e.tag)
  for (const e of vaultEntries) for (const a of e.aliases) if (!canonical.has(a)) aliases.set(a, e.tag)

  return {
    entries,
    canonical,
    aliases,
    sections,
    baseTags: new Set(base?.canonical ?? []),
    hasBase: (base?.canonical.size ?? 0) > 0,
    hasVaultFile: (vault?.canonical.size ?? 0) > 0,
  }
}

export interface LoadTaxonomyOptions {
  /**
   * 覆盖基础层文本，便于测试：
   * - 不传（undefined）→ 读随插件分发的 taxonomy.base.md
   * - null → 显式不用基础层
   * - 字符串 → 用该文本当基础层（空串/只有小节标题都按「无有效基础词表」处理）
   */
  baseText?: string | null
}

/**
 * 读取生效词表（基础层 ∪ 库级层）。两层都没有有效规范词时返回 null——
 * 调用方据此**跳过**规范词相关检查，而不是把整库标签报成未知，更不是抛异常。
 */
export function loadTaxonomy(store: VaultStore, opts: LoadTaxonomyOptions = {}): Taxonomy | null {
  const baseText = opts.baseText === undefined ? readBaseText() : opts.baseText
  const base = baseText ? parseTaxonomy(baseText, 'base') : null

  let vault: Taxonomy | null = null
  const file = join(store.wikiRoot, TAXONOMY_REL)
  if (existsSync(file)) {
    try {
      vault = parseTaxonomy(readFileSync(file, 'utf8'), 'vault')
    } catch {
      vault = null
    }
  }

  const merged = mergeTaxonomies(base, vault)
  return merged && merged.canonical.size > 0 ? merged : null
}

/** 系统标签（visibility/*）等豁免词：不计上限、不参与别名映射、不算未知。 */
export function isSystemTag(tag: string): boolean {
  return tag.startsWith(SYSTEM_TAG_PREFIX)
}
