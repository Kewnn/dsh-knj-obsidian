// miss-log.test.mjs
// 检索未命中日志：把「agent 主动问了库、库却答不出来」的查询记下来。
//
// 为什么需要它：L1/检索层的静默是**设计正确**（无关任务不该提醒），所以"沉默"本身
// 不构成知识缺口信号。真正有价值的信号是——**agent 明确问了，但库里没有**。
// 这是两件事的答案来源：① 一周后"哪些主题是真缺知识"；② 命中率的原生埋点。
//
// 为什么不写进 vault：仓库有一条既有契约测试断言「wiki_query 零写入」，且"检索只读"
// 是插件的公开契约。日志因此落在插件状态目录 <DSH_HOME>/knj-obsidian/query-misses.jsonl。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordQueryMiss, missLogPath, missLogEnabled } from './lib/miss-log.js'

function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-obsidian-misslog-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

test('recordQueryMiss：追加一条 JSONL，字段齐全（可解析）', (t) => {
  const home = makeHome(t)
  recordQueryMiss({
    at: '2026-09-20T12:00:00.000Z',
    vaultRoot: 'D:\\workspace\\iobs_pro',
    workspace: 'iobs_pro',
    query: '限流算法 退避抖动',
    mode: 'auto',
    totalPages: 19,
    semanticTried: true,
  }, { home })

  const file = missLogPath(home)
  assert.ok(existsSync(file), '应创建日志文件')
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.query, '限流算法 退避抖动')
  assert.equal(entry.vaultRoot, 'D:\\workspace\\iobs_pro')
  assert.equal(entry.mode, 'auto')
  assert.equal(entry.totalPages, 19)
  assert.equal(entry.semanticTried, true)
  assert.equal(entry.at, '2026-09-20T12:00:00.000Z')
})

test('recordQueryMiss：追加而非覆盖，且以 vault 区分（跨工作区对比缺货情况）', (t) => {
  const home = makeHome(t)
  for (const [vault, query] of [['D:\\workspace\\iobs_pro', 'a'], ['D:\\dsh-knj\\dsh-knj-workflow', 'b']]) {
    recordQueryMiss({ at: '2026-09-20T12:00:00.000Z', vaultRoot: vault, query, mode: 'auto', totalPages: 1, semanticTried: false }, { home })
  }
  const lines = readFileSync(missLogPath(home), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2, '两条都要在')
  assert.deepEqual(lines.map((l) => JSON.parse(l).query), ['a', 'b'])
})

test('recordQueryMiss：超过上限时保留最近的（日志不能无限膨胀）', (t) => {
  const home = makeHome(t)
  for (let i = 1; i <= 5; i += 1) {
    recordQueryMiss({ at: '2026-09-20T12:00:00.000Z', vaultRoot: 'v', query: `q${i}`, mode: 'auto', totalPages: 0, semanticTried: false }, { home, maxEntries: 3 })
  }
  const lines = readFileSync(missLogPath(home), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 3, '上限 3')
  assert.deepEqual(lines.map((l) => JSON.parse(l).query), ['q3', 'q4', 'q5'], '保留最近的')
})

test('recordQueryMiss：写失败不得抛出（诊断日志不该影响检索）', (t) => {
  const home = makeHome(t)
  // 让 home 的父级是一个**文件**：mkdir 必然失败（ENOTDIR），实现必须吞掉
  const blocker = join(home, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  assert.doesNotThrow(() => {
    recordQueryMiss({ at: 'x', vaultRoot: 'v', query: 'q', mode: 'auto', totalPages: 0, semanticTried: false }, { home: join(blocker, 'sub') })
  })
})

test('开关：KNJ_OBSIDIAN_MISS_LOG=off 时关闭；默认开启', () => {
  assert.equal(missLogEnabled({}), true)
  assert.equal(missLogEnabled({ KNJ_OBSIDIAN_MISS_LOG: ' OFF ' }), false)
  assert.equal(missLogEnabled({ KNJ_OBSIDIAN_MISS_LOG: 'on' }), true)
})

test('missLogPath：落在插件状态目录（与 vaults.json 同级），不进 vault', (t) => {
  const home = makeHome(t)
  const p = missLogPath(home)
  assert.ok(p.includes('knj-obsidian'), '与 vaults.json 同处 knj-obsidian/')
  assert.ok(p.endsWith('query-misses.jsonl'))
  assert.ok(!p.includes('.wiki'), '绝不写进 vault')
})
