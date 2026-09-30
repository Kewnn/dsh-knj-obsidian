import type { RetrievalResult, SemanticPageHit } from './retriever.ts';
import type { VaultStore } from './vault-store.ts';
/** 语义后端返回的原始命中（形态对齐 qmd：文件路径 + 可选分数/片段） */
export interface SemanticRawHit {
    path: string;
    score?: number;
    snippet?: string;
}
/** 语义后端：只做「查询 → 原始命中」，不感知 vault 结构（便于用假后端单测） */
export interface SemanticBackend {
    name: string;
    search(query: string, opts?: {
        limit?: number;
    }): Promise<SemanticRawHit[]>;
}
export interface SemanticProbe {
    available: boolean;
    reason?: string;
}
export interface SemanticUnavailable {
    reason: string;
}
export type SemanticRetrievalResult = RetrievalResult & {
    semanticUnavailable?: SemanticUnavailable;
};
export interface SemanticRetrieveOptions {
    /** 未提供 / null = 语义层关闭 → 返回值与 retrieve() 逐字段一致 */
    semantic?: SemanticBackend | null;
    mode?: 'auto' | 'index-only';
    maxCandidates?: number;
    /** 传给后端的候选上限 */
    limit?: number;
}
/** 探测 qmd 是否可用（只跑 --version，不产生任何写入）。失败返回原因而非抛出。 */
export declare function probeQmd(opts?: {
    binaryPath?: string;
}): Promise<SemanticProbe>;
/**
 * 把后端返回的原始路径命中映射为库内页面命中。
 * 任何越界/非正式分类/非 .md 的路径一律丢弃（含 _system/ 与 wiki-export/）。
 */
export declare function mapHitsToPages(wikiRoot: string, hits: readonly SemanticRawHit[] | undefined): SemanticPageHit[];
/**
 * 带语义层的检索：先取语义命中，再交给同步纯函数 retrieve() 融合。
 * 后端缺失/抛错/返回非法值时降级为纯 L1–L4，并在结果上标注 semanticUnavailable。
 */
export declare function retrieveWithSemantic(store: VaultStore, query: string, opts?: SemanticRetrieveOptions): Promise<SemanticRetrievalResult>;
