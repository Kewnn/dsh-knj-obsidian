export interface QueryMissEntry {
    /** ISO 时间戳。 */
    at: string;
    /** 当时检索的库根（用于区分工作区）。 */
    vaultRoot: string;
    /** 库目录名（人读友好）。 */
    workspace?: string;
    query: string;
    /** 检索模式：auto / index-only。 */
    mode: string;
    /** 该库当时的页数（0 页 = 空库，与「有库但没这主题」区别开）。 */
    totalPages: number;
    /** 是否尝试过语义兜底（区分"没试"与"试了也没有"）。 */
    semanticTried: boolean;
    semanticStatus?: string;
}
/** 开关：KNJ_OBSIDIAN_MISS_LOG=off 关闭（默认开启——这一阶段就是要攒数据）。 */
export declare function missLogEnabled(env?: Record<string, string | undefined>): boolean;
/** 日志文件路径（与 vaults.json 同处插件状态目录；绝不落在 vault 里）。 */
export declare function missLogPath(home?: string): string;
/**
 * 追加一条未命中记录。任何失败都被吞掉——**诊断日志绝不打断检索**。
 * 用"整文件重写"而非 append，以便同时执行封顶；条目少（≤2000 行）时开销可忽略。
 */
export declare function recordQueryMiss(entry: QueryMissEntry, opts?: {
    home?: string;
    maxEntries?: number;
}): void;
