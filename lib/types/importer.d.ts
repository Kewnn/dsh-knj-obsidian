import type { VaultStore } from './vault-store.ts';
import type { WikiCategory } from './types.ts';
export interface ImportFileResult {
    source: string;
    id: string;
    category: WikiCategory;
    status: 'imported' | 'updated' | 'skipped';
    renamed?: boolean;
}
export interface ImportReport {
    imported: number;
    updated: number;
    skipped: number;
    files: ImportFileResult[];
}
export interface ImportLimits {
    maxFiles: number;
    maxBytes: number;
    maxDepth: number;
}
/** 文件名 → 合法 id：小写、非法字符折叠为 -、去首尾 -；空则回退 untitled。导出供测试。 */
export declare function sanitizeId(name: string): string;
export declare function importPath(store: VaultStore, root: string, category: WikiCategory, limits?: ImportLimits): ImportReport;
