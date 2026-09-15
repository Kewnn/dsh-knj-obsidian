// tools/bench-embed.mjs — 直接量 node-llama-cpp 的嵌入吞吐（机器上限，用来判断瓶颈在机器还是 qmd）。
// 用法：node tools/bench-embed.mjs [--tokens 900] [--iters 5] [--threads 8] [--gpu cuda|vulkan|auto|cpu]
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const numFlag = (name, fallback) => Number(flag(name, fallback))
const targetTokens = numFlag('tokens', 900)
const iterations = numFlag('iters', 5)
const threads = numFlag('threads', 0)
const gpuOption = flag('gpu', 'auto')
const gpu = gpuOption === 'cpu' ? false : gpuOption

const modelPath = join(homedir(), '.dsh', 'qmd', 'models', 'embeddinggemma-300M-Q8_0.gguf')
if (!existsSync(modelPath)) { console.error(`缺少模型：${modelPath}`); process.exit(1) }

const sentence = '限流与退避策略在高峰期决定了系统的稳定性；令牌桶控制突发流量，指数退避配合重试预算可以避免重试风暴把下游打死。'
let text = ''
while (text.length < targetTokens * 1.6) text += sentence

const { getLlama } = await import('node-llama-cpp')
const options = { gpu }
if (threads > 0) options.maxThreads = threads
let llama
try {
  llama = await getLlama(options)
} catch (error) {
  console.log(`--- gpu=${gpuOption} 初始化失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  process.exit(2)
}
const model = await llama.loadModel({ modelPath })
const context = await model.createEmbeddingContext({ contextSize: 2048 })

const tokens = model.tokenize(text)
console.log(`gpu=${gpuOption}(实际 ${llama.gpu}) | buildType=${llama.buildType ?? 'n/a'} | 文本 ${text.length} 字符 = ${tokens.length} token | maxThreads=${threads || '默认'}`)

await context.getEmbeddingFor('预热')
const start = Date.now()
for (let i = 0; i < iterations; i += 1) await context.getEmbeddingFor(text)
const elapsed = Date.now() - start
const perEmbed = elapsed / iterations

console.log(`--- ${iterations} 次嵌入耗时 ${(elapsed / 1000).toFixed(2)}s → ${(perEmbed / 1000).toFixed(3)}s/块，` +
  `${(tokens.length / (perEmbed / 1000)).toFixed(0)} token/秒`)

await context.dispose?.()
await model.dispose?.()
await llama.dispose?.()
