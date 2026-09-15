// src/index-builder.ts
// 从当前全部页面重生成 index.md（派生工件：自定义注释会被覆盖，README 已注明）。
// 行格式 `- [[id]] 标题 — 摘要`，与手工索引及 retriever L1 的 [[wikilink]] 行匹配保持兼容。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeBody } from './vault-store.ts'
import type { VaultStore } from './vault-store.ts'
import type { WikiCategory } from './types.ts'

const SECTION_TITLES: Array<{ category: WikiCategory; title: string }> = [
  { category: 'concepts', title: '## 概念页' },
  { category: 'entities', title: '## 实体页' },
  { category: 'dictionaries', title: '## 字典' },
  { category: 'tables', title: '## 数据结构' },
  { category: 'references', title: '## 参考资料' },
  { category: 'synthesis', title: '## 综合' },
  { category: 'projects', title: '## 项目知识' },
]

/**
 * 摘要规则由 vault-store 统一提供，且两个派生工件必须给出同一句话：index.md 的描述
 * 优先取页面 frontmatter 的 `summary:`（那正是写进文件的权威值），只有页面没有该字段时
 * 才回退到从正文派生。否则人工撰写的摘要会出现「frontmatter 一个说法、index.md 另一个
 * 说法」，且 index-only 快速层无法用摘要检索到页面。
 * 保留 `summarize` 这个旧导出名，避免破坏既有调用方与声明产物。
 */
export { summarizeBody as summarize }

/**
 * 稳定排序键：按 id 的码位升序。
 * 不用 localeCompare——它受运行环境 locale 影响，同一份库在不同机器上会生成不同顺序的
 * index.md，使这个派生工件不可复现、diff 噪声大。码位比较与 locale 无关，且对 CJK id 同样确定。
 */
function byId(a: { summary: { id: string } }, b: { summary: { id: string } }): number {
  return a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0
}

/** 幂等重建 index.md；返回 { pageCount }。 */
export function rebuildIndex(store: VaultStore): { pageCount: number } {
  const pages = store.listPages()
    .map((p) => ({ summary: p, page: store.readPage(p.id, p.category) }))
    .filter((x) => x.page !== null)

  const lines: string[] = [
    '# Wiki Index',
    '',
    '> 由 dsh-knj-obsidian 维护。概念页 / 实体页 / 参考 / 综合 / 项目知识。',
    '',
  ]
  for (const section of SECTION_TITLES) {
    // 显式排序：listPages 的顺序来自 readdirSync，依赖文件系统枚举顺序（不保证有序）。
    // 不排序的话 index.md 的行序会随文件系统变化，且不可复现。
    const inSection = pages.filter((x) => x.summary.category === section.category).sort(byId)
    lines.push(section.title, '')
    for (const { summary, page } of inSection) {
      const s = page!.summary?.trim() || summarizeBody(page!.body)
      lines.push(s ? `- [[${summary.id}]] ${page!.title} — ${s}` : `- [[${summary.id}]] ${page!.title}`)
    }
    lines.push('')
  }
  writeFileSync(join(store.wikiRoot, 'index.md'), lines.join('\n'), 'utf8')
  return { pageCount: pages.length }
}
