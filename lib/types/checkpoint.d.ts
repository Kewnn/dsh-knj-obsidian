import type { VaultStoreLike } from './types.ts';
export interface CheckpointMeta {
    id: string;
    createdAt: string;
    pageCount: number;
}
/** 创建还原点：拷贝当前全部正式页面 + 派生工件；返回元数据。 */
export declare function createCheckpoint(store: VaultStoreLike): CheckpointMeta;
/** 列出全部还原点（新→旧）。 */
export declare function listCheckpoints(store: VaultStoreLike): CheckpointMeta[];
/**
 * 恢复到指定还原点。两种模式：
 * - `merge`（默认，非破坏性）：只把快照里的页面**覆盖回**（撤销批次对既有页的修改），
 *   **保留**快照之后新增的页面（可能是其它会话/agent 的正当产物），不动它们；
 * - `exact`（显式选择）：整库回到快照状态，删除快照之后新增的页面。
 *
 * 为什么默认非破坏性：回滚的用途是撤销「刚跑坏的那一批」，而不是抹掉之后所有人的工作。
 */
export declare function restoreCheckpoint(store: VaultStoreLike, id: string, mode?: 'merge' | 'exact'): {
    ok: true;
    pageCount: number;
    restored: number;
    keptNewer: number;
    mode: 'merge' | 'exact';
};
