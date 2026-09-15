#!/usr/bin/env node
// tools/qmd-offline/mirror-qmd.mjs
//
// 内网离线镜像工具：把 dsh-knj-obsidian 的语义检索依赖（进程内 @tobilu/qmd 及其传递依赖）
// 打包成可在无外网环境分发的材料。
//
// 背景：`@tobilu/qmd` 是插件的 **optionalDependency**——内网 npm 仓库若没有它，插件仍能装上，
// 语义检索如实降级到关键词检索（wiki_query）。要让语义检索真正可用，内网侧需要拿到这批包
// （仅 npm 包；300M 嵌入模型 gguf 不在 npm 上，必须单独放 ~/.dsh/qmd/models/）。
//
// 子命令：
//   refresh            从本机 node_modules 重新计算依赖闭包，写 packages.json（开发侧用）
//   list               打印某平台的包清单与体积（不联网）
//   pack               用 npm pack 把清单里的包下载到 --dest（写 manifest.json，含 sha512）
//   verify             校验 --dest 里已下载的 tarball 与 manifest.json 是否一致（不联网）
//
// 例：
//   node tools/qmd-offline/mirror-qmd.mjs list --platform win-x64
//   node tools/qmd-offline/mirror-qmd.mjs pack --platform win-x64 --dest tools/qmd-offline/vendor
//   node tools/qmd-offline/mirror-qmd.mjs verify --dest tools/qmd-offline/vendor
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..', '..')
const LIST_PATH = join(HERE, 'packages.json')

/** 目标平台 → node-llama-cpp / sqlite-vec 的平台变体名（CPU 版，不含 cuda/vulkan）。 */
const CPU_VARIANT = {
  'win32-x64': { llama: 'win-x64', sqliteVec: 'windows-x64', reflink: 'win32-x64-msvc' },
  'win32-arm64': { llama: 'win-arm64', sqliteVec: null, reflink: null },
  'linux-x64': { llama: 'linux-x64', sqliteVec: 'linux-x64', reflink: null },
  'linux-arm64': { llama: 'linux-arm64', sqliteVec: 'linux-arm64', reflink: null },
  'darwin-x64': { llama: 'mac-x64', sqliteVec: 'darwin-x64', reflink: 'darwin-x64' },
  'darwin-arm64': { llama: 'mac-arm64-metal', sqliteVec: 'darwin-arm64', reflink: 'darwin-arm64' },
}

function hostPlatform() {
  return `${process.platform}-${process.arch}`
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else { args[key] = next; i += 1 }
    } else args._.push(token)
  }
  return args
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 平台变体 → 平台标识；普通包返回 null（所有平台都需要）。 */
function platformOf(name) {
  const llama = /^@node-llama-cpp\/(.+)$/.exec(name)
  if (llama) {
    for (const [platform, variant] of Object.entries(CPU_VARIANT)) {
      if (variant.llama === llama[1]) return platform
    }
    return `gpu-or-variant:${llama[1]}`
  }
  const vec = /^sqlite-vec-(.+)$/.exec(name)
  if (vec) {
    if (/^darwin/.test(vec[1])) return `darwin-${vec[1].split('-')[1]}`
    if (/^linux/.test(vec[1])) return `linux-${vec[1].split('-')[1]}`
    if (/^windows/.test(vec[1])) return `win32-${vec[1].split('-')[1]}`
    return `variant:${vec[1]}`
  }
  const reflink = /^@reflink\/reflink-(.+)$/.exec(name)
  if (reflink) {
    if (reflink[1] === 'win32-x64-msvc') return 'win32-x64'
    if (/darwin/.test(reflink[1])) return `darwin-${reflink[1].split('-')[1]}`
    if (/linux/.test(reflink[1])) return `linux-${reflink[1].split('-')[1]}`
    return `variant:${reflink[1]}`
  }
  return null
}

/** 遍历本机已安装的依赖闭包（含 optional），得到 name → {version, bytes}。 */
function collectInstalledClosure() {
  const seen = new Map()
  const sizeOf = (dir) => {
    const stat = statSync(dir)
    if (stat.isFile()) return stat.size
    let total = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      try { total += entry.isDirectory() ? sizeOf(path) : statSync(path).size } catch { /* 跳过不可读项 */ }
    }
    return total
  }
  const walk = (pkgDir) => {
    let manifest
    try { manifest = readJson(join(pkgDir, 'package.json')) } catch { return }
    const key = `${manifest.name}@${manifest.version}`
    if (seen.has(key)) return
    seen.set(key, { name: manifest.name, version: manifest.version, bytes: sizeOf(pkgDir) })
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const dep of Object.keys(deps)) {
      for (const candidate of [join(pkgDir, 'node_modules', dep), join(PLUGIN_ROOT, 'node_modules', dep)]) {
        if (existsSync(join(candidate, 'package.json'))) { walk(candidate); break }
      }
    }
  }
  walk(join(PLUGIN_ROOT, 'node_modules', '@tobilu', 'qmd'))
  return [...seen.values()]
}

/** 从本机 node_modules 计算清单（含各平台 CPU 变体名，版本取自各自的 optionalDependencies）。 */
function refresh() {
  const closure = collectInstalledClosure()
  const byName = new Map(closure.map((entry) => [entry.name, entry]))
  // node-llama-cpp / qmd 自己在 optionalDependencies 里枚举了**所有**平台变体：用它补全跨平台清单
  const llamaManifest = readJson(join(PLUGIN_ROOT, 'node_modules', 'node-llama-cpp', 'package.json'))
  const qmdManifest = readJson(join(PLUGIN_ROOT, 'node_modules', '@tobilu', 'qmd', 'package.json'))
  for (const [name, version] of Object.entries({ ...llamaManifest.optionalDependencies, ...qmdManifest.optionalDependencies })) {
    if (!byName.has(name) && platformOf(name) !== null) byName.set(name, { name, version, bytes: 0 })
  }

  const packages = [...byName.values()]
    .map((entry) => ({ name: entry.name, version: entry.version, platform: platformOf(entry.name), bytes: entry.bytes }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const list = {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    note: 'CPU-only 平台变体（不含 cuda/vulkan）。bytes 为解包体积，仅作估算；跨平台变体为 0 表示本机未安装。',
    packages,
  }
  writeJson(LIST_PATH, list)
  const cpuOnly = packages.filter((p) => p.platform === null || p.platform === hostPlatform())
  const total = cpuOnly.reduce((sum, p) => sum + p.bytes, 0)
  process.stdout.write(`已写入 ${LIST_PATH}：${packages.length} 个条目（${hostPlatform()} 需下载 ${cpuOnly.length} 个，约 ${(total / 1048576).toFixed(1)} MB 解包）\n`)
}

function selected(list, platform, only) {
  const wanted = platform ?? hostPlatform()
  const filter = only ? new Set(String(only).split(',').map((s) => s.trim()).filter(Boolean)) : null
  return list.packages.filter((entry) => {
    if (filter && !filter.has(entry.name)) return false
    return entry.platform === null || entry.platform === wanted
  })
}

function listCommand(args) {
  const list = readJson(LIST_PATH)
  const chosen = selected(list, args.platform, args.only)
  for (const entry of chosen) {
    const size = entry.bytes > 0 ? `${(entry.bytes / 1048576).toFixed(1)} MB` : '(本机未安装，体积未知)'
    process.stdout.write(`${entry.name}@${entry.version}  ${size}${entry.platform ? `  [${entry.platform}]` : ''}\n`)
  }
  const known = chosen.reduce((sum, entry) => sum + entry.bytes, 0)
  process.stdout.write(`--- ${chosen.length} 个包，已知解包体积合计 ${(known / 1048576).toFixed(1)} MB（平台：${args.platform ?? hostPlatform()}）\n`)
  process.stdout.write('提示：模型 gguf（约 320 MB）不在 npm 上，需单独放 ~/.dsh/qmd/models/embeddinggemma-300M-Q8_0.gguf\n')
}

/** 定位 npm 的 JS 入口：Node 24 在 Windows 上已不允许 spawnSync 直接跑 .cmd（EINVAL）。 */
function npmLaunch(argv) {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const cli of candidates) {
    if (cli && existsSync(cli)) return { command: process.execPath, args: [cli, ...argv], options: {} }
  }
  // 兜底：交给 shell（路径含空格时由调用方用引号包裹）
  return { command: 'npm', args: argv, options: { shell: true } }
}

function packCommand(args) {
  const list = readJson(LIST_PATH)
  const dest = resolve(String(args.dest ?? join(HERE, 'vendor')))
  mkdirSync(dest, { recursive: true })
  const chosen = selected(list, args.platform, args.only)
  const manifestPath = join(dest, 'manifest.json')
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : { packages: [] }
  const recorded = new Map(manifest.packages.map((entry) => [`${entry.name}@${entry.version}`, entry]))
  const registry = typeof args.registry === 'string' ? args.registry : undefined

  let done = 0
  for (const entry of chosen) {
    const spec = `${entry.name}@${entry.version}`
    if (recorded.has(spec) && existsSync(join(dest, recorded.get(spec).file))) {
      process.stdout.write(`跳过（已下载） ${spec}\n`)
      done += 1
      continue
    }
    const argv = ['pack', spec, '--pack-destination', dest, '--json', '--silent']
    if (registry) argv.push('--registry', registry)
    const launch = npmLaunch(argv)
    const result = spawnSync(launch.command, launch.args, { encoding: 'utf8', ...launch.options })
    if (result.status !== 0) {
      process.stderr.write(`失败 ${spec}：${(result.stderr ?? result.error?.message ?? '').trim() || 'npm pack 非零退出'}\n`)
      continue
    }
    let parsed
    try { parsed = JSON.parse(result.stdout.trim())[0] } catch { parsed = undefined }
    const file = parsed?.filename ?? readdirSync(dest).find((name) => name.includes(entry.name.split('/').pop()) && name.endsWith('.tgz'))
    if (!file || !existsSync(join(dest, file))) {
      process.stderr.write(`失败 ${spec}：npm pack 未产出可识别的 tarball\n`)
      continue
    }
    recorded.set(spec, {
      name: entry.name,
      version: entry.version,
      file,
      sha512: createHash('sha512').update(readFileSync(join(dest, file))).digest('base64'),
      bytes: statSync(join(dest, file)).size,
    })
    process.stdout.write(`已下载 ${spec} → ${file}\n`)
    done += 1
  }

  const packages = [...recorded.values()].sort((a, b) => a.name.localeCompare(b.name))
  const total = packages.reduce((sum, entry) => sum + entry.bytes, 0)
  writeJson(manifestPath, {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platform: args.platform ?? hostPlatform(),
    registry: registry ?? 'npm 当前配置',
    packages,
    totalBytes: total,
  })
  process.stdout.write(`--- 完成 ${done}/${chosen.length}，${packages.length} 个 tarball 合计 ${(total / 1048576).toFixed(1)} MB，manifest：${manifestPath}\n`)
}

function verifyCommand(args) {
  const dest = resolve(String(args.dest ?? join(HERE, 'vendor')))
  const manifest = readJson(join(dest, 'manifest.json'))
  let bad = 0
  for (const entry of manifest.packages) {
    const path = join(dest, entry.file)
    if (!existsSync(path)) { process.stderr.write(`缺失 ${entry.file}\n`); bad += 1; continue }
    const sha512 = createHash('sha512').update(readFileSync(path)).digest('base64')
    if (sha512 !== entry.sha512) { process.stderr.write(`哈希不符 ${entry.file}\n`); bad += 1 }
  }
  process.stdout.write(bad === 0
    ? `校验通过：${manifest.packages.length} 个 tarball 与 manifest 一致（${(manifest.totalBytes / 1048576).toFixed(1)} MB）\n`
    : `校验失败：${bad} 个文件有问题\n`)
  process.exitCode = bad === 0 ? 0 : 1
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
switch (command) {
  case 'refresh': refresh(); break
  case 'list': listCommand(args); break
  case 'pack': packCommand(args); break
  case 'verify': verifyCommand(args); break
  default:
    process.stdout.write('用法：mirror-qmd.mjs <refresh|list|pack|verify> [--platform win32-x64] [--dest 目录] [--only 包名,包名] [--registry URL]\n')
    process.exitCode = command === undefined ? 0 : 1
}
