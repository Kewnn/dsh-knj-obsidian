// taxonomy-layers.test.mjs
// 分层词表：基础层（随插件分发，只装 Type 轴与通用别名）+ 本库层（Domain/Project）
// 目标：迁移到内容完全不同的项目时无需预先设计词表——Type 轴随插件到位，Domain/Project 就地涌现
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { lintVault } from './lib/lint.js'
import { parseTaxonomy, mergeTaxonomies, loadTaxonomy, TYPE_SECTION, baseTaxonomyPath } from './lib/taxonomy.js'

const NOW = '2026-09-20T00:00:00.000Z'

const BASE = `# 基础标签词表

## Type — 知识类型

- \`concept\` — 机制与语义
- \`pitfall\` — 实证过的坑
  - aliases: pitfalls, troubleshooting
- \`api-contract\` — 契约与不变量
  - aliases: host-api
- \`index\` — 溯源清单
  - aliases: provenance
`

const LOCAL = `# 本库词表

## Domain — 领域

- \`react\` — React 前端
- \`vite\` — 构建工具

## Type — 知识类型

- \`a11y\` — 无障碍（本库新增，基础词表没有）

## Project — 项目

- \`knsearch\` — 检索前端
`

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-layers-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}
const pg = (over) => ({ category: 'concepts', tags: [], source: 's', confidence: 'extracted', created: NOW, updated: NOW, body: '正文。', ...over })
function writeLocal(dir, text) {
  mkdirSync(join(dir, '.wiki', '_meta'), { recursive: true })
  writeFileSync(join(dir, '.wiki', '_meta', 'taxonomy.md'), text, 'utf8')
}

// ─────────────────────────────── 基础层随包分发

test('随包分发的 taxonomy.base.md 存在且可解析，Type 轴规范词数符合预期', () => {
  const p = baseTaxonomyPath()
  assert.ok(existsSync(p), `基础词表应随包分发：${p}`)
  const tx = parseTaxonomy(readFileSync(p, 'utf8'), 'base')
  assert.equal(tx.sections.includes(TYPE_SECTION), true, `应有 ${TYPE_SECTION} 小节`)
  const typeTags = tx.entries.filter((e) => e.section === TYPE_SECTION)
  assert.equal(typeTags.length, 8, `Type 轴应有 8 个规范词，实际 ${typeTags.length}：${typeTags.map((t) => t.tag)}`)
  assert.ok(tx.entries.every((e) => e.origin === 'base'), '基础词表条目的 origin 应为 base')
})

test('干净库（无本库词表）也具备 Type 轴校验能力', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tx = loadTaxonomy(store, { baseText: BASE })
  assert.ok(tx, '有基础词表就应加载成功')
  assert.ok(tx.canonical.has('pitfall'), '基础层规范词应在位')
  assert.equal(tx.hasVaultFile, false)

  const r = lintVault(store, { baseText: BASE }).tags
  assert.equal(r.taxonomyPresent, true, '有基础层即视为有词表')
  assert.equal(r.vaultTaxonomyPresent, false, '本库词表不存在')
})

// ─────────────────────────────── 分层合并

test('合并：基础层 ∪ 本库层；同一规范词以本库为准，且带来源标记', () => {
  const merged = mergeTaxonomies(
    parseTaxonomy(BASE, 'base'),
    parseTaxonomy(LOCAL + `- \`concept\` — 本库改写的描述\n`, 'vault'),
  )
  assert.ok(merged.canonical.has('api-contract'), '基础层词应在')
  assert.ok(merged.canonical.has('react'), '本库词应在')
  assert.equal(merged.entries.find((e) => e.tag === 'concept').description, '本库改写的描述', '同词以本库为准')
  assert.equal(merged.entries.find((e) => e.tag === 'react').origin, 'vault')
  assert.equal(merged.entries.find((e) => e.tag === 'api-contract').origin, 'base')
  assert.ok(merged.sections.includes('Domain') && merged.sections.includes('Type'), '小节名合并后仍可辨')
})

test('别名：两层取并集，同别名冲突时本库优先；规范词不会被当成别名', () => {
  const merged = mergeTaxonomies(
    parseTaxonomy(BASE, 'base'),
    parseTaxonomy(`## Type\n\n- \`pitfall\` — 覆盖\n  - aliases: gotcha\n`, 'vault'),
  )
  assert.equal(merged.aliases.get('gotcha'), 'pitfall', '本库别名应生效')
  assert.equal(merged.aliases.get('troubleshooting'), 'pitfall', '基础层别名应保留')
  assert.equal(merged.aliases.get('pitfall'), undefined, '规范词本身不得被当成别名重定向')
})

// ─────────────────────────────── 审计：promote 与 localTypeTags

test('promote：只有出现 ≥2 页的未知词才进升表候选', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL)
  // 关键点：基础层没有 vite，本库层也没有（本库只登记了 react/vite？——这里故意把 vite 从本库层拿掉）
  writeLocal(dir, LOCAL.replace('- `vite` — 构建工具\n', ''))
  store.writePage(pg({ id: 'p1', title: '页1', tags: ['react', 'vite'] }))
  store.writePage(pg({ id: 'p2', title: '页2', tags: ['vite', 'a11y'] }))
  const r = lintVault(store, { baseText: BASE }).tags
  assert.deepEqual(r.promote.map((p) => `${p.tag}×${p.pages.length}`), ['vite×2'], `实际 ${JSON.stringify(r.promote)}`)
  assert.ok(!r.promote.some((p) => p.tag === 'a11y'), '1 页的词不得进升表候选')
})

test('localTypeTags：只标出「本库新增且基础词表没有」的 Type 词', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL)
  const r = lintVault(store, { baseText: BASE }).tags
  assert.deepEqual(r.localTypeTags, ['a11y'], `实际 ${JSON.stringify(r.localTypeTags)}`)
  assert.ok(!r.localTypeTags.includes('concept'), '覆盖基础层已有 Type 词不算新增')
})

// ─────────────────────────────── 降级

test('基础词表缺失时退回今天的行为：只报超上限/零标签', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(pg({ id: 'a', title: '甲', tags: ['随便', '什么', '都', '行', '的', '词'] }))
  store.writePage(pg({ id: 'b', title: '乙', tags: [] }))
  const r = lintVault(store, { baseText: null }).tags
  assert.equal(r.taxonomyPresent, false, 'baseText=null 且无本库词表 → 无词表')
  assert.deepEqual(r.unknown, [])
  assert.deepEqual(r.promote, [])
  assert.deepEqual(r.localTypeTags, [])
  assert.deepEqual(r.overTagged.map((o) => o.id), ['a'])
  assert.ok(r.untagged.includes('b'))
})

test('基础文本为空、或只有小节标题没有词时，视为「无有效基础词表」', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(pg({ id: 'x', title: '页', tags: ['pi', 'ta'] }))
  for (const baseText of ['', '## Type\n\n（本节暂无词）\n']) {
    const r = lintVault(store, { baseText }).tags
    assert.equal(r.taxonomyPresent, false, `baseText=${JSON.stringify(baseText)} 不应声称有词表`)
    assert.deepEqual(r.unknown, [], '无有效词表时不得报未知')
  }
})

test('系统标签 visibility/* 不参与页数统计，进不了 promote 也不算未知', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL)
  store.writePage(pg({ id: 's1', title: '系统1', tags: ['visibility/internal'] }))
  store.writePage(pg({ id: 's2', title: '系统2', tags: ['visibility/internal'] }))
  const r = lintVault(store, { baseText: BASE }).tags
  assert.deepEqual(r.unknown, [], '系统标签不得被当成未知标签')
  assert.deepEqual(r.promote, [], '系统标签不得进升表候选')
})
