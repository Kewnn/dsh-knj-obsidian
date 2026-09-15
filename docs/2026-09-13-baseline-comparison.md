# dsh-knj-obsidian 基线对照报告（三份副本）

> 采集时间：2026-09-13　采集方式：文件系统归一化对比（忽略 CRLF/LF）+ git 元数据 + npm tarball 核对
> 结论先行：**最新功能只存在于一份「未提交的 worktree」里；已发布物反而缺这些功能；两条线是双向分叉。**

## 1. 三份副本

| # | 位置 | 分支 / 版本 | 状态 |
|---|---|---|---|
| A | `D:\dsh-knj\dsh-knj-obsidian` | `main` @ `5ff97e3` / **2026.9.73** | 干净，工作树无改动；**= npm 发布物** |
| B | `D:\workspace\iobs_pro\plugin-worktrees\dsh-knj-obsidian-reviewed-collection` | `feat/reviewed-knowledge-collection` @ `ef7a4a0`（v2026.9.10）/ package.json 已改为 **2026.9.70** | **78 个已改 + 13 个未跟踪**，全部未提交 |
| C | `C:\Users\MrYang\.dsh\profiles\web\node_modules\dsh-knj-obsidian` | 安装副本 | 含 B 的新功能（checkpoint / 蒸馏启动器 / wiki-init） |

**A ≡ npm 发布物**：已下载 `dsh-knj-obsidian-2026.9.73.tgz`（296 KB，70 文件）核对，其 `src/` 只有 28 个文件、技能为 `wiki-collect / wiki-distill / wiki-mine / wiki-query`——与 A 完全一致。

**C 是 B 的派生物**：C 里存在 `src/checkpoint.ts`（4.4 KB, 09-13 02:02）、`src/client/KnowledgeDistillLauncher.tsx`（25.9 KB, 09-13 13:42）、`wiki-init/SKILL.md`——这三样在 A 与 npm tarball 里都不存在。

## 2. 精确差异（A=main vs B=worktree）

### src（A=28 文件 / B=29 文件）

| 类别 | 文件 |
|---|---|
| **仅 A 有** | `client/CodeCollectLauncher.tsx` |
| **仅 B 有** | `checkpoint.ts`、`client/KnowledgeDistillLauncher.tsx` |
| **内容不同（12）** | `vault-manager.ts`、`client/index.ts`、`client/api.ts`、`graph-engine.ts`、**`retriever.ts`**、`routes.ts`、`client/LintPanel.tsx`、`client/VaultHeader.tsx`、`types.ts`、`vault-store.ts`、**`tools.ts`**、`client/WikiSidebar.tsx` |

### 技能目录

| 技能 | A=main | B=worktree |
|---|---|---|
| `wiki-query` | 2 文件 | **完全一致** |
| `wiki-mine` | 1 文件 | **完全一致** |
| `wiki-collect` | 有 | 有，**SKILL.md 内容不同** |
| `wiki-distill` | 3 文件 | 3 文件**全部不同**（含 `extract-dsh-sessions.cjs`） |
| `wiki-init` | **无** | **有** |

### 测试（根目录 `*.test.mjs`）

- A 共 30 个；B 共 35 个
- **仅 A**：`collection-client.test.mjs`
- **仅 B（6 个）**：`checkpoint.test.mjs`、`integrity.test.mjs`、`knowledge-distill.test.mjs`、`obsidian-config.test.mjs`、`vault-init.test.mjs`、`wiki-distill-extractor.test.mjs`

### B 相对自身 HEAD（`ef7a4a0` = v2026.9.10）的改动

- 已修改 **78** 个（其中 `src/` 下 26 个）、未跟踪 **13** 个
- 未跟踪的 13 个包含：`src/checkpoint.ts`、`src/client/KnowledgeDistillLauncher.tsx`、`src/related-check.ts`、`wiki-init/SKILL.md`、`wiki-collect/SKILL.md`、6 个新测试、4 份 docs

## 3. 双向分叉图

```
                    ┌── A(main, .73) 独有：CodeCollectLauncher.tsx（代码结构采集 GUI）
  ef7a4a0(.10) ─────┤
                    └── B(worktree) 独有：checkpoint.ts（还原点）
                                          KnowledgeDistillLauncher.tsx（蒸馏启动器）
                                          wiki-init/SKILL.md
                                          6 个新测试
                    └── 双方都有但不同：12 个 src 文件 + wiki-collect/wiki-distill
```

**这不是快进关系，也不是单向落后**——A 与 B 各自持有对方没有的功能。

## 4. 风险

| ID | 风险 | 依据 |
|---|---|---|
| **R1** | **最新工作未版本化**：78+13 个改动只存在于这一个 worktree，且 `src/checkpoint.ts` 连 git 都没跟踪（`git log -- src/checkpoint.ts` 为空） | B 的 `git status`；`git log --all` 全历史无此文件 |
| **R2** | **基线过旧**：B 的 HEAD 停在 v2026.9.10，与 A 的 .73 之间隔着 .70/.72/.73，任何合并都是双向冲突 | B 的 HEAD；A 的 tag 序列 |
| **R3** | **"已合并"是部分合并**：A 的 `5ff97e3` 提交信息写着「合并 reviewed-collection 分支」，但只带来 collection（CodeCollectLauncher），**没有** checkpoint/蒸馏/wiki-init | 提交信息 + §2 差异表 |
| **R4** | **再发布会回退功能**：若在 A 上开发并发布 .74，会把 C（用户实际在用的）里的 checkpoint/蒸馏/wiki-init 全部抹掉 | A 与 C 的差异 |
| **R5** | **安装副本被手工叠加**：C 里的 `checkpoint.ts` 等文件不属于任何 npm 发布物，是手工同步进去的（历史提交有「重建 client 产物并同步安装副本」）；下一次 `pnpm install` 会**静默覆盖**它们 | C 的文件来源无法在 tarball/git 中对应 |

## 5. 建议

1. **先给 B 打快照提交**（R1 兜底，优先级最高）——建议一次全量落盘 + 打 tag `snapshot/pre-qmd-2026-09-13`，不做花式拆分（在未确认归属前拆分容易错配）。
2. **在 B 上新开分支** `feat/qmd-semantic` 做 qmd 集成，避免直接污染 `feat/reviewed-knowledge-collection`。
3. **收尾时做一次真正的双向合并**（A 的 CodeCollectLauncher ← → B 的 checkpoint/蒸馏/wiki-init），再统一发布 `.74`，消除 R3/R4。
4. **安装副本（C）不要手改**，改为从发布物安装，消除 R5。

## 6. 未采集项（诚实标注）

- `integrity.test.mjs` / `obsidian-config.test.mjs` 对应的实现落在哪几个 src 文件——**未逐个读文件确认**，故本报告不做归属推断。
- B 的 78 个改动内部的功能分组——未做逐文件语义归类。
