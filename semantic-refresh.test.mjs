// semantic-refresh.test.mjs — 语义索引刷新器：单飞 / 缺模型如实回报 / 阈值跳过 / 状态视图（注入假运行时，不碰真实 ~/.dsh/qmd）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRefresher, summarizeStatus, vaultRootOf } from './lib/semantic-refresh.js'

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-semantic-refresh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 假运行时：记录 update/embed/close 调用，status 可按调用次数变化（模拟嵌入过程中待嵌入数下降）。 */
function fakeRuntime({ modelPresent = true, store = true, statuses = [], failEmbed } = {}) {
  const calls = { update: 0, embed: 0, close: 0, status: 0 }
  let index = 0
  const fakeStore = {
    async update() { calls.update += 1; return { indexed: 1 } },
    async embed() {
      calls.embed += 1
      if (failEmbed) throw new Error(failEmbed)
      return { docsProcessed: 3, chunksEmbedded: 5 }
    },
    async getStatus() {
      calls.status += 1
      const value = statuses[Math.min(index, statuses.length - 1)] ?? { totalDocuments: 3, needsEmbedding: 0, hasVectorIndex: true }
      index += 1
      return value
    },
    async close() { calls.close += 1 },
  }
  return {
    calls,
    factory: async () => ({
      status: 'index-empty',
      modelPath: '/tmp/model.gguf',
      modelPresent,
      store: store ? fakeStore : null,
      index: { documents: 0, pendingEmbedding: 0, hasVectorIndex: false },
    }),
  }
}

test('summarizeStatus：按 qmd 真实字段判定（totalDocuments/needsEmbedding/hasVectorIndex）', () => {
  assert.deepEqual(summarizeStatus({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false }),
    { indexState: 'index-empty', documents: 0, pendingEmbedding: 0, hasVectorIndex: false })
  assert.deepEqual(summarizeStatus({ totalDocuments: 7, needsEmbedding: 3, hasVectorIndex: true }),
    { indexState: 'index-stale', documents: 7, pendingEmbedding: 3, hasVectorIndex: true })
  assert.deepEqual(summarizeStatus({ totalDocuments: 7, needsEmbedding: 0, hasVectorIndex: true }),
    { indexState: 'ready', documents: 7, pendingEmbedding: 0, hasVectorIndex: true })
  // 有文档但没有向量索引 → 陈旧（不是 ready）
  assert.equal(summarizeStatus({ totalDocuments: 5, needsEmbedding: 0, hasVectorIndex: false }).indexState, 'index-stale')
})

test('refreshNow：跑 update + embed，关库，记录结果与冷启动耗时', async (t) => {
  const dir = tmp(t)
  const runtime = fakeRuntime()
  const refresher = createRefresher({ vaultRoot: dir, runtimeFactory: runtime.factory })

  const result = await refresher.refreshNow()
  assert.equal(result.ok, true)
  assert.equal(result.documents, 3)
  assert.equal(result.chunks, 5)
  assert.deepEqual(runtime.calls, { update: 1, embed: 1, close: 1, status: 0 })

  const status = await refresher.status()
  assert.equal(status.available, true)
  assert.equal(status.modelPresent, true)
  assert.equal(status.refreshing, false)
  assert.equal(status.indexState, 'ready')
  assert.equal(status.documents, 3)
  assert.ok(typeof status.coldStartMs === 'number', '首次刷新后应记录冷启动耗时（UI 估算用）')
  assert.equal(status.lastRun.ok, true)
})

test('refreshNow：单飞——并发调用只跑一次底层刷新', async (t) => {
  const dir = tmp(t)
  const runtime = fakeRuntime()
  const refresher = createRefresher({ vaultRoot: dir, runtimeFactory: runtime.factory })

  const [a, b] = await Promise.all([refresher.refreshNow(), refresher.refreshNow()])
  assert.equal(a, b, '并发调用应复用同一个 promise')
  assert.equal(runtime.calls.update, 1, 'update 只跑一次')
  assert.equal(runtime.calls.embed, 1, 'embed 只跑一次')
  assert.equal(runtime.calls.close, 1)
})

test('refreshNow：模型缺失时如实回报且不动索引库（不 update/embed）', async (t) => {
  const dir = tmp(t)
  const runtime = fakeRuntime({ modelPresent: false, store: false })
  const refresher = createRefresher({ vaultRoot: dir, runtimeFactory: runtime.factory })

  const result = await refresher.refreshNow()
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /embeddinggemma-300M-Q8_0\.gguf/)
  assert.match(result.note ?? '', /不会自动下载/)
  assert.deepEqual(runtime.calls, { update: 0, embed: 0, close: 0, status: 0 })
})

test('refreshNow：库缺失时指向关键词检索兜底', async (t) => {
  const dir = tmp(t)
  const runtime = fakeRuntime({ store: false })
  const refresher = createRefresher({ vaultRoot: dir, runtimeFactory: runtime.factory })

  const result = await refresher.refreshNow()
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /wiki_query/)
})

test('refreshNow：embed 抛错变成 ok:false + note，不向上抛', async (t) => {
  const dir = tmp(t)
  const runtime = fakeRuntime({ failEmbed: '显存不足' })
  const refresher = createRefresher({ vaultRoot: dir, runtimeFactory: runtime.factory })

  const result = await refresher.refreshNow()
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /显存不足/)
  assert.equal(runtime.calls.close, 1, '失败也要关库（不留 sqlite 句柄）')
})

test('schedule：debounce 合并连续写入，只跑一次刷新', async (t) => {
  const dir = tmp(t)
  const runtime = fakeRuntime()
  const refresher = createRefresher({ vaultRoot: dir, runtimeFactory: runtime.factory, debounceMs: 20 })

  refresher.schedule('ingest')
  refresher.schedule('ingest')
  refresher.schedule('ingest')
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.equal(runtime.calls.embed, 1, '三次 schedule 合并成一次刷新')
  refresher.dispose()
})

test('schedule：待嵌入超过自动上限时跳过自动刷新并如实回报（不偷偷占 CPU）', async (t) => {
  const dir = tmp(t)
  const runtime = fakeRuntime({ statuses: [{ totalDocuments: 900, needsEmbedding: 900, hasVectorIndex: false }] })
  const refresher = createRefresher({ vaultRoot: dir, runtimeFactory: runtime.factory, debounceMs: 10, maxAutoDocs: 500 })

  refresher.schedule('ingest')
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.equal(runtime.calls.embed, 0, '超过上限不得自动跑')
  const status = await refresher.status()
  assert.match(status.lastRun?.note ?? '', /900 篇/)
  assert.match(status.lastRun?.note ?? '', /更新索引/, '应指向手动动作')
  refresher.dispose()
})

test('schedule：KNJ_OBSIDIAN_AUTO_REFRESH=off 时完全不排期', async (t) => {
  const dir = tmp(t)
  const runtime = fakeRuntime()
  const refresher = createRefresher({ vaultRoot: dir, runtimeFactory: runtime.factory, debounceMs: 10 })
  const saved = process.env.KNJ_OBSIDIAN_AUTO_REFRESH
  process.env.KNJ_OBSIDIAN_AUTO_REFRESH = 'off'
  t.after(() => {
    if (saved === undefined) delete process.env.KNJ_OBSIDIAN_AUTO_REFRESH
    else process.env.KNJ_OBSIDIAN_AUTO_REFRESH = saved
  })

  refresher.schedule('ingest')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(runtime.calls.embed, 0, '关掉自动刷新后不得自行运行')
  refresher.dispose()
})

test('vaultRootOf：由 .wiki 推出库根', () => {
  assert.equal(vaultRootOf({ wikiRoot: join('D:', 'proj', '.wiki') }), join('D:', 'proj'))
})
