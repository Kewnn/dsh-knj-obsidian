import { type SemanticState, type SemanticStatusRaw, type SemanticStore } from './semantic-index.ts';
export interface SemanticRuntimeView {
    status: SemanticState;
    modelPath: string;
    modelPresent: boolean;
    store: SemanticStore | null;
}
export interface RefreshRunResult {
    ok: boolean;
    at: string;
    documents: number;
    chunks: number;
    durationMs: number;
    /** 失败/跳过原因（如实回报，不吞）。 */
    note?: string;
}
export interface SemanticStatusView {
    available: boolean;
    modelPresent: boolean;
    indexState: SemanticState;
    documents: number;
    pendingEmbedding: number;
    hasVectorIndex: boolean;
    refreshing: boolean;
    startedAt?: string;
    elapsedMs?: number;
    /** 本进程内实测的一次冷启动耗时（首次刷新），用于 UI estimtate。 */
    coldStartMs?: number;
    lastRun?: RefreshRunResult;
    note?: string;
}
export interface RefresherOptions {
    vaultRoot: string;
    home?: string;
    /** 自动刷新的 debounce（合并连续写入）。 */
    debounceMs?: number;
    /** 自动刷新上限：待嵌入超过它就不自动跑，只回报（避免一次大批入库偷偷占满 CPU 很久）。 */
    maxAutoDocs?: number;
    /** 测试注入点：替换真实运行时创建。 */
    runtimeFactory?: (opts: {
        vaultRoot: string;
        home?: string;
    }) => Promise<SemanticRuntimeView>;
    now?: () => number;
}
export interface Refresher {
    schedule(reason?: string): void;
    refreshNow(): Promise<RefreshRunResult>;
    status(): Promise<SemanticStatusView>;
    dispose(): void;
}
export declare const DEFAULT_DEBOUNCE_MS = 15000;
export declare const DEFAULT_MAX_AUTO_DOCS = 500;
/** 把 qmd 状态喂给纯函数分类器，返回 {indexState, documents, pendingEmbedding, hasVectorIndex}。 */
export declare function summarizeStatus(raw: SemanticStatusRaw | undefined): {
    indexState: SemanticState;
    documents: number;
    pendingEmbedding: number;
    hasVectorIndex: boolean;
};
export declare function createRefresher(opts: RefresherOptions): Refresher;
export declare function refresherFor(vaultRoot: string, home?: string): Refresher;
export declare function disposeRefreshers(): void;
/** 由 vault store 推出库根（.wiki 的父目录）。 */
export declare function vaultRootOf(store: {
    wikiRoot: string;
}): string;
