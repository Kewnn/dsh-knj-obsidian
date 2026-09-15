---
name: wiki-init
description: >
  初始化当前工作区的知识库（创建 .wiki 脚手架）。用户说"初始化知识库"、"这个项目还没有知识库"、
  "建库"、"wiki-init"，或边栏「初始化知识库」按钮触发时使用。只建结构、不写知识页；
  幂等、可重复执行。
---

# Wiki Init — 初始化工作区知识库

把**当前工作区**（会话 cwd / 活动库根目录）变成一个可用的知识库：创建 `.wiki` 脚手架。
只建结构，**不采集、不写入任何知识页**——采集是 `wiki-collect` 的职责。

## 何时用

- 边栏「初始化知识库」按钮触发（GUI 会把本指令预填进对话）
- 用户说"这个项目还没有知识库 / 初始化一下 / 建个库"
- `wiki-collect` 或 `wiki_ingest` 之前发现 `.wiki` 不存在时

## 步骤

1. 调用 `wiki_init`（工具）：
   - 缺省 = 当前库（跟随边栏切换的库）；不要传 root，除非用户明确要求另一个已注册库
   - 工具幂等：已存在时只补缺失结构并返回 `created=false`
2. 校验返回：`root`（库根）、`wikiRoot`（`.wiki` 路径）、`created`（是否新建）、`pageCount`（页数，通常 0）
3. 报告用户：库位置与是否新建；然后按需继续：
   - 代码结构采集 → `wiki-collect`（枚举/常量字典、表结构）
   - 文档/文本入库 → `wiki-ingest` / `wiki-capture`
   - 现有 Markdown 直接导入 → 边栏「工具 → 快速导入（直接写入）」

## 边界

- 不写入任何知识页；不读取 `.dsh` 会话归档等非代码源
- 不删除、不移动既有 `.wiki` 内容；不修改其他库
- 库根必须是活动库（或已注册库）；未注册路径应先在边栏新建/挂接
- 结构以插件为准：`index.md`、`.manifest.json`、七个分类目录
  （concepts / entities / references / synthesis / projects / dictionaries / tables），
  另有插件内部 `_system/`；**没有** `_raw/`、`.obsidian/`、`.env`（那是另一套 obsidian-wiki 项目）

## 失败处理

- 工具报"未注册的知识库根目录" → 让用户在边栏「新建/挂接」该目录后重试
- 工具报"只能初始化当前库" → 先在边栏切到目标库（下拉切换）再执行
