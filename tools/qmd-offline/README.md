# 内网离线镜像：语义检索依赖（QMD）

`dsh-knj-obsidian` 的语义检索在**进程内**使用 `@tobilu/qmd` 库（不 spawn 命令、不走 MCP、不需要单独安装或启动任何 QMD 插件）。它被声明为 **optionalDependency**：

- 内网 npm 仓库**有**这批包 → 语义检索可用；
- 内网 npm 仓库**没有** → 插件照常安装，`wiki_search_semantic` 如实回报「库未加载」并指向关键词检索 `wiki_query`，**不会**因为一个可选能力把整个插件拖垮。

> 300M 嵌入模型 **不在 npm 上**，任何情况下都要单独放一份：`~/.dsh/qmd/models/embeddinggemma-300M-Q8_0.gguf`（约 320 MB）。插件严格离线，只报告路径、绝不自动下载。

## 体积

| 目标 | 包数 | 解包体积 |
|---|---|---|
| win32-x64（CPU） | 128 | 约 205 MB |
| 全平台含 GPU 变体 | 145 | 约 830 MB |

为什么差这么多：`node-llama-cpp` 把各平台/各算力变体都作为 optionalDependencies 发布，其中 `win-x64-cuda-ext` 346 MB、`win-x64-cuda` 163 MB、`win-x64-vulkan` 95 MB。本工具默认只取 CPU 变体（`win-x64` 45 MB）；需要 GPU 时按下面的「GPU 变体」小节自行加。

## 用法

```powershell
# 1) 查看某平台要哪些包（不联网）
node tools/qmd-offline/mirror-qmd.mjs list --platform win32-x64

# 2) 下载 tarball（默认 registry 取 npm 当前配置；也可 --registry https://registry.npmmirror.com）
node tools/qmd-offline/mirror-qmd.mjs pack --platform win32-x64 --dest tools/qmd-offline/vendor
#    已下载的会跳过；产出 manifest.json（含 sha512 与体积）

# 3) 校验完整性（不联网，可反复跑；哈希不符会退出码 1）
node tools/qmd-offline/mirror-qmd.mjs verify --dest tools/qmd-offline/vendor

# 清单需随依赖升级刷新（开发侧，需本机已装 node_modules）
node tools/qmd-offline/mirror-qmd.mjs refresh
```

## 投放路径 A：内网 npm 仓库（推荐）

内网仓库若是 npmjs 代理（Nexus / Verdaccio / Artifactory 缓存），**先预热一次**即可，之后无需任何额外动作；若是纯私有仓库，把 `vendor/*.tgz` 发布/上传进去：

```bash
# 用一个临时 Verdaccio 或直接对私有 registry 发布（按内网规范执行）
npm publish ./vendor/tobilu-qmd-2.8.3.tgz --registry https://<内网-registry>/
# …其余 tarball 同理
```

之后内网机器正常安装插件即可：`dsh plugin --profile web add dsh-knj-obsidian@<版本>`。

## 投放路径 B：目标机没有任何内网仓库（应急）

profile 使用 pnpm `nodeLinker: hoisted`，所以可以直接铺一棵 `node_modules`：

```powershell
# 在目标机、与 vendor 同目录
npm install --no-save --prefix .\stage .\vendor\*.tgz
# 然后把 stage\node_modules 下这些目录拷进插件的 node_modules（或 profile 根 node_modules）：
#   @tobilu  node-llama-cpp  @node-llama-cpp  better-sqlite3  sqlite-vec  sqlite-vec-windows-x64
#   tree-sitter-*  web-tree-sitter  fast-glob  picomatch  yaml  zod  @modelcontextprotocol  tar  ipull …
```

注意：这是应急手段，与 pnpm 的依赖图不同步——**下次 pnpm install 前先备份**，或改用路径 A。

## GPU 变体

需要 CUDA / Vulkan 时，在 `packages.json` 里找到对应条目（`platform` 形如 `gpu-or-variant:win-x64-cuda`），手动下载：

```powershell
npm pack @node-llama-cpp/win-x64-cuda@3.20.0 --pack-destination tools/qmd-offline/vendor
```

## 安装后的验证

```powershell
# 1) 库是否可加载（不联网；只验证库，不需要模型）
node -e "import('@tobilu/qmd').then(m=>console.log('qmd ok:', typeof m.createStore)).catch(e=>console.log('qmd missing:', e.code))"

# 2) 目标机是否已放好模型
Get-ChildItem $env:USERPROFILE\.dsh\qmd\models

# 3) 真实模型端到端 smoke（自建临时库 → 真实嵌入 → 语义检索，跑完自动清理索引）
node tools/smoke-semantic.mjs
#    2026-09-13 本机实测：update 3 篇 0.2s → embed 41.6s（含首次模型加载）→
#    中文问句「接口被刷爆了怎么保护后端」向量 3 命中 / 关键词 0 命中，限流页排第一。
#    加 --cpu 可强制 QMD_FORCE_CPU=1（跳过 GPU 探测）；加 --keep 保留索引不清理。
```

`~/.dsh/qmd/` 是插件的语义状态家目录：`models/`（模型）、`index.sqlite`（索引，不进 vault）、`config.yml`。

> 注意：分块路径走 QMD 的**模块级单例**（只认 `QMD_*` 环境变量，不读 store 配置）。插件在创建语义运行时时会把本地模型路径与两个禁用位写进进程环境，否则单例会去解析默认的 `hf:` 云端模型并联网，表现为嵌入阶段无限等待。

## 已知限制

- 只镜像 CPU 变体；GPU 需自行补。
- `better-sqlite3@13` 自带各平台 prebuilds（包内即含，无 GitHub 下载），`sqlite-vec` 靠 `sqlite-vec-<平台>` 包提供 .dll/.so，两者都必须在清单里。
- `node-llama-cpp` 的 postinstall 在 pnpm 下默认被 `allowBuilds` 白名单挡住——无害：二进制就在 `@node-llama-cpp/<平台>` 包里，运行期直接取用。
- 模型文件与 npm 无关，无法通过本工具镜像。
