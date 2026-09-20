// trigger.test.mjs
// 任务级知识触发（L1）与回合级沉淀提醒（L5）的契约测试。
//
// 设计要点（2026-09-20）：
//  - 触发时机是「任务」而不是「每次工具调用」——用户明确否掉了挂在 edit/write 前（太频繁）。
//  - 匹配用「页面侧词表扫任务原文 + 绝对命中数」，不用 retrieve() 的占比打分：
//    任务句长、分母大，占比天然偏低（实测「怎么避免定时器在错误的时钟下工作」占比近 0）。
//  - 最高危失败模式是**自激循环**：本插件注入的提醒本身就是一条 user 消息，
//    若被当成新任务就会在下一 pre-step 再次触发。A3 用例把这条钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import {
  matchTaskPages, renderTaskReminder, renderCaptureReminder,
  latestDirectUserTask, foldTurnFacts, triggerEnabled, installTrigger,
} from './lib/trigger.js'

const NOW = '2026-08-25T00:00:00.000Z'

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-trigger-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}

function seed(store) {
  store.writePage({
    id: 'dsh-plugin-dev-pitfalls', title: 'DSH 插件开发踩坑手册', category: 'references',
    tags: ['dsh', 'pitfall'], source: 'agent:session-2026-08-27', confidence: 'extracted', created: NOW, updated: NOW,
    body: '## Cron 时区被强制成 UTC\n\ndsh-scheduler 的 cron 表达式按 UTC 解释。',
  })
  store.writePage({
    id: 'rate-limiting', title: 'Rate Limiting 踩坑', category: 'concepts',
    tags: ['rate-limiting', 'api'], source: 's', confidence: 'extracted', created: NOW, updated: NOW,
    body: '429 处理要指数退避。',
  })
}

/** user/message 事件：`source.kind === 'user'` 才是「直接用户任务」（权威判据见 dsh-doublecheck）。 */
function userEvent(seq, text, kind = 'user') {
  return { type: 'user/message', seq, data: { source: { kind }, content: [{ type: 'text', text }] } }
}
function toolCall(seq, name, args) {
  return { type: 'tool/call', seq, data: { name, arguments: JSON.stringify(args) } }
}

test('matchTaskPages：任务原话提到术语时召回相关页（页面侧词表扫文本，绝对命中数）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const hits = matchTaskPages(store, '帮我看看 dsh-scheduler 的 cron 时区问题，插件里定时任务没触发')
  const ids = hits.map((h) => h.id)
  assert.ok(ids.includes('dsh-plugin-dev-pitfalls'), '应召回踩坑手册')
  assert.ok(hits[0].hits.length > 0, '每条候选必须给出命中词（模型据此判断要不要读）')
  assert.ok(hits[0].source.length > 0, '候选需带 source 以便追溯')
})

test('matchTaskPages：无关任务必须完全静默（宁可不说是第一原则）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  assert.deepEqual(matchTaskPages(store, '帮我把这张图片的尺寸改成 800x600'), [])
  assert.deepEqual(matchTaskPages(store, '今天天气怎么样'), [])
})

test('matchTaskPages：空库 / 空任务文本不得抛错，返回空数组', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(matchTaskPages(store, 'dsh 插件的时区问题'), [])
  seed(store)
  assert.deepEqual(matchTaskPages(store, '   '), [])
})

test('matchTaskPages：结果有上限且按分降序（不把整库倒给模型）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)
  const hits = matchTaskPages(store, 'dsh 插件 dsh 插件 dsh 插件 pitfall 踩坑 时区 cron', { max: 1 })
  assert.equal(hits.length, 1)
})

test('A3 防自激循环：插件注入的消息绝不被当成新任务', (t) => {
  const events = [
    userEvent(1, '帮我修一下 dsh-scheduler 的时区问题'),
    // 本插件自己注入的提醒（形态对齐 createUserMessage({ source: { kind: 'plugin', ... } })）
    userEvent(2, '[知识库提示] 相关页面：dsh-plugin-dev-pitfalls', 'plugin'),
    // 宿主注入的 AGENTS.md 基线
    userEvent(3, '## 动手前先看知识库', 'agent-instructions'),
    userEvent(4, 'DSH file policy snapshot', 'runtime-context'),
  ]
  const latest = latestDirectUserTask(events)
  assert.equal(latest.seq, 1, '只有 source.kind === \'user\' 的才算任务')
  assert.match(latest.text, /时区问题/)
})

test('latestDirectUserTask：取最后一条直接用户消息；没有则返回 undefined', () => {
  assert.equal(latestDirectUserTask([]), undefined)
  assert.equal(latestDirectUserTask([userEvent(1, '', 'plugin')]), undefined)
  const events = [userEvent(1, '第一件事'), userEvent(2, '第二件事')]
  assert.equal(latestDirectUserTask(events).seq, 2)
})

test('L5 foldTurnFacts：读过库 + 改过库外文件 + 没写回库 → 三者齐备才提醒', (t) => {
  // 齐备
  const full = foldTurnFacts([
    toolCall(1, 'read', { file_path: 'D:\\workspace\\iobs_pro\\.wiki\\index.md' }),
    toolCall(2, 'edit', { file_path: 'D:\\workspace\\iobs_pro\\plugins\\x\\src\\a.ts' }),
  ])
  assert.deepEqual(full, { readVault: true, mutatedOutside: true, wroteVault: false })

  // 已写回 → 不再提醒
  const captured = foldTurnFacts([
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }),
    toolCall(2, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }),
    toolCall(3, 'wiki_capture', { title: 'x' }),
  ])
  assert.equal(captured.wroteVault, true)

  // 没读过库 → 不提醒
  const noRead = foldTurnFacts([toolCall(1, 'edit', { file_path: 'plugins\\x\\src\\a.ts' })])
  assert.equal(noRead.readVault, false)

  // 只改了库内的页面（属于知识维护本身）→ 不算「改了代码」
  const onlyVaultEdit = foldTurnFacts([
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }),
    toolCall(2, 'edit', { file_path: '.wiki\\references\\a.md' }),
  ])
  assert.equal(onlyVaultEdit.mutatedOutside, false)

  // 语义检索也算「用过库」
  const semantic = foldTurnFacts([toolCall(1, 'wiki_search_semantic', { query: 'x' }), toolCall(2, 'write', { file_path: 'plugins\\y.ts' })])
  assert.equal(semantic.readVault, true)
})

test('renderTaskReminder / renderCaptureReminder：文案含关键动作与可追溯信息', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const text = renderTaskReminder(matchTaskPages(store, 'dsh-scheduler 的 cron 时区问题'))
  assert.match(text, /dsh-plugin-dev-pitfalls/)
  assert.match(text, /忽略|无关/, '必须给模型「可以忽略」的出口，否则会把提醒当命令')
  assert.ok(!/\bMUST\b|必须读/.test(text), '不得写成命令式（它不是门禁）')

  const capture = renderCaptureReminder()
  assert.match(capture, /wiki_capture|wiki_ingest/)
})

test('A6 开关：KNJ_OBSIDIAN_TRIGGER=off 时整体关闭', () => {
  assert.equal(triggerEnabled({}), true)
  assert.equal(triggerEnabled({ KNJ_OBSIDIAN_TRIGGER: 'off' }), false)
  assert.equal(triggerEnabled({ KNJ_OBSIDIAN_TRIGGER: ' OFF ' }), false)
  assert.equal(triggerEnabled({ KNJ_OBSIDIAN_TRIGGER: 'on' }), true)
})

// ---------------------------------------------------------------------------
// 接线层（installTrigger）：用假 host / 假 agent 断言真实行为。
// 注入文本走注入点 deps.createNotice —— 默认实现会动态 import 宿主的 @deepseek-ai/dsh-llm，
// 在插件仓库里解析不到，因此测试必须注入（也正是它可注入的原因）。
// ---------------------------------------------------------------------------

function fakeHost() {
  const handlers = new Map()
  return { on: (event, handler) => handlers.set(event, handler), handlers }
}
function fakeAgent(events) {
  const injected = []
  return { injected, agent: { session: { snapshotEvents: () => events }, inject: (m) => injected.push(m) } }
}
const notice = (text) => ({ text })

async function preStep(host, agent) {
  return host.handlers.get('agent/pre-step')({ agent }, async () => ({ kind: 'ok' }))
}

test('A2 L1 接线：新任务命中 → 注入一次；同一任务后续步骤不再注入；无命中则完全静默', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text) => notice(text) })

  const events = [userEvent(1, '帮我看看 dsh-scheduler 的 cron 时区问题，插件里定时任务没触发')]
  const { agent, injected } = fakeAgent(events)

  await preStep(host, agent)
  assert.equal(injected.length, 1, '新任务命中应注入一次')
  assert.match(injected[0].text, /dsh-plugin-dev-pitfalls/)
  assert.match(injected[0].text, /忽略|无关/)

  // 同一任务的后续步骤（或多个 pre-step）不得重复注入
  await preStep(host, agent)
  await preStep(host, agent)
  assert.equal(injected.length, 1, '同一个任务只提醒一次')

  // 新任务但无关 → 静默
  events.push(userEvent(2, '帮我把这张图片的尺寸改成 800x600'))
  await preStep(host, agent)
  assert.equal(injected.length, 1, '无关任务必须静默')
})

test('A3 接线：只有插件/宿主注入的消息时不得触发（防自激循环）', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text) => notice(text) })

  const events = [
    userEvent(1, 'dsh 插件的 cron 时区问题', 'plugin'),
    userEvent(2, '## 动手前先看知识库', 'agent-instructions'),
  ]
  const { agent, injected } = fakeAgent(events)
  await preStep(host, agent)
  assert.equal(injected.length, 0, '非直用户消息绝不能当成任务（否则会自激循环）')
})

test('A5 接线：L5 三者齐备才提醒，且每会话只提醒一次', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text) => notice(text) })
  const events = [
    userEvent(1, 'dsh 插件的时区问题'),
    toolCall(2, 'read', { file_path: 'D:\\workspace\\iobs_pro\\.wiki\\index.md' }),
    toolCall(3, 'edit', { file_path: 'D:\\workspace\\iobs_pro\\plugins\\x\\src\\a.ts' }),
  ]
  const { agent, injected } = fakeAgent(events)
  const turnStopping = host.handlers.get('agent/turn-stopping')

  await turnStopping({ agent })
  assert.equal(injected.length, 1, '读过库 + 改了代码 + 没写回 → 提醒一次')
  assert.match(injected[0].text, /wiki_capture|wiki_ingest/)

  await turnStopping({ agent })
  assert.equal(injected.length, 1, '每会话最多提醒一次')
})

test('A5 接线：已写回库 / 只改库内页面 时不得提醒', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text) => notice(text) })
  const { agent, injected } = fakeAgent([
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }),
    toolCall(2, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }),
    toolCall(3, 'wiki_capture', { title: 'x' }),
  ])
  await host.handlers.get('agent/turn-stopping')({ agent })
  assert.equal(injected.length, 0, '已写回则不再提醒')
})

test('A6 接线：KNJ_OBSIDIAN_TRIGGER=off 时 L1/L5 都不注入', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const saved = process.env.KNJ_OBSIDIAN_TRIGGER
  process.env.KNJ_OBSIDIAN_TRIGGER = 'off'
  t.after(() => {
    if (saved === undefined) delete process.env.KNJ_OBSIDIAN_TRIGGER
    else process.env.KNJ_OBSIDIAN_TRIGGER = saved
  })

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text) => notice(text) })
  const { agent, injected } = fakeAgent([
    userEvent(1, 'dsh 插件的 cron 时区问题'),
    toolCall(2, 'read', { file_path: '.wiki\\index.md' }),
    toolCall(3, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }),
  ])
  await preStep(host, agent)
  await host.handlers.get('agent/turn-stopping')({ agent })
  assert.equal(injected.length, 0, '开关关闭时不得注入任何东西')
})

test('接线：provider 不可用 / 注入点抛错都不得打断主流程', async () => {
  const host = fakeHost()
  installTrigger(
    host,
    { currentReadonly: () => { throw new Error('vault 不可用') } },
    { createNotice: async () => { throw new Error('注入失败') } },
  )
  const { agent } = fakeAgent([userEvent(1, 'dsh 插件的 cron 时区问题')])
  const decision = await preStep(host, agent)
  assert.deepEqual(decision, { kind: 'ok' }, 'pre-step 必须原样返回 decision（触发层不阻断）')
})
