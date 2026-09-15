// routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { mountWikiRoutes } from './lib/routes.js'

/** 最小 webServer 假实现：捕获注册的 route（含 kind/path，供 req 做前缀匹配），供测试直接调用 */
function makeHost() {
  const handlers = new Map()
  const host = {
    webServer: {
      register: (route) => {
        handlers.set(`${route.kind}:${route.path}`, route)
        return () => handlers.delete(`${route.kind}:${route.path}`)
      },
    },
  }
  return { host, handlers }
}

function req(handlers, path, method = 'GET') {
  const route = [...handlers.values()].find((h) => {
    const p = path.split('?')[0]
    return h.path === p || (h.kind === 'prefix' && p.startsWith(h.path))
  })
  assert.ok(route, `no handler for ${path}`)
  const handler = route.handler
  return new Promise((resolve, reject) => {
    const url = new URL(`http://localhost${path}`)
    const request = { url: url.pathname + url.search, method }
    let body = ''
    const response = {
      setHeader: () => {},
      writeHead: () => {},
      end: (chunk) => { body += chunk ?? '' },
    }
    Promise.resolve(handler(request, response)).then(() => resolve(JSON.parse(body || '{}'))).catch(reject)
  })
}

const NOW = '2026-08-26T00:00:00.000Z'

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-routes-'))
  const store = new VaultStore(dir)
  store.ensure()
  store.writePage({ id: 'rate-limiting', title: 'Rate Limiting 踩坑', category: 'concepts', tags: ['api'], source: 's', confidence: 'extracted', created: NOW, updated: NOW, body: '429 指数退避。参考 [[orders]]。' })
  store.writePage({ id: 'orders', title: '订单', category: 'projects', tags: [], source: 's', confidence: 'inferred', created: NOW, updated: NOW, body: '订单流程。' })
  return { dir, store }
}

test('GET /pages 返回页面摘要列表', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  mountWikiRoutes(host, store)
  const result = await req(handlers, '/api/obsidian-wiki/pages')
  assert.equal(result.total, 2)
  assert.ok(result.pages.some((p) => p.id === 'rate-limiting' && p.category === 'concepts'))
  assert.equal(result.pages[0].confidence, 'extracted')
})

test('素材 API 已移除，避免系统会话归档进入任何素材链路', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  mountWikiRoutes(host, store)
  const result = await req(handlers, '/api/obsidian-wiki/materials')
  assert.equal(result.error, 'not found')
})

test('GET /page 返回单页内容', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  mountWikiRoutes(host, store)
  const result = await req(handlers, '/api/obsidian-wiki/page?id=orders&category=projects')
  assert.equal(result.page.id, 'orders')
  assert.equal(result.page.title, '订单')
  assert.ok(result.page.body.includes('订单流程'))
})

test('GET /page 未知页返回 error', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  mountWikiRoutes(host, store)
  const result = await req(handlers, '/api/obsidian-wiki/page?id=ghost&category=concepts')
  assert.ok(result.error)
})

test('GET /search 复用 retrieve 内核', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  mountWikiRoutes(host, store)
  const result = await req(handlers, '/api/obsidian-wiki/search?q=rate%20limiting')
  assert.ok(result.candidates.some((c) => c.id === 'rate-limiting'))
  assert.ok(result.strategy.length > 0)
})

test('GET /graph 复用 buildGraph 内核', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  mountWikiRoutes(host, store)
  const result = await req(handlers, '/api/obsidian-wiki/graph')
  assert.equal(result.nodes.length, 2)
  assert.ok(result.edges.some((e) => e.source === 'rate-limiting' && e.target === 'orders'))
  assert.equal(result.pageCount, 2)
})

test('GET /lint 返回健康报告', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  mountWikiRoutes(host, store)
  const result = await req(handlers, '/api/obsidian-wiki/lint')
  assert.equal(result.pageCount, 2)
  assert.ok(Array.isArray(result.orphans))
})

// ---- v8 语义检索：状态 / 手动刷新（注入假刷新器，测试不碰真实 ~/.dsh/qmd） ----

function fakeRefresher(overrides = {}) {
  const state = { refreshCalls: 0, refreshing: false }
  return {
    state,
    refresher: {
      status: async () => ({
        available: true, modelPresent: true, indexState: 'ready', documents: 7,
        pendingEmbedding: 0, hasVectorIndex: true, refreshing: state.refreshing, ...overrides.status,
      }),
      refreshNow: async () => {
        state.refreshCalls += 1
        state.refreshing = true
        return { ok: true, at: '2026-09-14T00:00:00.000Z', documents: 7, chunks: 9, durationMs: 1234 }
      },
    },
  }
}

test('GET /semantic-status 返回语义索引状态，并按当前库根取刷新器', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  const asked = []
  const { refresher } = fakeRefresher()
  mountWikiRoutes(host, store, { refresherFor: (root) => { asked.push(root); return refresher } })

  const result = await req(handlers, '/api/obsidian-wiki/semantic-status')
  assert.equal(result.available, true)
  assert.equal(result.indexState, 'ready')
  assert.equal(result.documents, 7)
  assert.deepEqual(asked, [dir], '刷新器应按库根（.wiki 的父目录）取')
})

test('POST /semantic-update 后台启动刷新（202），不阻塞到刷新结束', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  const { refresher, state } = fakeRefresher()
  mountWikiRoutes(host, store, { refresherFor: () => refresher })

  const result = await req(handlers, '/api/obsidian-wiki/semantic-update', 'POST')
  assert.equal(result.started, true)
  assert.equal(result.running, true, '立刻返回时就应报告「进行中」，进度由 status 轮询')
  assert.equal(state.refreshCalls, 1)
})

test('POST /semantic-update 已在刷新时不重复排队（单飞）', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  const { refresher, state } = fakeRefresher()
  state.refreshing = true
  mountWikiRoutes(host, store, { refresherFor: () => refresher })

  const result = await req(handlers, '/api/obsidian-wiki/semantic-update', 'POST')
  assert.equal(result.started, false)
  assert.equal(result.running, true)
  assert.equal(state.refreshCalls, 0, '已在刷新不得再触发一次')
})

test('GET /semantic-update 不是合法方法（405），语义状态端点只读', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { host, handlers } = makeHost()
  const { refresher } = fakeRefresher()
  mountWikiRoutes(host, store, { refresherFor: () => refresher })

  const result = await req(handlers, '/api/obsidian-wiki/semantic-update', 'GET')
  assert.equal(result.error, 'method not allowed')
})
