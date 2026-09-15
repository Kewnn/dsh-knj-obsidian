// 真实模型 smoke：验证「向量通道」在生产路径上真的能出结果（需要 ~/.dsh/qmd/models/embeddinggemma-300M-Q8_0.gguf）。
// 用法：node tools/smoke-semantic.mjs [--cpu] [--keep]
//   --cpu   设 QMD_FORCE_CPU=1（跳过 GPU 探测；本机实测 CPU / 默认 GPU 两条路都能跑通）
//   --keep  保留 ~/.dsh/qmd/index.sqlite（默认跑完删掉，保持用户环境干净）
//
// 2026-09-13 本机实测：update 3 篇 0.2s → embed 41.6s（含首次模型加载，CPU 版 313MB gguf）→
//   中文问句「接口被刷爆了怎么保护后端」向量 3 命中 / 关键词 0 命中，限流页排第一（纯语义命中）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('--cpu')) process.env.QMD_FORCE_CPU = '1'

const t0 = Date.now()
const log = (step, extra = '') => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}${extra ? ` ${extra}` : ''}`)

const { createSemanticRuntime, resolveStateHome, runOfflineSearch } = await import('../lib/semantic-index.js')

const vault = mkdtempSync(join(tmpdir(), 'smoke-vault-'))
const wiki = join(vault, '.wiki')
const pages = {
  'concepts/rate-limiting.md': '---\ntitle: 接口限流与退避\ntags: [rate-limit, resilience]\nconfidence: extracted\n---\n\n令牌桶与漏桶控制突发流量；超限返回 429，客户端按指数退避重试并设置重试预算，避免重试风暴把下游打死。\n',
  'concepts/order-idempotency.md': '---\ntitle: 下单幂等\ntags: [idempotency]\nconfidence: extracted\n---\n\n同一请求号重复提交只落一次单：幂等表记录 requestId，重复请求直接返回首次结果，客户端超时重试不会产生重复订单。\n',
  'entities/payment-gateway.md': '---\ntitle: Payment gateway\ntags: [payment]\nconfidence: inferred\n---\n\nThe gateway forwards authorizations to the acquirer and stores the settlement batch for reconciliation.\n',
}
for (const [rel, body] of Object.entries(pages)) {
  mkdirSync(join(wiki, rel.split('/')[0]), { recursive: true })
  writeFileSync(join(wiki, rel), body, 'utf8')
}

const paths = resolveStateHome()
log('env', `QMD_FORCE_CPU=${process.env.QMD_FORCE_CPU ?? '(unset)'} model=${existsSync(join(paths.modelsDir, 'embeddinggemma-300M-Q8_0.gguf'))} db=${existsSync(paths.dbPath)}`)

const runtime = await createSemanticRuntime({ vaultRoot: vault })
log('runtime', `status=${runtime.status} modelPresent=${runtime.modelPresent} store=${Boolean(runtime.store)}`)
const store = runtime.store

log('update', JSON.stringify(await store.update()))
log('embed:start')
const embedded = await store.embed()
log('embed:done', JSON.stringify(embedded).slice(0, 300))
log('status', JSON.stringify(await store.getStatus()))

for (const query of ['接口被刷爆了怎么保护后端', 'how do I stop duplicate orders from retries', 'settlement reconciliation batch']) {
  const outcome = await runOfflineSearch(store, query, 5)
  log(`query "${query}"`, `channels=${JSON.stringify(outcome.channels)}${outcome.degraded ? ` degraded=${outcome.degraded}` : ''}`)
  for (const hit of outcome.results) {
    log(`  hit`, `${hit.id} (${hit.category}) score=${hit.score?.toFixed(5)} title=${hit.title} snippet=${hit.snippet.slice(0, 30)}…`)
  }
  if (outcome.results.length === 0) log('  hit', '(无命中)')
}

await store.close?.()
rmSync(vault, { recursive: true, force: true })
if (!argv.includes('--keep')) {
  for (const name of readdirSync(paths.root)) {
    if (name.startsWith('index.sqlite')) { rmSync(join(paths.root, name), { force: true }); log('cleaned', name) }
  }
}
log('done')
