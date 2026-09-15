// wiki-distill-extractor.test.mjs — 把 wiki-distill 提取器自测纳入主套件（node --test *.test.mjs）
// 提取器是随包分发的 .cjs + 自带断言运行器；这里包一层，任何断言失败都让主套件变红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

test('wiki-distill 提取器自测全绿（含单会话过滤 sessionIncluded）', () => {
  const script = join(import.meta.dirname, 'wiki-distill', 'extract-dsh-sessions.test.cjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.match(out, /sessionIncluded/, '应跑含单会话过滤的用例')
  const failed = /(\d+) failed/.exec(out)
  assert.ok(failed, '自测应输出汇总行')
  assert.equal(Number(failed[1]), 0, `提取器自测不应有失败：\n${out}`)
})
