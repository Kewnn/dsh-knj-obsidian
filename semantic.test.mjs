// semantic.test.mjs
// qmd 语义检索层：M1 探测与降级（red 阶段——lib/semantic.js 尚不存在）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { retrieve } from './lib/retriever.js'
import { probeQmd, retrieveWithSemantic } from './lib/semantic.js'

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-semantic-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}

function seed(store) {
  const now = '2026-09-13T00:00:00.000Z'
  store.writePage({ id: 'rate-limiting', title: 'Rate Limiting 踩坑', category: 'concepts', tags: ['rate-limiting'], source: 's', confidence: 'extracted', created: now, updated: now, body: '429 处理要指数退避。' })
  store.writePage({ id: 'orders', title: '订单模块', category: 'projects', tags: ['orders'], source: 's', confidence: 'inferred', created: now, updated: now, body: '订单状态机：created → paid → shipped。' })
}

/** 假后端：模拟 qmd 的输出形态（路径 + 分数），不依赖真实二进制 */
function fakeBackend(hits) {
  return { name: 'fake', search: async () => hits }
}

function throwingBackend(message = 'boom') {
  return { name: 'fake', search: async () => { throw new Error(message) } }
}

test('probeQmd：二进制路径不存在时返回不可用并给出原因', async () => {
  const r = await probeQmd({ binaryPath: join(tmpdir(), 'definitely-not-a-real-qmd-binary-xyz') })
  assert.equal(r.available, false)
  assert.equal(typeof r.reason, 'string')
  assert.ok(r.reason.length > 0, '应给出可读原因')
})

test('语义关闭（semantic 未提供）时，结果与纯 retrieve 逐字段一致', async () => {
  const { dir, store } = makeVault()
  try {
    seed(store)
    const plain = retrieve(store, 'rate limiting')
    const withLayer = await retrieveWithSemantic(store, 'rate limiting', {})
    assert.deepEqual(withLayer, plain, '语义关闭时必须与现状逐字节一致')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('后端抛错时不抛出，结果降级为纯 L1–L4 且 strategy 标注不可用', async () => {
  const { dir, store } = makeVault()
  try {
    seed(store)
    const plain = retrieve(store, 'rate limiting')
    const r = await retrieveWithSemantic(store, 'rate limiting', { semantic: throwingBackend() })
    assert.deepEqual(r.candidates, plain.candidates, '降级后候选应与纯 retrieve 一致')
    assert.equal(r.strategy, plain.strategy, 'strategy 主体应保持原分层语义')
    assert.ok(r.semanticUnavailable, '应如实标注语义不可用')
    assert.match(r.semanticUnavailable.reason, /boom/, '原因应来自后端错误')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('后端的 _system/ 与 wiki-export/ 命中一律丢弃（不参与知识检索）', async () => {
  const { dir, store } = makeVault()
  try {
    seed(store)
    const r = await retrieveWithSemantic(store, '会话', {
      semantic: fakeBackend([
        { path: join(store.wikiRoot, '_system', 'dsh-sessions', 'sessions', 'x.md'), score: 0.9 },
        { path: join(store.wikiRoot, 'wiki-export', 'graph.json'), score: 0.8 },
        { path: join(store.wikiRoot, 'concepts', 'rate-limiting.md'), score: 0.7 },
      ]),
    })
    const ids = r.candidates.map((c) => c.id)
    assert.ok(!ids.some((id) => String(id).includes('x')), '_system 命中不得出现')
    assert.ok(!r.candidates.some((c) => c.page.includes('_system')), '_system 命中不得出现')
    assert.ok(!r.candidates.some((c) => c.page.includes('wiki-export')), 'wiki-export 命中不得出现')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('后端返回 vault 之外的路径一律丢弃', async () => {
  const { dir, store } = makeVault()
  try {
    seed(store)
    const r = await retrieveWithSemantic(store, '外部', {
      semantic: fakeBackend([
        { path: join(tmpdir(), 'outside-vault', 'concepts', 'evil.md'), score: 0.99 },
      ]),
    })
    assert.ok(!r.candidates.some((c) => String(c.id).includes('evil')), 'vault 外命中不得出现')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('语义层可用时命中标记 matchedBy=semantic，且不破坏既有候选', async () => {
  const { dir, store } = makeVault()
  try {
    seed(store)
    const plain = retrieve(store, 'rate limiting')
    const r = await retrieveWithSemantic(store, 'rate limiting', {
      semantic: fakeBackend([
        { path: join(store.wikiRoot, 'projects', 'orders.md'), score: 0.8, snippet: '订单状态机' },
      ]),
    })
    assert.ok(r.candidates.some((c) => c.id === 'orders' && c.matchedBy === 'semantic'), '语义命中应带 matchedBy=semantic')
    for (const c of plain.candidates) {
      assert.ok(r.candidates.some((x) => x.id === c.id), `既有候选 ${c.id} 不应因语义层消失`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 验收①：召回质量对照用例 —— 同义查询在纯关键词路径下必须搜不到，开启语义后必须命中
test('验收①：关键词零命中时，语义召回补上（对照断言）', async () => {
  const { dir, store } = makeVault()
  try {
    seed(store) // rate-limiting 页标题「Rate Limiting 踩坑」、正文「429 处理要指数退避。」
    const q = '接口被限流怎么办' // 与页面无任何字面交集
    const plain = retrieve(store, q)
    assert.equal(plain.candidates.length, 0, '前提：该查询在纯关键词路径下零命中')
    const r = await retrieveWithSemantic(store, q, {
      semantic: fakeBackend([{ path: join(store.wikiRoot, 'concepts', 'rate-limiting.md'), score: 0.91 }]),
    })
    assert.ok(
      r.candidates.some((c) => c.id === 'rate-limiting' && c.matchedBy === 'semantic'),
      '语义层应召回语义等价但字面无关的查询',
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 验收②：语义层开启但后端返回空 → 不引入 semanticUnavailable（空结果不是故障）
test('后端返回空数组时按正常无命中处理，不误报故障', async () => {
  const { dir, store } = makeVault()
  try {
    seed(store)
    const plain = retrieve(store, '接口被限流怎么办')
    const r = await retrieveWithSemantic(store, '接口被限流怎么办', { semantic: fakeBackend([]) })
    assert.deepEqual(r, plain, '空命中应与纯 retrieve 一致')
    assert.equal(r.semanticUnavailable, undefined, '空结果不得标记为语义不可用')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
