// integrity.test.mjs — 交付记录点名的信任保证，固化为回归测试
// 覆盖：① wiki_capture 跨源不覆盖（-N 避让）② 页面原子写（无 tmp 残留）
//      ③ L1 index-only 检索覆盖 dictionaries/tables ④ _system 不出现在任何知识面（pages/search/graph/export）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { mountTools } from './lib/tools.js'
import { retrieve } from './lib/retriever.js'
import { buildGraph, exportGraphHtml } from './lib/graph-engine.js'
import { rebuildIndex } from './lib/index-builder.js'

const EXEC = { deferContext() {}, concludeTurn() {} }
const NOW = '2026-09-12T00:00:00.000Z'

function makeVault(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-integrity-'))
  const store = new VaultStore(dir)
  store.ensure()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, store }
}

function tools(store) {
  const registered = []
  mountTools({ tools: { register: (def) => registered.push(def) } }, store)
  return (name) => registered.find((d) => d.name === name)
}

test('wiki_capture 跨源同 id 不覆盖，自动 -N 新建；同源重捕保留 created', async (t) => {
  const { store } = makeVault(t)
  const def = tools(store)('wiki_capture')
  // 既有页面来自另一个 source（模拟已入库文档）
  store.writePage({ id: 'same-title', title: 'Same Title', category: 'references', tags: [], source: 'docs/readme.md', confidence: 'extracted', created: NOW, updated: NOW, body: '原始内容' })

  const first = await def.execute({ title: 'Same Title', body: '捕获内容' }, EXEC)
  assert.match(first.page, /same-title-2\.md$/, '跨源应避让为 -2')
  assert.equal(store.readPage('same-title', 'references')?.body, '原始内容', '原页内容不得被覆盖')

  // 同源重捕：更新自己那页，保留 created，不再膨胀出 -3
  const again = await def.execute({ title: 'Same Title', body: '捕获内容 v2' }, EXEC)
  assert.match(again.page, /same-title-2\.md$/, '同源重捕应更新 -2 页而非新建 -3')
  assert.equal(store.readPage('same-title-2', 'references')?.body, '捕获内容 v2')
  assert.equal(store.readPage('same-title-2', 'references')?.created, store.readPage('same-title-2', 'references')?.created)
  assert.equal(store.readPage('same-title-3', 'references'), null, '不应出现 -3 页')
})

test('writePage 原子写：成功后目录里没有 .tmp 残留', (t) => {
  const { dir, store } = makeVault(t)
  store.writePage({ id: 'atomic', title: 'Atomic', category: 'concepts', tags: [], source: 'test', confidence: 'extracted', created: NOW, updated: NOW, body: 'ok' })
  const files = readdirSync(join(dir, '.wiki', 'concepts'))
  assert.ok(files.includes('atomic.md'), '页面应写入')
  assert.doesNotMatch(files.join(','), /\.tmp-/, '不应残留临时文件')
})

test('L1 index-only 检索覆盖 dictionaries 与 tables（此前会漏）', (t) => {
  const { store } = makeVault(t)
  store.writePage({ id: 'order-status', title: '订单状态枚举', category: 'dictionaries', tags: ['enum'], source: 'mine:enum:Status.java', confidence: 'extracted', created: NOW, updated: NOW, body: '订单状态码 `order-status` 映射说明。' })
  store.writePage({ id: 't-order', title: '订单表', category: 'tables', tags: ['table'], source: 'mine:db:schema.sql', confidence: 'extracted', created: NOW, updated: NOW, body: '订单表 `t-order` 列清单。' })
  rebuildIndex(store)

  const dict = retrieve(store, 'order-status', { mode: 'index-only' })
  assert.ok(dict.candidates.some((c) => c.id === 'order-status'), '字典页应在 index-only 模式被检索到')
  const tbl = retrieve(store, 't-order', { mode: 'index-only' })
  assert.ok(tbl.candidates.some((c) => c.id === 't-order'), '表结构页应在 index-only 模式被检索到')
})

test('wiki_ingest 写入前自动创建还原点（结构性保证，不再只靠提示词）', async (t) => {
  const { dir, store } = makeVault(t)
  const def = tools(store)('wiki_ingest')

  const res = await def.execute({
    source: 'test:batch',
    pages: [{ id: 'auto-ckpt', title: '自动还原点', category: 'concepts', body: '内容' }],
  }, EXEC)

  assert.equal(res.skipped, false)
  assert.ok(res.checkpointId, 'wiki_ingest 应返回写入前创建的还原点 id')
  assert.ok(existsSync(join(dir, '.wiki', '_system', 'checkpoints', res.checkpointId)), '还原点目录应存在')
})

test('_system 内部状态不出现在知识面（pages/graph/export；且被 Obsidian 忽略）', (t) => {
  const { dir, store } = makeVault(t)
  store.writePage({ id: 'visible', title: '可见页', category: 'concepts', tags: [], source: 'test', confidence: 'extracted', created: NOW, updated: NOW, body: '正常页' })
  // 造内部状态：会话归档 + 还原点
  const sess = join(dir, '.wiki', '_system', 'dsh-sessions')
  mkdirSync(sess, { recursive: true })
  writeFileSync(join(sess, 'digest.md'), '# 会话归档（不应进知识面）', 'utf8')
  writeFileSync(join(dir, '.wiki', '_system', 'tools', 'progress-enum.json'), '{"version":1,"kind":"enum","modules":{}}', 'utf8')

  const listed = store.listPagesReadonly().map((p) => p.id)
  assert.deepEqual(listed, ['visible'], 'listPages 只含正式分类页')
  assert.ok(!listed.some((id) => id.includes('digest')), '_system 内容不得出现在页面清单')

  const graph = buildGraph(store)
  assert.deepEqual(graph.nodes.map((n) => n.id), ['visible'], '图谱不得包含 _system 内容')
  const html = exportGraphHtml(graph)
  assert.doesNotMatch(html, /会话归档/, '导出图谱不得包含 _system 内容')

  const search = retrieve(store, '会话归档')
  assert.equal(search.candidates.length, 0, '检索不得命中 _system 归档')

  // Obsidian 侧：ensure() 已写入忽略规则
  assert.ok(existsSync(join(dir, '.wiki', '.obsidian', 'app.json')), '应生成 Obsidian 忽略配置')
})
