---
name: wiki-distill
description: >
  Distill recent DSH agent sessions into the Obsidian wiki (.wiki/) as incremental
  knowledge pages. Use this skill when the user says "蒸馏近期会话", "把最近的对话
  整理进知识库", "wiki-distill", or clicks the "蒸馏近期会话" sidebar button and
  pastes the trigger. ALWAYS confirm the scope (time range + project) with the user
  BEFORE extracting. Ingests via the wiki_ingest tool with contentHash so repeated
  runs skip unchanged sources automatically.
---

# Wiki Distill — DSH 会话蒸馏进知识库

把 `~/.dsh/sessions/` 下的会话转录解码、去重、脱敏后蒸馏成 wiki 知识页。**写路径 skill**：
产出经 `wiki_ingest` 工具入库（不要手写 .wiki 页面文件）。

## 第 0 步：确认范围（必做，不得跳过）

向用户确认两点（给出默认建议让用户确认或修改）：

- **时间范围**：默认建议「近 3 天」（可改近 7 天 / 近一周 / 全部）
- **项目范围**：默认建议「当前项目」（按 cwd 过滤；可加全部项目）

用户确认后才继续。用户说「就按默认」即用默认。

## 第 1 步：落位提取器

提取器随本 skill 分发（`wiki-distill/extract-dsh-sessions.cjs`）。规则：

- 若 `<vault>/_system/tools/extract-dsh-sessions.cjs` **不存在** → 从 skill 目录复制过去（用文件工具，逐字节复制，禁止改写内容）
- 若**已存在** → **先逐字节比对** skill 目录版本：
  - 内容一致 → 直接用 vault 版本
  - 内容不同（skill 版本更新，含单会话过滤等修复）→ **用 skill 版本覆盖 vault 版本**并说明原因；
    仅当用户明确说过“我改过这个脚本”时才保留 vault 版本
  - 覆盖前建议先把 vault 旧版另存为 `extract-dsh-sessions.cjs.bak-<日期>`，便于回退
- 旧版没有第 6 个会话过滤参数：**版本不一致时不要跳过覆盖**，否则“指定会话蒸馏”会退化成整范围蒸馏
- vault 根：当前项目根目录下的 `.wiki/`（与宿主 process.cwd 一致；找不到就 `ls -a` 确认）

提取器带自测（`*.test.cjs` 同目录），首次落位后可跑一次 `node --test` 确认 5/5 绿。

## 第 2 步：提取

```bash
node <vault>/_system/tools/extract-dsh-sessions.cjs <sessions根> <vault>/_system/dsh-sessions [项目过滤] [最早mtime] [会话过滤]
```

- sessions 根：`~/.dsh/sessions`（Windows：`%USERPROFILE%\.dsh\sessions`）
- 项目过滤：目录名形如 `--D-workspace-<项目>--`（路径转义形态）；当前项目 = cwd 盘符与路径替换 `:` `\` `/` 为 `-` 后两端加 `--`。不确定就先 `ls` sessions 根看目录名
- 最早 mtime：ISO 时间（如 `2026-08-24T00:00:00+08:00`）
- **会话过滤（单会话蒸馏）**：第 6 参数，按会话目录名（= session id）做包含匹配；逗号分隔可指定多个；留空=不按会话过滤
- 产物：`catalog.json`（全部会话元数据：顶层/子代理、标题、时间、digestFile）+ `sessions/*.md` 摘要

### 单/多会话蒸馏（指定若干会话）

只蒸指定会话（一个或多个）时：

1. 会话 id = `~/.dsh/sessions/<项目>/<sessionId>/` 目录名（也可从 GUI「知识蒸馏 → 指定会话蒸馏」复选列表取）
2. 提取时给第 6 参数传会话 id 列表（**逗号分隔可多个**），并把**最早 mtime 传 0 基准**（`1970-01-01T00:00:00Z`），否则老会话会被时间下限过滤掉：
   ```bash
   node <vault>/_system/tools/extract-dsh-sessions.cjs \
     "$HOME/.dsh/sessions" "<vault>/_system/dsh-sessions" "<项目过滤>" 1970-01-01T00:00:00Z "<id1>,<id2>"
   ```
3. 只对这些会话产物蒸馏，不要顺带处理同项目其它会话（catalog.json 里其余项忽略）
4. 入库 `source=session:<sessionId>`（每会话一个 source），`contentHash` 用该会话摘要内容哈希（重复执行自动跳过）
5. 报告逐会话列出：id、产出页数、更新页数、是否因重复跳过

技术要点（提取器已内建）：zstd 多帧流式解码（Node 24 zlib）、顶层判定 delegationDepth=0、
子代理只留最终报告、`<system-reminder>` 注入清洗、密钥/token/Bearer 正则脱敏。

## 第 3 步：蒸馏（模型工作，无脚本）

读 catalog.json，按 `role=top` 的会话逐个读摘要（`digestFile` 指向的 md）：

1. **判主题**：把会话按主题聚类（插件演进 / 踩坑手册 / 决策记录 / 方法论…），不按时间罗列
2. **宁缺毋滥**：纯噪音会话（无标题且无实质内容，catalog 里已标 skipped）不蒸馏；
   无信息量的小修会话只在索引页留一行
3. **写用户会遇到什么**：知识页写结论与复现路径，不写对话过程；每页 2-5 个小节，带 `[[wikilink]]` 交叉引用
4. **必产出两页**：
   - 按主题的综合页（若干张，category 按内容定：concepts/entities/references）
   - 会话索引页（references）：时间 | 会话标题 | 结果 | 蒸馏去向，作为溯源清单

## 第 3.5 步：写前纪律（必做，不得跳步）

1. **还原点**：调用 `wiki_checkpoint` 工具创建还原点并记下返回的 `id`（用户可凭它整库回滚本批次）
2. **查重（防 -2 堆积）**：每个将要产出的主题页，先用 `wiki_query` 检索同名/近似页：
   - 已有**同主题页** → **更新该页**（`wiki_ingest` 同 source 重导即可，保留 created），**不要新建**
   - 只有确实没有对应页时才新建
3. **写前清单（信息性预览）**：写入任何页之前，先在对话里列出「将创建 X 页 / 更新 Y 页」
   （每页一行：id、category、一句话理由、来源）。**列完即继续**执行 `wiki_ingest`——本流程
   不做阻塞式二次确认（授权来自用户触发），用户可随时打断；质量不佳用还原点整库回滚。

## 第 4 步：入库（wiki_ingest 工具）

- `source`：**逐会话**用 `session:<sessionId>`（每会话一个 source，重复蒸同一会话时更新自己的页面）；
  只有跨会话聚合出的主题页才用稳定主题 source：`agent:session-distill-<topic-slug>`。
  **禁止**用日期区间做 source（如 `agent:session-distill-2026-08-24_26`）——滑动窗口每天变，
  会被当成新 source 从而新建 `-2/-3` 页并把旧页留成孤儿。
- `contentHash`：用**本次蒸馏输入的摘要哈希**（逐会话模式 = 该会话 digest 内容的 SHA-256；
  主题页 = 其输入会话 digest 集合的内容哈希）。**不要**用 catalog.json 整体哈希：
  它含每个会话的 mtime/字节数，任何无关会话被触碰都会导致整批“更新”。
- 页面 id：kebab-case 或中文语义 id（SAFE_ID_RE 允许 CJK）
- confidence：会话里实证过的事实用 `extracted`；推断性结论 `inferred`

## 第 5 步：质量评估报告（必产出）

按序输出（这是本批次的质量凭证，用户据此决定是否回滚）：

1. **还原点 id**（第 3.5 步创建的那个）
2. **本批创建/更新页清单**：id、category、confidence、新增 `[[wikilink]]` 数
3. **查重决策**：复用了哪些既有页（更新而非新建）；哪些被跳过及原因（同哈希 / 无信息量）
4. **风险提示**：仍为孤儿（无入链）的新页、推断性内容占比、以及建议的补链动作
5. 收尾：索引已由 `wiki_ingest` 自动重建；如需人工复核，可在边栏「知识蒸馏 → 还原点」一键回滚

报告：蒸馏了几个会话 → 产出/更新几张页 → 增量跳过情况 → 还原点 id
