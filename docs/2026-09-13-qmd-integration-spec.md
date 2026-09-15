# qmd 语义检索集成 — 需求 spec（doublecheck）

> 记录时间：2026-09-13　来源：grill-requirements 六维盘问，用户逐项确认
> 状态：**已达成共识**；实现期间任何目标/范围变动必须回写本文件

## Goal

把 qmd（本地语义检索）集成为 dsh-knj-obsidian 的**可选**语义检索层，并产出**独立离线包**产物，使「本机一次打包、异机离线部署」成立；集成后语义召回**默认关闭**，关闭与降级时行为与现状**逐字节一致**。

## Scope

### IN

- 在 worktree `D:\workspace\iobs_pro\plugin-worktrees\dsh-knj-obsidian-reviewed-collection` 上先提交落盘（快照 + tag），再新开分支开发
- `src/semantic.ts`（新增）：探测 / 查询 / 结果→页面 id 映射 / 超时熔断 / 降级
- `src/retriever.ts`：加可选语义参数，改为**并行 + RRF 融合**（必须打破现有 L2 短路返回，否则标题命中时语义永不执行）
- `src/index.ts`：新增 qmd 配置项（默认关闭）
- `src/tools.ts` / `src/routes.ts`：复用同一融合结果（`wiki_query` 与边栏搜索同时受益）
- 边栏：一行状态文字
- 仓库外暂存区 `D:\dsh-knj\qmd-offline` 构建 win-x64 **CPU-only** 离线包（裁剪 CUDA/Vulkan/arm64 + gguf + Gemma 许可文件 + manifest）
- 新增 `semantic.test.mjs`；回归 `retriever` / `tools` / `routes` 测试

### OUT

- 不修改 DSH profile 配置（**本轮不挂 MCP**）
- 不做 UI 进度面板
- 不索引 `_system/` 与 `wiki-export/`
- 不让 qmd 索引反向写回 `.wiki/`
- 不做非 Windows 平台包
- 不做 `qmd query` 级重排（只用 `search`/`vsearch`，避免额外 2.8GB 模型）
- 不发布 `.74`

## Acceptance criteria

1. **召回质量断言**：构造对照用例集——一组查询在纯关键词路径下搜不到、开启语义后能命中预期页（断言 `page`/`id`）；并断言**关闭语义时同一查询结果与改动前逐字节一致**
2. **降级断言**：下列六种情形下检索仍返回 L1–L4 结果、不抛异常，`strategy` 如实标注语义不可用——qmd 不存在 / 模型缺失 / collection 缺失 / 子进程非零退出 / 超时 / 输出非法 JSON
3. **现有测试全绿**：worktree 现有 35 个 `*.test.mjs` 全部通过；新增测试**不得依赖真实 qmd 二进制**（用假后端）
4. **离线包产物**：`D:\dsh-knj\qmd-offline` 内生成 CPU-only 运行时 + gguf + 许可文件 + manifest，且本机以 `QMD_EMBED_MODEL` 指向包内 gguf、`QMD_FORCE_CPU=1` 时 `qmd vsearch` 可返回结果
5. **检索路径零写入**：语义检索不得创建/修改任何 vault 文件（含**不得懒建 collection**）

## Failure modes

| 情形 | 正确行为 |
|---|---|
| qmd 不可执行 | 探测失败 → 降级纯 L1–L4，仅写日志 |
| 嵌入模型缺失 | **不自动下载**（下载只在显式触发时发生）→ 降级并提示 |
| collection 未建 | 降级；**绝不在检索路径建 collection** |
| 子进程挂起 | 超时后 kill 并降级 |
| 非零退出 / 输出非 JSON | 视为不可用，**不解析半截数据** |
| qmd 返回路径落在 `_system/`、`wiki-export/` 或 vault 外 | 直接丢弃该候选 |
| 输出超长 | 截断并有界 |
| 下载中断/写坏 | GGUF magic + 体积下限校验；失败则删除并报错 |
| 包体积超限 | 独立产物/分卷，不塞主插件包 |

## Priorities

1. **零行为变更 > 召回质量**（默认关闭、关闭时逐字节一致是硬约束）
2. **降级正确性 > 融合效果**
3. 顺序：M1 探测与降级 → M2 融合 → M3 离线包与状态文字 → 收尾双向合并
4. 可牺牲：UI 面板体验、非 Windows 平台、重排质量、异机从零安装验收（本轮不做）

## Non-goals

- 不挂 MCP（不改 profile 配置）
- 不做 UI 进度面板 / 百分比动画
- 不把 `_system/` 会话归档与 `wiki-export/` 纳入语义索引
- 不让 qmd 索引成为第二真相（不反向写回 `.wiki/`）
- **不引入 sha256 模型哈希清单**（不掌握官方发布哈希，不编造）
- 不做多平台离线包
- 不发布 `.74`
- 不手工修改 profile 内的安装副本
