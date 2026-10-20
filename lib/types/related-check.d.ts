import type { VaultStore } from './vault-store.ts';
import type { WikiCategory } from './types.ts';
export interface RelatedHit {
    id: string;
    title: string;
    category: WikiCategory;
    matchedBy: 'title' | 'body';
    /** 新页正文已含 [[id]] 链接 */
    linked: boolean;
    /** 标题归一相等 → 疑似重复，建议并入已有页而非新建 */
    strong: boolean;
}
/** 对单页扫描库内相关已有页（排除自身与同批产出的页）。只读，扫描失败不阻断。 */
export declare function relatedHits(store: VaultStore, exclude: Set<string>, p: {
    id: string;
    title: string;
    category: string;
    body: string;
}): RelatedHit[];
