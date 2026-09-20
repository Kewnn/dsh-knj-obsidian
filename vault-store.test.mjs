// vault-store.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { renameWithRetry } from './lib/vault-store.js'

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-vault-'))
  return { dir, store: new VaultStore(dir) }
}

test('ensure 创建 .wiki 结构与 index.md（幂等）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  for (const c of ['concepts', 'entities', 'references', 'synthesis', 'projects', '_system']) {
    assert.ok(existsSync(join(dir, '.wiki', c)), `缺少目录 ${c}`)
  }
  assert.ok(existsSync(join(dir, '.wiki', 'index.md')))
  const index = readFileSync(join(dir, '.wiki', 'index.md'), 'utf8')
  assert.match(index, /概念页/)
  // 幂等：再调一次不抛错
  store.ensure()
})

test('writePage 写出 frontmatter + body，readPage 读回', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  const page = {
    id: 'rate-limiting', title: 'Rate Limiting 踩坑', category: 'concepts',
    tags: ['rate-limiting', 'api'], source: 'docs/notes.md', confidence: 'extracted',
    created: '2026-08-25T00:00:00.000Z', updated: '2026-08-25T00:00:00.000Z',
    body: '## 核心\n429 处理要指数退避。',
  }
  const res = store.writePage(page)
  assert.equal(res.created, true)
  const back = store.readPage('rate-limiting', 'concepts')
  assert.ok(back)
  assert.equal(back.title, 'Rate Limiting 踩坑')
  assert.equal(back.confidence, 'extracted')
  assert.match(back.body, /指数退避/)
  const raw = readFileSync(join(dir, '.wiki', 'concepts', 'rate-limiting.md'), 'utf8')
  assert.match(raw, /^---\n/)
  assert.match(raw, /confidence: extracted/)
})

test('writePage 覆盖已存在页返回 created=false', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  const page = { id: 'x', title: 'X', category: 'concepts', tags: [], source: 's', confidence: 'extracted', created: 'c', updated: 'u', body: 'b' }
  store.writePage(page)
  const again = store.writePage({ ...page, body: 'b2' })
  assert.equal(again.created, false)
  assert.equal(store.readPage('x', 'concepts').body, 'b2')
})

test('sha256 稳定且区分内容', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h1 = store.sha256('hello')
  const h2 = store.sha256('hello')
  const h3 = store.sha256('hello!')
  assert.equal(h1, h2)
  assert.notEqual(h1, h3)
  assert.match(h1, /^[0-9a-f]{64}$/)
})

test('manifest 记录与读取', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  const entry = { content_hash: 'abc123', last_ingested: '2026-08-25T00:00:00.000Z', pages_produced: ['a', 'b'] }
  store.updateManifest('docs/x.md', entry)
  const back = store.manifestEntry('docs/x.md')
  assert.deepEqual(back, entry)
  assert.equal(store.manifestEntry('docs/never.md'), undefined)
})

test('listPages 返回全库页面清单', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  store.writePage({ id: 'a', title: 'A', category: 'concepts', tags: [], source: 's', confidence: 'extracted', created: 'c', updated: 'u', body: 'b' })
  store.writePage({ id: 'b', title: 'B', category: 'entities', tags: [], source: 's', confidence: 'extracted', created: 'c', updated: 'u', body: 'b' })
  const pages = store.listPages()
  assert.equal(pages.length, 2)
  assert.ok(pages.some((p) => p.id === 'a' && p.category === 'concepts'))
})

test('writePage 拒绝越权 id（路径穿越防护），readPage 对非法 id 返回 null', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  assert.throws(() => store.writePage({
    id: '../../evil', title: 'Evil', category: 'concepts', tags: [], source: 's',
    confidence: 'extracted', created: 'c', updated: 'u', body: 'b',
  }), /invalid page id/)
  // 非法 id 不得触碰文件系统
  assert.equal(store.readPage('../../evil', 'concepts'), null)
  assert.ok(!existsSync(join(dir, '.wiki', 'concepts', 'evil.md')))
  assert.ok(!existsSync(join(dir, 'evil.md')))
})

test('writePage 接受含 CJK 的合法 id（中文标题页面），往返读写正常', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  const page = {
    id: '关于-429-的总结', title: '关于 429 的总结', category: 'concepts', tags: [],
    source: 'agent:capture', confidence: 'inferred',
    created: '2026-08-25T00:00:00.000Z', updated: '2026-08-25T00:00:00.000Z',
    body: '## 核心\n指数退避。',
  }
  const res = store.writePage(page)
  assert.equal(res.created, true)
  assert.ok(existsSync(join(dir, '.wiki', 'concepts', '关于-429-的总结.md')))
  const back = store.readPage('关于-429-的总结', 'concepts')
  assert.ok(back)
  assert.equal(back.id, '关于-429-的总结')
  assert.equal(back.title, '关于 429 的总结')
})

test('readPage 解析 CRLF 行尾的文件（Windows / git autocrlf）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  const raw = [
    '---', 'id: crlf-page', 'title: CRLF 页', 'category: concepts', 'tags: []',
    'source: docs/notes.md', 'confidence: extracted', 'created: c', 'updated: u', '---',
    '', '## 正文', '第一行', '第二行', '',
  ].join('\r\n')
  writeFileSync(join(dir, '.wiki', 'concepts', 'crlf-page.md'), raw, 'utf8')
  const back = store.readPage('crlf-page', 'concepts')
  assert.ok(back)
  assert.equal(back.title, 'CRLF 页')
  assert.equal(back.source, 'docs/notes.md')
  assert.match(back.body, /第一行/)
  assert.match(back.body, /第二行/)
})

test('readPage 解析带 UTF-8 BOM 的笔记（本机有 BOM 事故史，frontmatter 不得失效）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  const raw = [
    '---', 'id: bom-page', 'title: BOM 页', 'category: concepts', 'tags: []',
    'source: docs/bom.md', 'confidence: extracted', 'created: c', 'updated: u', '---',
    '', '带 BOM 的正文。',
  ].join('\n')
  writeFileSync(join(dir, '.wiki', 'concepts', 'bom-page.md'), '\uFEFF' + raw, 'utf8')
  const back = store.readPage('bom-page', 'concepts')
  assert.ok(back, 'BOM 开头的文件必须能解析出页面')
  assert.equal(back.id, 'bom-page')
  assert.equal(back.title, 'BOM 页')
  assert.match(back.body, /带 BOM 的正文/)
})

test('writePage 阻断 frontmatter 注入：title 含换行的伪造 id/category 行不得改写页面身份', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  const page = {
    id: 'honest-page', title: '正常标题\nid: evil-page\ncategory: projects', category: 'concepts',
    tags: ['a\nid: evil'], source: 'agent:x', confidence: 'extracted',
    created: 'c', updated: 'u', body: '正文。',
  }
  store.writePage(page)
  const raw = readFileSync(join(dir, '.wiki', 'concepts', 'honest-page.md'), 'utf8')
  // 威胁是「独立成行的伪造指令」：注入内容被拍平进 title 值后是惰性文本，但不得再自成一行
  assert.ok(!/^id: evil-page$/m.test(raw), '不得出现独立成行的注入 id 指令')
  assert.ok(!/^category: projects$/m.test(raw), '不得出现独立成行的注入 category 指令')
  const back = store.readPage('honest-page', 'concepts')
  assert.ok(back)
  assert.equal(back.id, 'honest-page', '页面 id 不得被注入行改写')
  assert.equal(back.category, 'concepts', '页面 category 不得被注入行改写')
  assert.equal(back.title, '正常标题 id: evil-page category: projects', '多行 title 拍平为单行')
})

test('readPage 反映磁盘外部编辑（mtime 失效：缓存不得返回旧内容）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.ensure()
  store.writePage({ id: 'cached', title: '旧标题', category: 'concepts', tags: [], source: 's', confidence: 'extracted', created: 'c', updated: 'u', body: '旧正文' })
  assert.equal(store.readPage('cached', 'concepts').body, '旧正文')
  assert.equal(store.readPage('cached', 'concepts').body, '旧正文') // 二次读取命中缓存路径
  const file = join(dir, '.wiki', 'concepts', 'cached.md')
  const newer = [
    '---', 'id: cached', 'title: 新标题', 'category: concepts', 'tags: []',
    'source: s', 'confidence: extracted', 'created: c', 'updated: u2', '---', '', '新正文',
  ].join('\n')
  writeFileSync(file, newer, 'utf8')
  // 显式推进 mtime，避免同刻度写入导致 mtimeMs 相同
  utimesSync(file, new Date(Date.now() / 1000 + 5), new Date(Date.now() / 1000 + 5))
  const back = store.readPage('cached', 'concepts')
  assert.ok(back)
  assert.equal(back.title, '新标题', '外部编辑后必须读到新内容')
  assert.equal(back.body, '新正文')
})

// ---------------------------------------------------------------------------
// 2026-09-20：Windows 上 tmp+rename 的瞬时 EPERM。
//
// 实测证据：全量并发跑测试时偶发（隔离跑 40 次全绿、全量第 1 次即复现）
//   EPERM: operation not permitted, rename '<…>.manifest.json.tmp-…' -> '.manifest.json'
//   at VaultStore.saveManifest → updateManifest
// 成因：目标是「刚创建的文件」，会被测试进程之外的东西瞬时持有句柄（Defender/索引器扫描），
// Windows 上 rename 覆盖已存在且被打开的文件就会 EPERM；Linux 的 rename 不会这样。
//
// 危害不止测试：writePage / saveRawPage / saveManifest 三处同样无重试——
// 生产里一次瞬时 EPERM 会让 wiki_capture / 页面保存直接抛错、那次操作丢失，
// 且看起来像"随机失败"。修法：可重试错误码 + 退避重试。
// ---------------------------------------------------------------------------

function errnoError(code) {
  const err = new Error(`${code}: mock rename failure`)
  err.code = code
  return err
}

test('renameWithRetry：可重试错误码退避重试后成功（模拟外部句柄瞬时占用）', () => {
  const sleeps = []
  let attempt = 0
  renameWithRetry('a', 'b', {
    attempts: 5,
    sleep: (ms) => sleeps.push(ms),
    rename: () => {
      attempt += 1
      if (attempt < 3) throw errnoError('EPERM')
    },
  })
  assert.equal(attempt, 3, '前两次 EPERM 应被重试')
  assert.deepEqual(sleeps, [5, 10], '退避应递增')
})

test('renameWithRetry：一直失败则抛原错误（不吞错、不无限重试）', () => {
  let attempt = 0
  assert.throws(
    () => renameWithRetry('a', 'b', {
      attempts: 3,
      sleep: () => {},
      rename: () => { attempt += 1; throw errnoError('EPERM') },
    }),
    (e) => e.code === 'EPERM',
  )
  assert.equal(attempt, 3, '重试次数必须封顶')
})

test('renameWithRetry：不可重试的错误码立即抛出（不做无意义退避）', () => {
  const sleeps = []
  let attempt = 0
  assert.throws(
    () => renameWithRetry('a', 'b', {
      attempts: 5,
      sleep: (ms) => sleeps.push(ms),
      rename: () => { attempt += 1; throw errnoError('ENOENT') },
    }),
    (e) => e.code === 'ENOENT',
  )
  assert.equal(attempt, 1, 'ENOENT 不是竞争，重试无意义')
  assert.deepEqual(sleeps, [])
})
