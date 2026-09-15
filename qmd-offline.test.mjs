// qmd-offline.test.mjs — 内网离线镜像清单的契约（清单必须能真的装出可用的语义检索依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const list = JSON.parse(readFileSync(join(ROOT, 'tools/qmd-offline/packages.json'), 'utf8'))
const byName = new Map(list.packages.map((entry) => [entry.name, entry]))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('离线清单：覆盖语义检索必需包（库 + 原生件 + 依赖）', () => {
  for (const required of [
    '@tobilu/qmd', 'node-llama-cpp', 'better-sqlite3', 'sqlite-vec',
    'fast-glob', 'picomatch', 'yaml', 'zod', 'web-tree-sitter',
  ]) {
    assert.ok(byName.has(required), `清单缺少必需包 ${required}`)
  }
})

test('离线清单：win32-x64 CPU 变体齐备，GPU 变体被标注且不会被 CPU 平台选中', () => {
  assert.equal(byName.get('@node-llama-cpp/win-x64')?.platform, 'win32-x64', 'CPU 版 llama 二进制')
  assert.equal(byName.get('sqlite-vec-windows-x64')?.platform, 'win32-x64', 'sqlite-vec 的 Windows 扩展')

  for (const gpu of ['@node-llama-cpp/win-x64-cuda', '@node-llama-cpp/win-x64-cuda-ext', '@node-llama-cpp/win-x64-vulkan']) {
    const entry = byName.get(gpu)
    assert.ok(entry, `清单应保留 GPU 变体 ${gpu}（供需要算力加速的人取用）`)
    assert.notEqual(entry.platform, 'win32-x64', `${gpu} 不得被 CPU 清单选中，否则内网要白搬几百 MB`)
  }
})

test('离线清单：普通依赖（非平台变体）对所有平台适用', () => {
  for (const shared of ['@tobilu/qmd', 'node-llama-cpp', 'better-sqlite3', 'yaml']) {
    assert.equal(byName.get(shared).platform, null, `${shared} 不应该是平台限定包`)
  }
})

test('离线清单版本与 package.json 的可选依赖声明一致（避免镜像与插件要求脱节）', () => {
  const declared = String(pkg.optionalDependencies?.['@tobilu/qmd'] ?? '').replace(/^[\^~]/, '')
  assert.equal(byName.get('@tobilu/qmd').version, declared, '镜像清单里的 qmd 版本必须满足插件声明')
})
