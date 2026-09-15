// tools/measure-semantic.mjs — 量「首次索引」的真实成本，用于决定是否需要进度上报 / 分批。
//
// 用法：
//   node tools/measure-semantic.mjs real [--vault D:/workspace/iobs_pro]   # 真实库（会写入生产索引 ~/.dsh/qmd/index.sqlite）
//   node tools/measure-semantic.mjs synthetic [--pages 300]                # 合成规模（临时 home + 硬链接模型，跑完清理）
//
// 输出：每阶段的耗时、按篇/按块的平均耗时，以及 500/2000 篇的外推。
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const mode = argv[0] ?? 'real'
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const { createSemanticRuntime, resolveStateHome } = await import('../lib/semantic-index.js')

const CATEGORIES = ['concepts', 'entities', 'references', 'synthesis', 'projects', 'dictionaries', 'tables']

function writeSyntheticVault(vault, pages) {
  const topics = ['rate limiting', 'idempotency', 'retry budget', 'schema migration', 'index tuning', 'cache invalidation', 'backpressure', 'observability']
  for (let i = 0; i < pages; i += 1) {
    const category = CATEGORIES[i % CATEGORIES.length]
    const topic = topics[i % topics.length]
    mkdirSync(join(vault, '.wiki', category), { recursive: true })
    const body = [
      '---',
      `title: ${topic} 笔记 ${i}`,
      `tags: [${topic.split(' ')[0]}, note]`,
      'confidence: extracted',
      '---',
      '',
      `# ${topic} ${i}`,
      '',
      `本文记录 ${topic} 的实践要点。第 ${i} 篇。`,
      '',
      '## 背景',
      '',
      `当 ${topic} 在高峰期失效时，下游会出现排队与超时级联。典型触发条件是突发流量叠加慢查询，`,
      '监控上表现为错误率与延迟同时抬升，且重试放大了原始压力。',
      '',
      '## 做法',
      '',
      '1. 在入口处做快速失败，避免把请求堆到连接池。',
      '2. 对可重试错误使用指数退避并设置重试预算。',
      '3. 把关键指标（排队长度、拒绝数、重试次数）接入看板。',
      '',
      '## 结论',
      '',
      `先限流再优化，比先优化后限流更稳；${topic} 的收益需要与复杂度一起评估。`,
      '',
    ].join('\n')
    writeFileSync(join(vault, '.wiki', category, `note-${String(i).padStart(4, '0')}-${topic.replace(/ /g, '-')}.md`), body, 'utf8')
  }
}

function countPages(vault) {
  let count = 0
  for (const category of CATEGORIES) {
    const dir = join(vault, '.wiki', category)
    if (!existsSync(dir)) continue
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name)
        if (entry.isDirectory()) walk(child)
        else if (entry.name.endsWith('.md')) count += 1
      }
    }
    walk(dir)
  }
  return count
}

const realModel = join(homedir(), '.dsh', 'qmd', 'models', 'embeddinggemma-300M-Q8_0.gguf')
if (!existsSync(realModel)) {
  console.error(`缺少模型：${realModel}`)
  process.exit(1)
}

let vault
let home
let cleanup = []

if (mode === 'synthetic') {
  const pages = Number(flag('pages', '300'))
  vault = mkdtempSync(join(tmpdir(), 'measure-vault-'))
  home = mkdtempSync(join(tmpdir(), 'measure-home-'))
  mkdirSync(resolveStateHome(home).modelsDir, { recursive: true })
  linkSync(realModel, join(resolveStateHome(home).modelsDir, 'embeddinggemma-300M-Q8_0.gguf'))
  writeSyntheticVault(vault, pages)
  cleanup = [vault, home]
  console.log(`合成库：${countPages(vault)} 篇（home=${home}，模型用硬链接，跑完清理）`)
} else {
  vault = flag('vault', 'D:/workspace/iobs_pro')
  console.log(`真实库：${vault} 共 ${countPages(vault)} 篇（写入生产索引，保留不清理）`)
}

const t0 = Date.now()
const runtime = await createSemanticRuntime({ vaultRoot: vault, home })
console.log(`runtime: status=${runtime.status} modelPresent=${runtime.modelPresent} store=${Boolean(runtime.store)} (+${Date.now() - t0}ms)`)
const store = runtime.store

const tUpdate = Date.now()
const updated = await store.update()
const updateMs = Date.now() - tUpdate
console.log(`update: ${JSON.stringify(updated)} (+${updateMs}ms)`)

const before = await store.getStatus()
console.log(`status(before): ${JSON.stringify(before)}`)

const tEmbed = Date.now()
const embedded = await store.embed()
const embedMs = Date.now() - tEmbed
console.log(`embed: ${JSON.stringify(embedded)} (+${(embedMs / 1000).toFixed(1)}s)`)

const after = await store.getStatus()
console.log(`status(after): ${JSON.stringify(after)}`)

// 热态：强制重嵌入（模型与后端已就绪），用来区分「冷启动成本」与「稳态吞吐」
const tWarm = Date.now()
const warm = await store.embed({ force: true })
const warmMs = Date.now() - tWarm
console.log(`embed(warm, force): ${JSON.stringify(warm)} (+${(warmMs / 1000).toFixed(1)}s)`)

const docs = embedded?.docsProcessed ?? 0
const chunks = embedded?.chunksEmbedded ?? 0
const warmDocs = warm?.docsProcessed ?? 0
if (docs > 0) {
  console.log(`--- 冷启动：${(embedMs / 1000).toFixed(1)}s / ${docs} 篇 / ${chunks} 块 → ${(embedMs / docs / 1000).toFixed(2)}s/篇`)
}
if (warmDocs > 0) {
  const perDocWarm = warmMs / warmDocs
  console.log(`--- 稳态：${(warmMs / 1000).toFixed(1)}s / ${warmDocs} 篇 / ${warm?.chunksEmbedded ?? 0} 块 → ${(perDocWarm / 1000).toFixed(2)}s/篇`)
  console.log(`--- 外推（按稳态）：500 篇 ≈ ${((perDocWarm * 500) / 1000 / 60).toFixed(1)} 分钟，2000 篇 ≈ ${((perDocWarm * 2000) / 1000 / 60).toFixed(1)} 分钟`)
}

await store.close?.()
for (const path of cleanup) rmSync(path, { recursive: true, force: true })
console.log('done')
