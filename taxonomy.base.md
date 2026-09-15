# 基础标签词表（随插件分发）

> **这层是共享的**：随 dsh-knj-obsidian 插件一起分发，所有库共用一份，**升级插件即升级**。
> 因此这里只放**与项目无关**的东西——知识类型轴（Type），以及跨项目通用的别名。
>
> 各项目自己的领域词（Domain）与项目词（Project）**不放这里**，放各自的
> `<项目>/.wiki/_meta/taxonomy.md`。生效词表 = 本文件 ∪ 该文件（同词以库级为准）。
>
> 这样迁移到知识内容完全不同的项目时，Type 轴已经随插件到位、零配置；
> 领域词由「≥2 页才升表」的规则就地涌现。

## 规则

1. **每页最多 5 个标签**（库级文件与本文件共同生效）。
2. 小写 + 连字符。
3. **宁宽勿窄**：碎片化（一页一个一次性标签）与通胀（一页八个标签）是两个反向病。
4. **只用规范词，不用别名**。别名登记在这里是为了能被识别并自动纠正。
5. **本层新增词的门槛比库级高**：领域词按「≥2 页」就能进库级；但 Type 词改的是
   跨项目的可比性，所以新 Type 词应先在本库按 ≥2 页用一阵（`wiki_lint` 会把它标成
   `localTypeTags`，即「上游候选」），确认在 ≥2 个项目都要用时再提到本文件、
   随插件版本发布。
6. 系统标签组 `visibility/*`（public / internal / pii）不计上限、不参与别名映射、
   审计时不算「未知标签」。

## Type — 知识类型

- `concept` — 机制与语义的原理性知识
- `pitfall` — 实证过的坑、复现路径与结论
  - aliases: pitfalls, troubleshooting, gotcha
- `decision` — 架构或方案的决策记录
  - aliases: adr, decision-record
- `api-contract` — 接口/契约与不变量（宿主 API、库接口、协议约定）
  - aliases: host-api, interface, contract
- `enum` — 枚举 / 常量字典页（由 wiki-collect、wiki-mine 产出）
- `table` — 表结构页（由 wiki-collect、wiki-mine 产出）
- `todo` — 已调研但搁置、留待续作的待办
- `index` — 溯源清单 / 目录页
  - aliases: provenance, distill-index
