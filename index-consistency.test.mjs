// index-consistency.test.mjs
// 索引一致性：页面写入了但 index.md / L1 检索看不到 —— 三处维护漏洞的回归测试
//   1) wiki_capture 不重建索引（实测曾有一个 capture 页滞后 12 天不可检索）
//   2) POST /page 全文保存不重建索引
//   3) rebuildIndex 行序依赖 readdir 枚举顺序（不可复现）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { rebuildIndex } from './lib/index-builder.js'
import { mountTools } from './lib/tools.js'
import { mountWikiRoutes } from './lib/routes.js'

const NOW = '2026-09-20T00:00:00.000Z'

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-idx-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}

function mount(store) {
  const registered = []
  mountTools({ tools: { register: (d) => { registered.push(d) } } }, store)
  return (name) => registered.find((d) => d.name === name)
}

const idxPath = (dir) => join(dir, '.wiki', 'index.md')
const idsInIndex = (dir) =>
  (readFileSync(idxPath(dir), 'utf8').match(/^- \[\[([^\]]+)\]\]/gm) ?? [])
    .map((l) => l.replace(/^- \[\[|\]\]$/g, ''))

// ─────────────────────────────────── 1. wiki_capture 必须重建索引
test('回归: wiki_capture 写入后 index.md 立即包含该页', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tool = mount(store)('wiki_capture')

  // 先建一页并重建一次索引作为基线
  await tool.execute({ title: '基线页', body: '基线正文。', category: 'references' }, { signal: new AbortController().signal })
  const before = idsInIndex(dir)
  assert.ok(before.length >= 1, `基线索引应有内容：${JSON.stringify(before)}`)

  // 再捕获一页：不重建索引的话这页在 index.md 里看不到 → L1/index-only 检索不可见
  const res = await tool.execute(
    { title: '捕获的新页', body: '这条知识只应存在于捕获页里。', category: 'references' },
    { signal: new AbortController().signal },
  )
  const capturedId = res.page.replace(/^references\//, '').replace(/\.md$/, '')
  assert.ok(idsInIndex(dir).includes(capturedId), `capture 后 index.md 应含 ${capturedId}，实际=${JSON.stringify(idsInIndex(dir))}`)
})

// ─────────────────────────────────── 2. wiki_capture 支持 tags
test('wiki_capture 接受 tags 并落盘；空串被过滤，非字符串由工具 schema 拒绝', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tool = mount(store)('wiki_capture')
  const sig = { signal: new AbortController().signal }

  const withTags = await tool.execute({ title: '带标签页', body: '正文。', category: 'references', tags: ['dsh', '  sessions  ', ''] }, sig)
  const id = withTags.page.replace(/^references\//, '').replace(/\.md$/, '')
  assert.deepEqual(store.readPage(id, 'references').tags, ['dsh', 'sessions'], '标签去空白保留，空串被过滤')

  const noTags = await tool.execute({ title: '无标签页', body: '正文。', category: 'references' }, sig)
  const id2 = noTags.page.replace(/^references\//, '').replace(/\.md$/, '')
  assert.deepEqual(store.readPage(id2, 'references').tags, [], '不传 tags 时仍为空数组（不回归）')

  // 非字符串元素由 dsh-tools 的参数校验拦下（schema items.type=string），根本到不了 execute——
  // 这条断言把「谁负责校验」钉住，避免以后误以为靠 execute 里的过滤兜底。
  await assert.rejects(
    tool.execute({ title: '坏标签页', body: '正文。', category: 'references', tags: ['ok', 42] }, sig),
    (e) => e.code === 'INVALID_ARGS' && /tags\[1\]/.test(JSON.stringify(e.violations ?? [])),
    '非字符串标签应由工具参数校验拒绝',
  )
})

// ─────────────────────────────────── 3. POST /page 必须重建索引
function makeHost() {
  const handlers = new Map()
  return {
    handlers,
    host: { webServer: { register: (route) => { handlers.set(`${route.kind}:${route.path}`, route); return () => handlers.delete(`${route.kind}:${route.path}`) } } },
  }
}

function req(handlers, path, { method = 'GET', body } = {}) {
  const route = [...handlers.values()].find((h) => {
    const p = path.split('?')[0]
    return h.path === p || (h.kind === 'prefix' && p.startsWith(h.path))
  })
  assert.ok(route, `no handler for ${path}`)
  const url = new URL(`http://localhost${path}`)
  const request = new EventEmitter()
  request.url = url.pathname + url.search
  request.method = method
  request.resume = () => {}
  // isSameOrigin 要求 host 存在且 origin/referer 的 host 与之相等
  request.headers = { host: 'localhost:3080', origin: 'http://localhost:3080', 'content-type': 'application/json' }
  let out = ''
  const response = { setHeader: () => {}, writeHead: () => {}, end: (c) => { out += c ?? '' } }
  const done = Promise.resolve(route.handler(request, response)).then(() => JSON.parse(out || '{}'))
  setImmediate(() => {
    if (body !== undefined) request.emit('data', Buffer.from(body, 'utf8'))
    request.emit('end')
  })
  return done
}

test('回归: POST /page 全文保存后 index.md 与页面同步', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage({ id: 'edited', title: '旧标题', category: 'concepts', tags: [], source: 's', confidence: 'extracted', created: NOW, updated: NOW, body: '正文。' })
  rebuildIndex(store)
  assert.ok(readFileSync(idxPath(dir), 'utf8').includes('旧标题'), '前置：索引里是旧标题')

  const { host, handlers } = makeHost()
  mountWikiRoutes(host, store)
  const raw = [
    '---', 'id: edited', 'title: 新标题', 'category: concepts', 'tags: [x]',
    'summary: 换过摘要', 'tier: core', 'source: s', 'confidence: extracted',
    'created: ' + NOW, 'updated: ' + NOW, '---', '', '正文。', '',
  ].join('\n')
  const res = await req(handlers, '/api/obsidian-wiki/page?id=edited&category=concepts', { method: 'POST', body: JSON.stringify({ raw }) })
  assert.ok(!res.error, `保存应成功：${JSON.stringify(res)}`)

  const idx = readFileSync(idxPath(dir), 'utf8')
  assert.ok(idx.includes('新标题'), `index.md 应跟随标题变化：${idx}`)
  assert.ok(!idx.includes('旧标题'), 'index.md 不应残留旧标题')
  assert.ok(idx.includes('换过摘要'), 'index.md 描述应取自新的 frontmatter summary')
})

// ─────────────────────────────────── 4. rebuildIndex 行序确定性
test('回归: rebuildIndex 行序按 id 升序且与写入顺序无关（含 CJK id）', (t) => {
  const dirs = []
  const run = (order) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-idx-sort-'))
    dirs.push(dir)
    const store = new VaultStore(dir)
    store.ensure()
    for (const id of order) {
      store.writePage({ id, title: `标题-${id}`, category: 'concepts', tags: [], source: 's', confidence: 'extracted', created: NOW, updated: NOW, body: '正文。' })
    }
    rebuildIndex(store)
    return idsInIndex(dir)
  }
  try {
    const a = run(['zeta', 'alpha', '中文页'])
    const b = run(['中文页', 'zeta', 'alpha'])
    // 码位升序：ASCII 小写 < CJK
    assert.deepEqual(a, ['alpha', 'zeta', '中文页'], `应按 id 码位升序：${JSON.stringify(a)}`)
    assert.deepEqual(a, b, '不同写入顺序必须产出同一份 index.md（否则索引不可复现）')
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  }
})

test('空库 rebuildIndex 仍写出全部小节且 pageCount=0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-idx-empty-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new VaultStore(dir)
  const r = rebuildIndex(store)
  assert.equal(r.pageCount, 0)
  const idx = readFileSync(join(dir, '.wiki', 'index.md'), 'utf8')
  for (const section of ['## 概念页', '## 实体页', '## 字典', '## 数据结构', '## 参考资料', '## 综合', '## 项目知识']) {
    assert.ok(idx.includes(section), `空库 index.md 应含 ${section}`)
  }
  assert.ok(existsSync(join(dir, '.wiki', 'index.md')))
})
