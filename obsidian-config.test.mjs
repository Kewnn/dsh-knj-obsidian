// obsidian-config.test.mjs — .wiki 作为 Obsidian vault 打开时的噪声隔离（先红后绿）
// ensure() 应写入 .obsidian/app.json 的 userIgnoreFilters，排除：
//   _system/（会话归档与内部运行数据）、_raw/（废弃区）、wiki-export/（导出产物）、.manifest.json（内部索引）
// 且不得覆盖用户已有的 app.json 自定义设置（只做并集合并）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'

function makeVault(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-cfg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, store: new VaultStore(dir) }
}

test('ensure 写入 .obsidian/app.json 的忽略列表（_system/_raw/wiki-export/.manifest.json）', (t) => {
  const { dir, store } = makeVault(t)
  store.ensure()

  const cfg = join(dir, '.wiki', '.obsidian', 'app.json')
  assert.ok(existsSync(cfg), '应生成 .obsidian/app.json')
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'))
  const filters = parsed.userIgnoreFilters ?? []
  for (const f of ['_system/', '_raw/', 'wiki-export/', '.manifest.json']) {
    assert.ok(filters.includes(f), `忽略列表应含 ${f}（实际：${JSON.stringify(filters)}）`)
  }
})

test('已存在的 app.json 不被覆盖，忽略项做并集合并', (t) => {
  const { dir, store } = makeVault(t)
  const cfgDir = join(dir, '.wiki', '.obsidian')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'app.json'), JSON.stringify({ userIgnoreFilters: ['my-notes/'], showUnsupportedFiles: true }, null, 2), 'utf8')

  store.ensure()

  const parsed = JSON.parse(readFileSync(join(cfgDir, 'app.json'), 'utf8'))
  assert.equal(parsed.showUnsupportedFiles, true, '用户自定义字段应保留')
  assert.ok(parsed.userIgnoreFilters.includes('my-notes/'), '用户自定义忽略项应保留')
  assert.ok(parsed.userIgnoreFilters.includes('_system/'), '应并入内部忽略项')
})

test('ensure 幂等：重复调用不破坏 app.json', (t) => {
  const { dir, store } = makeVault(t)
  store.ensure()
  const cfg = join(dir, '.wiki', '.obsidian', 'app.json')
  const first = readFileSync(cfg, 'utf8')
  store.ensure()
  assert.equal(readFileSync(cfg, 'utf8'), first, '重复 ensure 应保持字节一致')
})
