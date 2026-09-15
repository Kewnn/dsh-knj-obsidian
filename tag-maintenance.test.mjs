// tag-maintenance.test.mjs
// 标签维护：写页后主动报（推式检测） + 带还原点的别名归一化（只做确定性映射） + 遮蔽检查
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { lintVault } from './lib/lint.js'
import { parseTaxonomy, loadTaxonomy } from './lib/taxonomy.js'
import { listCheckpoints } from './lib/checkpoint.js'
import { mountTools } from './lib/tools.js'

const NOW = '2026-09-20T00:00:00.000Z'
const BASE = `## Type — 知识类型

- \`concept\` — 机制与语义
- \`pitfall\` — 实证过的坑
  - aliases: pitfalls, troubleshooting
- \`api-contract\` — 契约
  - aliases: host-api
`
// 故意重复登记基础层已有的 concept —— 这正是要被抓出来的「遮蔽」
const LOCAL_WITH_SHADOW = `## Domain — 领域

- \`react\` — React
  - aliases: reactjs

## Type — 知识类型

- \`concept\` — 本库重复登记了基础层已有的词
`

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-tagm-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}
const pg = (over) => ({ category: 'concepts', tags: [], source: 's', confidence: 'extracted', created: NOW, updated: NOW, body: '正文。', ...over })
function writeLocal(dir, text) {
  mkdirSync(join(dir, '.wiki', '_meta'), { recursive: true })
  writeFileSync(join(dir, '.wiki', '_meta', 'taxonomy.md'), text, 'utf8')
}
function mount(store) {
  const reg = []
  mountTools({ tools: { register: (d) => reg.push(d) } }, store)
  return (n) => reg.find((d) => d.name === n)
}
function snapshot(root) {
  const out = {}
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, f.name)
      if (f.isDirectory()) walk(full)
      else out[full.replace(root, '')] = readFileSync(full, 'utf8')
    }
  }
  walk(root)
  return out
}

// ─────────────────────────── 推式检测：写页后主动报

test('wiki_ingest 输出带 tagAudit（全库口径），render 附升表提示', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL_WITH_SHADOW)
  const ingest = mount(store)('wiki_ingest')
  const res = await ingest.execute({
    source: 'test:ingest',
    pages: [
      { id: 'p1', title: '页1', category: 'concepts', tags: ['react', 'concept'], body: '正文。' },
      { id: 'p2', title: '页2', category: 'concepts', tags: ['react', 'deep', 'deep2', 'deep3', 'deep4', 'deep5'], body: '正文。' },
    ],
  }, { signal: new AbortController().signal })

  assert.ok(res.tagAudit, 'ingest 应回报标签审计')
  assert.equal(typeof res.tagAudit.unknownCount, 'number')
  assert.ok(Array.isArray(res.tagAudit.promote))
  const text = ingest.output.render({}, res)[0].text
  assert.match(text, /标签/, `render 应含标签提示：${text}`)
})

test('wiki_capture 输出带 tagAudit；无有效词表时如实降级', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const capture = mount(store)('wiki_capture')
  const res = await capture.execute({ title: '捕获页', body: '正文。', category: 'references', tags: ['随便'] }, { signal: new AbortController().signal })
  assert.ok(res.tagAudit, 'capture 应回报标签审计')
  assert.equal(res.tagAudit.taxonomyPresent, true, '有基础层即有词表')
  const text = capture.output.render({}, res)[0].text
  assert.match(text, /标签/, `render 应含标签提示：${text}`)
})

// ─────────────────────────── 别名归一化：dryRun 零写入

test('wiki_normalize_tags dryRun：零字节改动', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL_WITH_SHADOW)
  store.writePage(pg({ id: 'a', title: '甲', tags: ['reactjs', 'pitfalls', 'host-api'] }))
  const normalize = mount(store)('wiki_normalize_tags')
  const before = snapshot(dir)
  const res = await normalize.execute({ dryRun: true }, { signal: new AbortController().signal })
  assert.deepEqual(snapshot(dir), before, 'dryRun 不得改动任何文件')
  assert.equal(res.dryRun, true)
  assert.equal(res.checkpointId, undefined, 'dryRun 不建还原点')
  assert.deepEqual(store.readPage('a', 'concepts').tags, ['reactjs', 'pitfalls', 'host-api'], '页上标签未被改')
})

// ─────────────────────────── 别名归一化：真实执行

test('wiki_normalize_tags：改写别名、去重、保序、只动标签，并建还原点', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL_WITH_SHADOW)
  // reactjs→react；pitfalls→pitfall；重复项去重后才能体现「去重」；未知词 mystery 必须原地不动
  store.writePage(pg({ id: 'keep', title: '保留摘要页', tags: ['pitfalls', 'reactjs', 'mystery'], summary: '人工撰写的摘要', tier: 'core' }))
  store.writePage(pg({ id: 'dup', title: '重复页', tags: ['pitfalls', 'troubleshooting', 'reactjs', 'react'] }))
  store.writePage(pg({ id: 'clean', title: '无需改', tags: ['concept'] }))

  const normalize = mount(store)('wiki_normalize_tags')
  // 写操作必须显式 opt-in：dryRun 默认为 true，所以真实执行要传 false
  const res = await normalize.execute({ dryRun: false }, { signal: new AbortController().signal })

  assert.ok(res.checkpointId, '真实执行必须建还原点')
  assert.ok(listCheckpoints(store).some((c) => c.id === res.checkpointId), '还原点应可在库里列出')
  assert.deepEqual(store.readPage('keep', 'concepts').tags, ['pitfall', 'react', 'mystery'], '别名改写 + 保序 + 未知词不动')
  assert.deepEqual(store.readPage('dup', 'concepts').tags, ['pitfall', 'react'], '两个别名合并到同一规范词后去重')
  assert.deepEqual(store.readPage('clean', 'concepts').tags, ['concept'], '无别名的页不动')
  assert.equal(res.changed.length, 2, `只应报 2 页改动：${JSON.stringify(res.changed.map((c) => c.id))}`)
  assert.ok(res.changed.every((c) => Array.isArray(c.from) && Array.isArray(c.to)), 'changed 应含 from/to')
  // 其它字段不被破坏
  const keep = store.readPage('keep', 'concepts')
  assert.equal(keep.summary, '人工撰写的摘要', '人工摘要不得被覆盖')
  assert.equal(keep.tier, 'core', 'tier 不得丢')
  assert.equal(keep.created, NOW, 'created 应保留')
  // 索引已重建
  assert.ok(readFileSync(join(dir, '.wiki', 'index.md'), 'utf8').includes('保留摘要页'), '索引应含该页')
})

test('wiki_normalize_tags 幂等：第二次执行为空改动', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL_WITH_SHADOW)
  store.writePage(pg({ id: 'x', title: '页', tags: ['pitfalls', 'host-api'] }))
  const normalize = mount(store)('wiki_normalize_tags')
  const first = await normalize.execute({ dryRun: false }, { signal: new AbortController().signal })
  assert.equal(first.changed.length, 1)
  const second = await normalize.execute({ dryRun: false }, { signal: new AbortController().signal })
  assert.equal(second.changed.length, 0, '第二次不应再有改动')
})

test('mapping：承载人工判断——收敛到规范词、或显式删除；并兜住手滑', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL_WITH_SHADOW)
  store.writePage(pg({ id: 'm1', title: '甲', tags: ['agents', 'orchestration', 'workflow'] }))
  const normalize = mount(store)('wiki_normalize_tags')

  // 试运行：先看清楚会变成什么，再决定
  const dry = await normalize.execute({ mapping: [{ from: 'agents', to: 'concept' }, { from: 'orchestration', to: 'concept' }, { from: 'workflow' }] }, { signal: new AbortController().signal })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.changed[0].to, ['concept'], `三个词应收敛成一个 concept（workflow 被删除）：${JSON.stringify(dry.changed[0].to)}`)
  assert.deepEqual(store.readPage('m1', 'concepts').tags, ['agents', 'orchestration', 'workflow'], '试运行不改盘')

  const real = await normalize.execute({ dryRun: false, mapping: [{ from: 'agents', to: 'concept' }, { from: 'orchestration', to: 'concept' }, { from: 'workflow' }] }, { signal: new AbortController().signal })
  assert.deepEqual(store.readPage('m1', 'concepts').tags, ['concept'], '别名之外的人工映射已生效，删除也生效')
  assert.deepEqual(real.stillUnknown, [], '目标是规范词，不该报残留')
})

test('mapping 目标词写错（非规范词）时如实报 stillUnknown；改空一页时报警', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL_WITH_SHADOW)
  store.writePage(pg({ id: 'bad', title: '甲', tags: ['whatever'] }))
  const normalize = mount(store)('wiki_normalize_tags')

  const res = await normalize.execute({ mapping: [{ from: 'whatever', to: 'concep' }] }, { signal: new AbortController().signal })
  assert.deepEqual(res.stillUnknown, ['concep'], `目标词写错应被报出：${JSON.stringify(res.stillUnknown)}`)

  // 把唯一标签删掉 → 该页变零标签，必须提醒
  const emptied = await normalize.execute({ mapping: [{ from: 'whatever' }] }, { signal: new AbortController().signal })
  assert.deepEqual(emptied.becameUntagged, ['bad'], `改空的页应被报出：${JSON.stringify(emptied.becameUntagged)}`)
  assert.match(normalize.output.render({}, emptied)[0].text, /一个标签都不剩/)
})

test('无改动时不动标签、也不建还原点', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  store.writePage(pg({ id: 'y', title: '页', tags: ['whatever'] }))
  const normalize = mount(store)('wiki_normalize_tags')
  const res = await normalize.execute({ dryRun: false }, { signal: new AbortController().signal })
  assert.equal(res.changed.length, 0)
  assert.ok(!res.checkpointId, '无改动时不必建还原点')
  assert.deepEqual(store.readPage('y', 'concepts').tags, ['whatever'])
})

test('0 改动时不得报「未能创建还原点」这类误报（实测踩到过）', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL_WITH_SHADOW)
  store.writePage(pg({ id: 'z', title: '页', tags: ['concept'] })) // 无别名 → 无需改写
  const normalize = mount(store)('wiki_normalize_tags')
  const res = await normalize.execute({ dryRun: false }, { signal: new AbortController().signal })
  assert.equal(res.changed.length, 0)
  const text = normalize.output.render({}, res)[0].text
  assert.doesNotMatch(text, /未能创建还原点|不可整批回滚/, `0 改动不该谈还原点：${text}`)
  assert.match(text, /无需改写/, `应说明无需改写：${text}`)
})

// ─────────────────────────── 遮蔽检查

test('shadowedBaseTags：报出库级重复登记基础层已有的词', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, LOCAL_WITH_SHADOW)
  const r = lintVault(store, { baseText: BASE }).tags
  assert.deepEqual(r.shadowedBaseTags, ['concept'], `实际 ${JSON.stringify(r.shadowedBaseTags)}`)
})

test('库级词表不重复登记基础层时 shadowedBaseTags 为空', (t) => {
  const tx = parseTaxonomy(`## Domain\n\n- \`react\` — React\n`, 'vault')
  assert.equal(tx.entries.some((e) => e.origin === 'vault'), true)
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLocal(dir, `## Domain\n\n- \`react\` — React\n`)
  const r = lintVault(store, { baseText: BASE }).tags
  assert.deepEqual(r.shadowedBaseTags, [])
})

test('本库 _meta/taxonomy.md 只应管 Domain/Project：删掉 Type 小节后 Type 轴仍齐（不被遮蔽）', (t) => {
  const file = 'D:\\workspace\\iobs_pro\\.wiki\\_meta\\taxonomy.md'
  if (!existsSync(file)) return t.skip('本机库没有词表文件，跳过')
  const local = parseTaxonomy(readFileSync(file, 'utf8'), 'vault')
  const localType = local.entries.filter((e) => e.section === 'Type')
  assert.equal(localType.length, 0, `库级词表不该重复登记 Type 轴，实际有：${localType.map((e) => e.tag)}`)
  // 删掉之后 Type 轴仍由基础层提供
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tx = loadTaxonomy(store)
  const baseType = tx.entries.filter((e) => e.section === 'Type').map((e) => e.tag)
  assert.equal(baseType.length, 8, `基础层应提供 8 个 Type 词，实际 ${baseType.length}`)
  assert.equal(loadTaxonomy(store).hasVaultFile, false)
})
