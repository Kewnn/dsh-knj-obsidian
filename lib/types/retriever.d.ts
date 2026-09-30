import type { VaultStore } from './vault-store.ts';
import type { WikiCategory, WikiTier, Confidence } from './types.ts';
/** 正式分类全量清单（L1 索引命中后逐类回读；此前漏了 dictionaries/tables，导致字典/表结构页在 index-only 模式检索不到）。
 *  同时作为语义命中的分类白名单：_system/ 与 wiki-export/ 不在其中，故永不可被语义层命中。 */
export declare const RETRIEVAL_CATEGORIES: readonly WikiCategory[];
/**
 * 基础匹配分。10/6/4/2 四项与上游 obsidian-wiki 的 graphrag 打分逐项对齐
 * （精确标题 / 标题 / 标签 / 摘要），使两套检索引擎对同一个库给出方向一致的排序。
 * index/semantic/body/graph 是本地扩展：上游 graph-query 压根不读正文，没有正文与
 * 图谱层，故这三项取较低的基础分，保证既有「前置层优先」语义在分数上也可读。
 */
export declare const MATCH_SCORE: {
    readonly exactTitle: 10;
    readonly title: 6;
    readonly tag: 4;
    readonly semantic: 3;
    readonly summary: 2;
    readonly index: 2;
    readonly body: 1;
    readonly graph: 0.5;
};
/** tier 权重（与上游一致）：core 1.3 / supporting 1.0 / peripheral 0.7。 */
export declare const TIER_WEIGHT: Record<WikiTier, number>;
export interface RetrievalCandidate {
    page: string;
    id: string;
    category: WikiCategory;
    title: string;
    confidence: Confidence;
    snippet: string;
    matchedBy: 'title' | 'tag' | 'summary' | 'body' | 'graph' | 'index' | 'semantic';
    /** 相关性分数（越大越相关）= 基础匹配分 + 度加权，再乘 tier 权重。候选恒按此降序返回。 */
    score: number;
    /** 归一化后的分层（core/supporting/peripheral），即打分所用的权重档位。 */
    tier: WikiTier;
    /** 页面 frontmatter 的 source（原始出处标识）：候选一路带着它，合成答案才追得回源头。 */
    source: string;
}
export interface RetrievalResult {
    candidates: RetrievalCandidate[];
    strategy: string;
    totalPages: number;
}
/** 语义召回命中（由调用方预先取好并已做边界过滤，保持 retrieve 为同步纯函数） */
export interface SemanticPageHit {
    id: string;
    category: WikiCategory;
    /** 后端给出的片段；缺省时按正文头部生成 */
    snippet?: string;
}
export interface RetrievalOptions {
    mode?: 'auto' | 'index-only';
    maxCandidates?: number;
    /** 为空/未提供时，下面所有分支与不含语义层时逐字节一致 */
    semanticHits?: SemanticPageHit[];
}
/**
 * 查询拆词：按空白与常见分隔符切分（中英文标点都算），只保留非空片段；
 * **纯 CJK 长片段再按 2 字滑窗拆 bigram**——没有空格的中文句子上面拆不开，2 字滑窗
 * 是唯一确定性的廉价拆法（「知识库怎么触发检索」→ 知识/识库/库怎/…/检索）。
 *
 * 为什么必须拆：改动前整个查询被当成**单一子串**做 `includes` / `indexOf`，于是任何
 * 词组式写法（「knj-workflow 流程实例 运行 变量」）与任何中文自然语言句子
 * （「知识库怎么触发检索」）都必然 0 命中——而这两种恰恰是最自然的提问方式。
 *
 * 兼容性：单 token 查询返回 `[q]`，占比恒为 1，与改动前**逐字节等价**；
 * 2 字中文 = 1 个 bigram，同样与整串等价。只有 ≥3 字 CJK 与多 token 查询才走占比加权。
 */
export declare function tokenizeQuery(query: string): string[];
export declare function retrieve(store: VaultStore, query: string, opts?: RetrievalOptions): RetrievalResult;
/**
 * 返回页面正文中的出链 target 列表（[[b]]、[[c|别名]]、[[d#锚点]] 均归一为 id，
 * 锚点与别名被剥离），供 L4 图谱遍历与跨页关联复用。
 */
export declare function linkedPages(store: VaultStore, id: string, category: WikiCategory): string[];
