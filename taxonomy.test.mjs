// taxonomy.test.mjs
// 受控标签词表：解析 + 四类审计（未知 / 别名 / 超上限 / 零标签）+ 系统标签豁免 + 无词表降级
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { lintVault } from './lib/lint.js'
import { parseTaxonomy, loadTaxonomy, TAG_LIMIT, TAXONOMY_REL, SYSTEM_TAG_PREFIX } from './lib/taxonomy.js'

const NOW = '2026-09-20T00:00:00.000Z'
const FIXTURE = `# Tag Taxonomy

## 规则

- 每页最多 5 个标签。
- 只用规范词，不用别名。

## Domain

- \`dsh\` — DSH 宿主本体
  - aliases: deepseek-harness, plugins
- \`java\` — Java 骨架

## Type

- \`pitfall\` — 踩坑
  - aliases: pitfalls, troubleshooting
- \`concept\` — 原理
`

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-tax-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}

function pg(over) {
  return { category: 'concepts', tags: [], source: 's', confidence: 'extracted', created: NOW, updated: NOW, body: '正文。', ...over }
}

function writeTaxonomy(dir, text) {
  mkdirSync(join(dir, '.wiki', '_meta'), { recursive: true })
  writeFileSync(join(dir, '.wiki', '_meta', 'taxonomy.md'), text, 'utf8')
}

// ─────────────────────────────────── 解析

test('parseTaxonomy：分出小节 / 规范词 / 别名，且不把规则条目当标签', () => {
  const t = parseTaxonomy(FIXTURE)
  assert.deepEqual([...t.canonical].sort(), ['concept', 'dsh', 'java', 'pitfall'])
  assert.deepEqual(t.sections, ['规则', 'Domain', 'Type'])
  assert.equal(t.aliases.get('plugins'), 'dsh')
  assert.equal(t.aliases.get('troubleshooting'), 'pitfall')
  assert.equal(t.aliases.get('deepseek-harness'), 'dsh')
  // 规则小节的 `- 每页最多 5 个标签。` 不能变成规范词
  assert.ok(!t.canonical.has('每页最多 5 个标签。'), '规则条目不得被当成标签')
  assert.equal(t.entries.find((e) => e.tag === 'dsh').description, 'DSH 宿主本体')
})

test('无任何有效词表时 loadTaxonomy 返回 null（不抛错）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 语义变更（分层词表引入后）：干净库不再等于「无词表」——随插件分发的基础层会让它
  // 拥有 Type 轴校验能力。只有显式不要基础层（baseText: null）才是真正的「无词表」。
  assert.equal(loadTaxonomy(store, { baseText: null }), null)
  const withBase = loadTaxonomy(store)
  assert.ok(withBase, '有基础层时应有词表')
  assert.equal(withBase.hasVaultFile, false, '但本库词表不存在')
})

test('ensure() 会建出 _meta/，并把它加进 Obsidian 忽略列表', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.ok(existsSync(join(dir, '.wiki', '_meta')), 'ensure 应创建 _meta/')
  const ignore = JSON.parse(readFileSync(join(dir, '.wiki', '.obsidian', 'app.json'), 'utf8'))
  assert.ok(ignore.userIgnoreFilters.includes('_meta/'), `Obsidian 应忽略 _meta/：${JSON.stringify(ignore.userIgnoreFilters)}`)
})

// ─────────────────────────────────── 四类审计

test('审计：未知标签 / 别名 / 超上限 / 零标签 四类都能报出', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeTaxonomy(dir, FIXTURE)
  store.writePage(pg({ id: 'ok', title: '规范页', tags: ['dsh', 'concept'] }))
  store.writePage(pg({ id: 'unk', title: '未知词页', tags: ['dsh', 'kubernetes', 'flutter'] }))
  store.writePage(pg({ id: 'alias', title: '别名页', tags: ['plugins', 'pitfalls'] }))
  store.writePage(pg({ id: 'over', title: '超限页', tags: ['dsh', 'concept', 'java', 'pitfall', 'ok', 'extra'] }))
  store.writePage(pg({ id: 'none', title: '零标签页', tags: [] }))

  const r = lintVault(store).tags
  assert.equal(r.taxonomyPresent, true)
  assert.deepEqual(r.unknown.map((u) => u.tag).sort(), ['extra', 'flutter', 'kubernetes', 'ok'])
  assert.equal(r.unknown.find((u) => u.tag === 'kubernetes').pages[0], 'unk')
  assert.deepEqual(r.aliasUsed.map((a) => `${a.tag}→${a.canonical}`).sort(), ['pitfalls→pitfall', 'plugins→dsh'])
  assert.deepEqual(r.overTagged.map((o) => o.id), ['over'])
  assert.equal(r.overTagged[0].count, 6)
  assert.ok(r.untagged.includes('none'))
  assert.ok(!r.untagged.includes('ok'), '有规范词的页不算零标签')
})

test('每页上限 = 5（对齐上游）', () => {
  assert.equal(TAG_LIMIT, 5)
})

test('无有效词表时只报超上限与零标签，不把整库标签报成未知', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(pg({ id: 'a', title: '甲', tags: ['随便', '什么', '都', '行', '的', '词'] }))
  store.writePage(pg({ id: 'b', title: '乙', tags: [] }))

  // 显式关掉基础层，才回到「无词表」语义；否则随插件分发的基础层会提供 Type 轴
  const r = lintVault(store, { baseText: null }).tags
  assert.equal(r.taxonomyPresent, false)
  assert.deepEqual(r.unknown, [], '无词表就没有「规范」可言，不得报未知')
  assert.deepEqual(r.aliasUsed, [])
  assert.deepEqual(r.overTagged.map((o) => o.id), ['a'])
  assert.ok(r.untagged.includes('b'))
})

// ─────────────────────────────────── 系统标签豁免

test('系统标签 visibility/* 不计上限、不查别名、不算未知，也不算「有标签」', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeTaxonomy(dir, FIXTURE)
  // 4 个业务标签 + 2 个系统标签：系统标签不参与计数 → 不超限
  store.writePage(pg({ id: 'sys', title: '系统标签页', tags: ['dsh', 'concept', 'java', 'pitfall', `${SYSTEM_TAG_PREFIX}internal`, `${SYSTEM_TAG_PREFIX}pii`] }))
  // 只有系统标签的页：业务标签数为 0 → 算零标签（但不能被报成未知）
  store.writePage(pg({ id: 'onlysys', title: '仅系统标签页', tags: [`${SYSTEM_TAG_PREFIX}public`] }))

  const r = lintVault(store).tags
  assert.deepEqual(r.overTagged, [], '系统标签不得计入上限')
  assert.ok(!r.unknown.some((u) => u.tag.startsWith(SYSTEM_TAG_PREFIX)), '系统标签不算未知')
  assert.ok(r.untagged.includes('onlysys'), '只有系统标签的页算零标签')
})

// ─────────────────────────────────── 仓库里那份库级词表

test('本库 _meta/taxonomy.md 可解析：只管 Domain/Project，别名落在两层', (t) => {
  const file = 'D:\\workspace\\iobs_pro\\.wiki\\' + TAXONOMY_REL.split('/').join('\\')
  if (!existsSync(file)) return t.skip('本机库没有该文件，跳过')
  const local = parseTaxonomy(readFileSync(file, 'utf8'))
  assert.ok(local.entries.length > 0, '库级词表应有词条')
  // 词表分层后：Type 轴归基础层管，库级文件不该重复登记（否则会遮蔽基础层的更新）
  assert.equal(local.entries.filter((e) => e.section === 'Type').length, 0, '库级文件不得重复登记 Type 轴')
  assert.ok(local.sections.includes('Domain') && local.sections.includes('Project'), '库级词表应有 Domain 与 Project 小节')
  // 库级别名（本库专有）
  assert.ok(local.aliases.has('plugins'), 'plugins 应登记为库级别名 → dsh')
  assert.ok(!local.canonical.has('每页最多 5 个标签'), '规则行不得被当成标签')

  // 通用别名（pitfalls / troubleshooting / host-api）现在由基础层提供：合并后必须仍然可用，
  // 否则「两库都用 troubleshooting」这种跨库统一就断了。
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const merged = loadTaxonomy(store)
  for (const alias of ['pitfalls', 'troubleshooting', 'host-api']) {
    assert.ok(merged.aliases.has(alias), `${alias} 应能通过基础层解析出规范词`)
  }
})
