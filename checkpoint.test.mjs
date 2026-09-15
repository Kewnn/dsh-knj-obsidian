// checkpoint.test.mjs — 还原点（写前快照 + 恢复）先红后绿
// 设计：快照 = 七分类 .md + index.md + .manifest.json 拷贝到 <vault>/.wiki/_system/checkpoints/<ts>/
// 恢复 = 整库文件级回写；未知 id 拒绝；不碰 _system 其余内容（会话归档等）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { VaultStore } from './lib/vault-store.js'
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from './lib/checkpoint.js'
import { mountWikiRoutes } from './lib/routes.js'

const NOW = '2026-09-12T00:00:00.000Z'

function makeVault(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-checkpoint-'))
  const store = new VaultStore(dir)
  store.ensure()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, store }
}

function page(store, id, body, category = 'concepts') {
  store.writePage({ id, title: id, category, tags: [], source: 'test', confidence: 'extracted', created: NOW, updated: NOW, body })
}

test('创建还原点：拷贝全部页面 + index + manifest，返回 id 与页数', (t) => {
  const { dir, store } = makeVault(t)
  page(store, 'a', 'A 内容')
  page(store, 'b', 'B 内容', 'references')

  const cp = createCheckpoint(store)

  assert.ok(cp.id, '应返回还原点 id')
  assert.equal(cp.pageCount, 2)
  assert.ok(existsSync(join(dir, '.wiki', '_system', 'checkpoints', cp.id, 'concepts', 'a.md')), '页面应被拷贝')
  assert.ok(existsSync(join(dir, '.wiki', '_system', 'checkpoints', cp.id, '.manifest.json')), 'manifest 应被拷贝')
  assert.ok(existsSync(join(dir, '.wiki', '_system', 'checkpoints', cp.id, 'index.md')), 'index 应被拷贝')
})

test('恢复还原点：默认 merge 撤销修改但保留快照后新增页（不毁无关工作）', (t) => {
  const { store } = makeVault(t)
  page(store, 'a', 'A 原文')
  const cp = createCheckpoint(store)

  // 批次把 a 改坏；同时“另一个会话/agent”新建了 c（与本次回滚无关的正当产物）
  page(store, 'a', 'A 被污染')
  page(store, 'c', 'C 由其它会话新增', 'references')

  const result = restoreCheckpoint(store, cp.id) // 默认 merge

  assert.equal(result.mode, 'merge')
  assert.equal(result.ok, true)
  assert.equal(store.readPage('a', 'concepts')?.body, 'A 原文', '被改页面应恢复')
  assert.equal(store.readPage('c', 'references')?.body, 'C 由其它会话新增', '快照后新增页必须保留')
  assert.equal(result.keptNewer, 1, '应报告保留的快照后新页数')
})

test('恢复还原点：exact 模式整库回到快照（显式选择才删除快照后新页）', (t) => {
  const { store } = makeVault(t)
  page(store, 'a', 'A 原文')
  const cp = createCheckpoint(store)
  page(store, 'a', 'A 被污染')
  page(store, 'b', 'B 批次新增', 'references')

  const result = restoreCheckpoint(store, cp.id, 'exact')

  assert.equal(result.mode, 'exact')
  assert.equal(store.readPage('a', 'concepts')?.body, 'A 原文')
  assert.equal(store.readPage('b', 'references'), null, 'exact 模式应删除快照后新增页')
})

test('未知还原点 id 拒绝恢复；列表可枚举', (t) => {
  const { store } = makeVault(t)
  page(store, 'a', 'A')
  const cp = createCheckpoint(store)

  // 格式合法但不存在 → 404「不存在」；格式非法 → 400「非法」（见下一个用例）
  assert.throws(() => restoreCheckpoint(store, '2026-01-01T00-00-00-000Z'), /不存在/)
  const list = listCheckpoints(store)
  assert.ok(Array.isArray(list) && list.some((c) => c.id === cp.id), '列表应含刚创建的还原点')
})

test('还原点 id 路径穿越被拒绝（安全）', (t) => {
  const { store } = makeVault(t)
  page(store, 'a', 'A')
  const before = store.readPage('a', 'concepts')?.body
  for (const evil of ['../../evil', '..\\..\\evil', 'foo/bar', 'a-b-c', '2026-09-12T00-00-00-000Z;rm -rf /']) {
    assert.throws(() => restoreCheckpoint(store, evil), /非法还原点 id/, `应拒绝：${evil}`)
  }
  assert.equal(store.readPage('a', 'concepts')?.body, before, '穿越尝试不得改动库内容')
})

test('路由：GET /checkpoints 列表 + POST /checkpoint/restore 恢复（同源/JSON 守卫）', async (t) => {
  const { store } = makeVault(t)
  page(store, 'a', 'A 原文')
  const handlers = new Map()
  const host = { webServer: { register: (r) => { handlers.set(`${r.kind}:${r.path}`, r); return () => handlers.delete(`${r.kind}:${r.path}`) } } }
  mountWikiRoutes(host, store)

  const req = (path, { method = 'GET', headers = {}, body } = {}) => {
    const route = [...handlers.values()].find((h) => h.path === path.split('?')[0] || (h.kind === 'prefix' && path.startsWith(h.path)))
    assert.ok(route, `no handler for ${path}`)
    const request = new EventEmitter()
    request.url = path; request.method = method; request.headers = headers
    let out = ''; let status = 0
    const response = { setHeader: () => {}, writeHead: (c) => { status = c }, end: (c) => { out += c ?? '' } }
    const done = Promise.resolve(route.handler(request, response)).then(() => ({ status, json: JSON.parse(out || '{}') }))
    queueMicrotask(() => { if (body !== undefined) request.emit('data', Buffer.from(body)); request.emit('end') })
    return done
  }
  const POST = { 'content-type': 'application/json', origin: 'http://localhost:3080', host: 'localhost:3080' }

  const cp = createCheckpoint(store)
  page(store, 'a', 'A 被污染')

  const list = await req('/api/obsidian-wiki/checkpoints')
  assert.equal(list.status, 200)
  assert.ok(list.json.checkpoints.some((c) => c.id === cp.id))

  const restore = await req('/api/obsidian-wiki/checkpoint/restore', { method: 'POST', headers: POST, body: JSON.stringify({ id: cp.id }) })
  assert.equal(restore.status, 200, JSON.stringify(restore.json))
  assert.equal(restore.json.pageCount, 1)
  assert.equal(store.readPage('a', 'concepts')?.body, 'A 原文')

  const cross = await req('/api/obsidian-wiki/checkpoint/restore', { method: 'POST', headers: { ...POST, origin: 'http://evil.test' }, body: JSON.stringify({ id: cp.id }) })
  assert.equal(cross.status, 403)
})
