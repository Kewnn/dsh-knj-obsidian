// client-api.test.mjs
// Task 3 存在性测试：api.ts 三个 fetch 函数、WikiSidebar 空态引导、三个子组件文件。
// 不重复 client-build.test.mjs 对 registerTab render 字段的窄禁令。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath（而非 URL.pathname + join）：Windows 上 pathname 形如 /D:/…，
// join 后产生 \\D:\…，fs 会解析成不存在的 D:\D:\…（见 client-build.test.mjs 同款约定）
const ROOT = fileURLToPath(new URL('.', import.meta.url))

test('api.ts 存在且导出三个 fetch 函数', () => {
  const api = join(ROOT, 'src/client/api.ts')
  assert.ok(existsSync(api), 'src/client/api.ts 应存在')
  const text = readFileSync(api, 'utf8')
  assert.match(text, /fetchPages/)
  assert.match(text, /fetchSearch/)
  assert.match(text, /fetchLint/)
})

test('空态引导文案存在且被边栏渲染', () => {
  // brief 缺陷修正：空态文案按 brief 实现位于 VaultTree（页面数为 0 时渲染），
  // 故断言 VaultTree 含文案、WikiSidebar 挂载 VaultTree（引导必然出现在边栏）。
  const vt = join(ROOT, 'src/client/VaultTree.tsx')
  assert.ok(existsSync(vt), 'src/client/VaultTree.tsx 应存在')
  assert.match(readFileSync(vt, 'utf8'), /吸收进 wiki/)
  const ws = join(ROOT, 'src/client/WikiSidebar.tsx')
  assert.ok(existsSync(ws))
  assert.match(readFileSync(ws, 'utf8'), /VaultTree/)
})

test('VaultTree/SearchBox/LintPanel 组件存在（v2 起 LintBadge 由 LintPanel 取代）', () => {
  for (const f of ['VaultTree.tsx', 'SearchBox.tsx', 'LintPanel.tsx']) {
    assert.ok(existsSync(join(ROOT, 'src/client', f)), `${f} 应存在`)
  }
})

// ---- v8 语义索引：客户端状态块与「更新索引」 ----

test('api.ts 暴露语义索引状态与手动更新（打到 /semantic-status 与 /semantic-update）', () => {
  const text = readFileSync(join(ROOT, 'src/client/api.ts'), 'utf8')
  assert.match(text, /export function fetchSemanticStatus/)
  assert.match(text, /export async function triggerSemanticUpdate/)
  assert.match(text, /`\$\{BASE\}\/semantic-status`/)
  assert.match(text, /`\$\{BASE\}\/semantic-update`/)
  assert.match(text, /method: 'POST'/, '手动更新必须是同源 POST')
})

test('SemanticIndexPanel：状态块含模型/篇数/待嵌入、更新按钮、进度轮询与离线说明', () => {
  const panel = join(ROOT, 'src/client/SemanticIndexPanel.tsx')
  assert.ok(existsSync(panel), 'src/client/SemanticIndexPanel.tsx 应存在')
  const text = readFileSync(panel, 'utf8')

  assert.match(text, /更新索引/, '必须有手动更新入口')
  assert.match(text, /待嵌入/, '必须显示还差多少页未嵌入')
  assert.match(text, /模型未就位/, '模型缺失时必须如实显示，而不是假装可用')
  assert.match(text, /不联网/, '必须说明严格离线')
  assert.match(text, /setInterval/, '重建期间必须轮询进度（首次含模型加载，约 1–2 分钟）')
  assert.match(text, /wiki_search_semantic/, '应指向语义检索工具')

  const launcher = readFileSync(join(ROOT, 'src/client/KnowledgeDistillLauncher.tsx'), 'utf8')
  assert.match(launcher, /SemanticIndexPanel/, '状态块必须挂载在边栏启动器上')
})
