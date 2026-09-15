// scored-retrieval.test.mjs
// item1（summary/tier 进 frontmatter + 可被检索）+ item2（候选打分与排序）
//
// 契约约束（不得违反）：
//  - 保留「前置层命中即停、不下探正文」的成本护栏 → retriever.test.mjs 的
//    strategy === 'title+tag' 断言必须继续成立，本文件不修改任何既有断言。
//  - 打分公式对齐 obsidian-wiki graphrag：精确标题 10 / 标题 6 / 标签 4 / 摘要 2，
//    + min(度 × 0.1, 2)，再 × tier 权重（core 1.3 / supporting 1.0 / peripheral 0.7）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { retrieve } from './lib/retriever.js'
import { rebuildIndex } from './lib/index-builder.js'
import { mountTools } from './lib/tools.js'

const NOW = '2026-09-20T00:00:00.000Z'

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-scored-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}

/** 统一的 writePage 参数，测试只关心差异字段。 */
function page(overrides) {
  return {
    category: 'concepts', tags: [], source: 's', confidence: 'extracted',
    created: NOW, updated: NOW, body: '正文占位。', ...overrides,
  }
}

// ---------------------------------------------------------------- item 1

test('item1: writePage 写出显式 summary/tier，且回读一致', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'explicit', title: '显式页', summary: '限流与退避策略', tier: 'core', body: '第一行。\n\n正文。' }))

  const raw = store.readRawPage('explicit', 'concepts')
  assert.match(raw, /^summary: 限流与退避策略$/m, 'summary 必须落到 frontmatter')
  assert.match(raw, /^tier: core$/m, 'tier 必须落到 frontmatter')

  const read = store.readPage('explicit', 'concepts')
  assert.equal(read.summary, '限流与退避策略')
  assert.equal(read.tier, 'core')
})

test('item1: 未给 summary 时从正文首行派生，tier 缺省为 supporting', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'derived', title: '派生页', body: '派生摘要行。\n\n更多正文。' }))

  const read = store.readPage('derived', 'concepts')
  assert.equal(read.summary, '派生摘要行。', '应从正文首行派生摘要（与 index.md 同一规则）')
  assert.equal(read.tier, 'supporting', 'tier 缺省为 supporting')
  assert.match(store.readRawPage('derived', 'concepts'), /^tier: supporting$/m)
})

test('item1: 无法识别的 tier 回退 supporting，不抛出', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, '.wiki', 'concepts', 'bogus.md'), [
    '---', 'id: bogus', 'title: 坏值页', 'category: concepts', 'tags: []',
    'source: s', 'confidence: extracted', 'created: ', 'updated: ', 'tier: 乱七八糟',
    '---', '', '正文。', '',
  ].join('\n'), 'utf8')

  const read = store.readPage('bogus', 'concepts')
  assert.equal(read.tier, 'supporting', '非法 tier 必须回退 supporting')
})

test('item1: 空正文时不写空的 summary 行（空值行会让字段回读消失）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'empty', title: '空页', body: '' }))

  const raw = store.readRawPage('empty', 'concepts')
  assert.doesNotMatch(raw, /^summary:/m, '摘要为空时不得写出空值 summary 行')
  assert.match(raw, /^tier: supporting$/m, 'tier 仍应写出（有确定缺省值）')
})

// ---------------------------------------------------------------- item 2

test('item2: summary 命中产出候选（字面不在标题/标签/正文里也能召回）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 正文刻意不含查询词：只有 summary 能命中，用于证明摘要层真的参与检索
  store.writePage(page({ id: 'sum-hit', title: '速率控制', body: '本节讨论速率控制。', summary: '限流与退避策略' }))

  const r = retrieve(store, '退避策略')
  const hit = r.candidates.find((c) => c.id === 'sum-hit')
  assert.ok(hit, 'summary 命中应产生候选')
  assert.equal(hit.matchedBy, 'summary')
  assert.match(r.strategy, /summary/, 'strategy 应如实标注摘要层参与')
})

test('item2: 候选按 score 降序，且每条都带数值 score', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'title-hit', title: '限流策略', body: '正文一。' }))
  store.writePage(page({ id: 'tag-hit', title: '别的主题', tags: ['限流策略'], body: '正文二。' }))

  const r = retrieve(store, '限流策略')
  assert.equal(r.candidates.length, 2)
  for (const c of r.candidates) assert.equal(typeof c.score, 'number', '每条候选都要有数值 score')
  assert.equal(r.candidates[0].id, 'title-hit', '标题命中（6）应排在标签命中（4）之前')
  assert.ok(r.candidates[0].score > r.candidates[1].score, '必须严格降序')
})

test('item2: tier 权重生效（core 排在 supporting 之前）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'aaa-supp', title: '同名标题', body: '正文甲。', tier: 'supporting' }))
  store.writePage(page({ id: 'zzz-core', title: '同名标题', body: '正文乙。', tier: 'core' }))

  const r = retrieve(store, '同名标题')
  assert.equal(r.candidates.length, 2)
  // id 字典序会把 aaa-supp 排前面；core 权重必须把它压下去，证明排序不是靠 id 兜底
  assert.equal(r.candidates[0].id, 'zzz-core', 'core 页应因 tier 权重排在 supporting 之前')
  assert.ok(r.candidates[0].score > r.candidates[1].score)
})

test('item2: 度加权生效（被引用更多的页排在前面）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'hub', title: 'Graph 甲', body: '正文甲。' }))
  store.writePage(page({ id: 'leaf', title: 'Graph 乙', body: '正文乙。' }))
  // 只给 hub 计入链；leaf 度为 0
  store.writePage(page({ id: 'linker', title: '链接者', body: '参考 [[hub]]。' }))

  const r = retrieve(store, 'graph')
  const ids = r.candidates.map((c) => c.id)
  assert.ok(ids.includes('hub') && ids.includes('leaf'))
  assert.equal(ids[0], 'hub', '入链更多的 hub 应排在 leaf 之前')
  assert.ok(r.candidates[0].score > r.candidates[1].score)
})

test('item2: index-only 模式同样带 score，且既有零候选语义不变', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'idx', title: '索引页', body: '正文。' }))
  writeFileSync(join(dir, '.wiki', 'index.md'), '# Wiki Index\n\n## 概念页\n- [[idx]] 索引页\n', 'utf8')

  const r = retrieve(store, 'idx', { mode: 'index-only' })
  const hit = r.candidates.find((c) => c.id === 'idx')
  assert.ok(hit, 'index-only 仍应命中')
  assert.equal(typeof hit.score, 'number', 'index-only 候选也要带数值 score')

  const none = retrieve(store, '绝不存在的词')
  assert.deepEqual(none.candidates, [], '无命中时仍返回空候选')
  assert.ok(none.strategy.length > 0, 'strategy 即使无命中也必须非空')
})

test('item2: 前置层护栏未被削弱（L2 命中时不做正文下探）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'front', title: '限流策略', body: '正文。' }))
  store.writePage(page({ id: 'bodyonly', title: '无关联标题', body: '这里也提到限流策略。' }))

  const r = retrieve(store, '限流策略')
  assert.equal(r.strategy, 'title+tag', '前置层命中即停的契约必须保持')
  assert.ok(!r.candidates.some((c) => c.id === 'bodyonly'), '护栏生效时不应把正文命中带回来')
})

test('item2: wiki_query 输出 schema 暴露 score/tier', () => {
  const registered = []
  const ctx = { tools: { register: (def) => { registered.push(def) } } }
  const store = new VaultStore(mkdtempSync(join(tmpdir(), 'dsh-obsidian-scored-tool-')))
  mountTools(ctx, store)
  const tool = registered.find((d) => d.name === 'wiki_query')
  assert.ok(tool, 'wiki_query 应注册')
  const itemProps = tool.output.schema.properties.candidates.items.properties
  assert.ok(itemProps.score, 'schema 应暴露 score')
  assert.ok(itemProps.tier, 'schema 应暴露 tier')
  assert.equal(tool.output.schema.additionalProperties, false, '不得放宽 additionalProperties')
})

// ---------------------------------------------------------------- 差分回归
// 下面两条是「改动前 vs 改动后」差分实验实测出来的召回缩水，必须长期钉住：
// 它们都不是单测能顺带覆盖的边角，而是新增的打分/前置层改动动了召回结构的后果。

test('回归: 查询词等于某页 id 时，不得因此跳过正文层', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 目标页的 id 恰好等于查询词，但它的标题里没有这个词（改动前它不会命中前置层）
  store.writePage(page({ id: 'auth-flow', title: '认证流程', body: '正文里并没有那个 id。' }))
  store.writePage(page({ id: 'referer-a', title: '甲', body: '参考 [[auth-flow]] 的实现。' }))
  store.writePage(page({ id: 'referer-b', title: '乙', body: '也见 auth-flow 一词。' }))

  const r = retrieve(store, 'auth-flow')
  const ids = r.candidates.map((c) => c.id)
  assert.ok(ids.includes('auth-flow'), 'id 精确匹配应作为候选（新增能力）')
  assert.ok(ids.includes('referer-b'), '必须仍下探正文层：不得因精确匹配提前返回')
  assert.notEqual(r.strategy, 'title+tag', '精确 id 匹配不属于既有护栏条件，不得挡住正文下探')
})

test('回归: 前置层命中页仍须充当 L4 种子，其邻居不得丢失', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 甲页同时满足：摘要含查询词 + 正文含查询词（正文层命中页，旧行为下也是 L3 命中页）
  store.writePage(page({ id: 'seed-page', title: '甲页', body: '这里提到限流策略。参考 [[neighbor]]。', summary: '人工摘要：限流策略' }))
  store.writePage(page({ id: 'neighbor', title: '乙页', body: '普通页。' }))

  const r = retrieve(store, '限流策略')
  const ids = r.candidates.map((c) => c.id)
  assert.ok(ids.includes('seed-page'), '命中页应在候选里')
  // 摘要层是「低于正文层」的回退层：正文也能命中时由正文层拥有该页（保住居中 snippet）
  assert.equal(r.candidates.find((c) => c.id === 'seed-page').matchedBy, 'body')
  assert.ok(ids.includes('neighbor'), '该命中页仍须作为 L4 种子，否则它的邻居会整体消失')
})

// ------------------------------------------------- 独立对抗复查（D1–D6）实测出的缺陷

test('D1: 正文首行含孤立 \\r 时，body 命中不得被改判成 summary', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 写入端会把孤立 \r 拍平成空格，于是磁盘上的摘要与 summarizeBody(正文) 不再相等。
  // 旧实现据此把机器派生的摘要误判成「人工撰写」，抢走了本该属于正文层的命中。
  store.writePage(page({ id: 'cr', title: '无关标题', body: '限流策略\r需要退避' }))

  const r = retrieve(store, '限流策略')
  const hit = r.candidates.find((c) => c.id === 'cr')
  assert.ok(hit, '应命中')
  assert.equal(hit.matchedBy, 'body', '正文命中必须保持 body（居中 snippet），不得改判 summary')
  assert.ok(!r.strategy.includes('summary'), `strategy 不得声称摘要层：${r.strategy}`)
})

test('D2: summary 含 U+2028/U+2029 时写出后仍能读回（显式与派生两条路径）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'u2028', title: '行分隔符显式', summary: '无害\u2028尾巴' }))
  assert.equal(store.readPage('u2028', 'concepts').summary, '无害 尾巴', 'U+2028 应拍平为空格且可回读')

  store.writePage(page({ id: 'u2029', title: '行分隔符派生', body: '第一行\u2029后半行\n\n第二段。' }))
  const derived = store.readPage('u2029', 'concepts').summary
  assert.ok(derived.includes('第一行') && derived.includes('后半行'), `派生摘要不得写出即丢：${JSON.stringify(derived)}`)
})

test('D3: index.md 与 frontmatter 摘要一致，且 index-only 能按摘要命中', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'authored', title: '速率控制', body: '正文第一行：与摘要无关的内容。', summary: '限流与退避策略' }))
  rebuildIndex(store)

  const idx = readFileSync(join(dir, '.wiki', 'index.md'), 'utf8')
  assert.ok(idx.includes('限流与退避策略'), 'index.md 描述应取 frontmatter 摘要')
  assert.ok(!idx.includes('与摘要无关的内容'), 'index.md 不得改用正文首行，两个派生工件必须一致')

  const r = retrieve(store, '退避', { mode: 'index-only' })
  assert.ok(r.candidates.some((c) => c.id === 'authored'), 'index-only 应能按 frontmatter 摘要检索到页面')
})

test('D4: 摘要命中候选的 snippet 受 200 字符上限约束', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'longsum', title: '无关标题', body: '正文不含那个词。', summary: '限流策略' + '甲'.repeat(3000) }))

  const r = retrieve(store, '限流策略')
  const hit = r.candidates.find((c) => c.id === 'longsum')
  assert.ok(hit, '应命中')
  assert.equal(hit.matchedBy, 'summary')
  assert.ok(hit.snippet.length <= 200, `snippet 应 ≤200，实际 ${hit.snippet.length}`)
})

test('D5: index-only 的 render 不得声称「按分降序」', async () => {
  const registered = []
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-render-'))
  const store = new VaultStore(dir)
  store.ensure()
  mountTools({ tools: { register: (d) => { registered.push(d) } } }, store)
  const tool = registered.find((d) => d.name === 'wiki_query')

  const value = { candidates: [{ id: 'x', score: 1.4 }], strategy: 'index-only', totalPages: 1 }
  const text = tool.output.render({ mode: 'index-only' }, value)[0].text
  assert.ok(!text.includes('按分降序'), `index-only 不得声称按分降序：${text}`)
  assert.match(text, /目录顺序/)
  const autoText = tool.output.render({ mode: 'auto' }, value)[0].text
  assert.match(autoText, /按分降序/, `auto 应说明按分降序：${autoText}`)
  rmSync(dir, { recursive: true, force: true })
})

test('D6: 重写页面不得把人工摘要换成正文派生值；派生摘要则须随正文刷新', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(page({ id: 'keep', title: '保留摘要', body: '正文第一行。', summary: '人工撰写：限流与退避' }))
  // 模拟 wiki_ingest 重写同一页（调用方不传 summary）
  store.writePage(page({ id: 'keep', title: '保留摘要', body: '正文第一行。' }))
  assert.equal(store.readPage('keep', 'concepts').summary, '人工撰写：限流与退避', '人工摘要不得被重派生覆盖')

  store.writePage(page({ id: 'derived', title: '派生摘要', body: '旧首行。' }))
  assert.equal(store.readPage('derived', 'concepts').summary, '旧首行。')
  store.writePage(page({ id: 'derived', title: '派生摘要', body: '新首行。' }))
  assert.equal(store.readPage('derived', 'concepts').summary, '新首行。', '派生摘要必须跟着正文走')
})
