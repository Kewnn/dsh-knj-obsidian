import type { WikiCategory, WikiPage, WikiTier, ManifestEntry, VaultProvider, VaultRecord, VaultListEntry } from './types.ts';
/**
 * 页面 id 的严格 kebab-case 模式（允许 CJK 字符，中文标题页保留语义文件名）：
 * 仍拒绝所有路径穿越字符（. / \ 等均不在字符集内）。id 直接用作文件名，
 * resolve() 包含性检查作为第二道防线。
 */
declare const SAFE_ID_RE: RegExp;
export { SAFE_ID_RE };
/** saveRawPage 的校验失败：携带建议的 HTTP status。 */
export declare class SaveError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
/** 合法 tier 取值（缺省 supporting）。 */
export declare const TIERS: readonly WikiTier[];
/**
 * tier 归一化：无法识别的值（拼错、空、未来新增值）一律回退 supporting。
 * 读取宽容——frontmatter 是用户/agent 手写的，不能因为一个错拼就让整页读不出来。
 */
export declare function normalizeTier(value: unknown): WikiTier;
/** 摘要规则：正文首个非空、非标题、非表格、非分隔线的行，截 60 字。
 *  写入 frontmatter 的 `summary:` 与写 index.md 必须是同一条规则，故放在这里由
 *  index-builder 复用（否则两个派生工件会给出不一致的摘要）。 */
export declare function summarizeBody(body: string): string;
/** 解析整份文件文本（统一 \n 后）为 WikiPage；无合法 frontmatter 返回 null。
 *  字段回退语义与 v4 readPage 一致（缺省用 fallbackId/fallbackCategory），读取宽容。
 *  剥离开头 UTF-8 BOM（\uFEFF）：带 BOM 的文件（Windows 编辑器常见）同样可解析。 */
export declare function parsePageText(raw: string, fallbackId?: string, fallbackCategory?: WikiCategory): WikiPage | null;
export interface RenameDeps {
    /** 测试注入点：替换 rename 实现。 */
    rename?: (from: string, to: string) => void;
    /** 测试注入点：替换退避。 */
    sleep?: (ms: number) => void;
    /** 最多尝试次数（含首次）。 */
    attempts?: number;
}
/** rename 的退避重试（原因见上方注释）。 */
export declare function renameWithRetry(from: string, to: string, deps?: RenameDeps): void;
export declare class VaultStore implements VaultProvider {
    private readonly vaultRoot;
    constructor(vaultRoot: string);
    /** 只读暴露 wiki 根目录（<vaultRoot>/.wiki），供检索器读 index.md */
    get wikiRoot(): string;
    /** 单库模式：当前库就是自身。 */
    current(): VaultStore;
    /** 单库模式只读视图同样是自身（readPageCached 等读路径本身零写入）。 */
    currentReadonly(): VaultStore;
    currentRecord(): VaultRecord | null;
    listVaults(): VaultListEntry[];
    ensure(): void;
    pagePath(id: string, category: WikiCategory): string;
    /**
     * 校验 id 并返回受控路径：id 必须匹配严格 kebab-case，且解析后必须落在 wikiRoot 之内。
     * 不合法返回 null（writePage 抛错、readPage 返回 null），绝不静默截断或放行。
     */
    private safePagePath;
    /**
     * 单行化：frontmatter 值里的换行会注入伪造的 `key: value` 行（改写 id/category），写入前必须拍平。
     * 必须覆盖**全部 Unicode 行终止符**（\r \n U+2028 U+2029），不能只处理 \r\n：
     * U+2028/U+2029 同样能截断一行，而下面的读取正则跨不过它们——只处理 \r\n 会让这类值
     * 写得出去却读不回来（writePage 成功、readPage 的 summary 却是空串）。
     */
    private static flatField;
    writePage(page: WikiPage): {
        created: boolean;
    };
    /**
     * Obsidian 适配：把 .wiki 当 vault 打开时，隔离内部目录与派生工件——
     * _system/（会话归档/进度/还原点）、_meta/（治理元数据：标签词表）、_raw/（废弃区）、
     * wiki-export/（导出产物）、.manifest.json。
     * 幂等 + 不覆盖用户自定义：已有 app.json 只做 userIgnoreFilters 并集合并。
     */
    private ensureObsidianIgnore;
    readPage(id: string, category: WikiCategory): WikiPage | null;
    /** mtime 页缓存：stat 命中即免读盘免解析（磁盘外部编辑通过 mtime 变化自动失效）。 */
    private cache;
    private cacheKey;
    private readPageCached;
    /** 读磁盘原文（含 frontmatter，逐字节）；v5 源码视图用。 */
    readRawPage(id: string, category: WikiCategory): string | null;
    /**
     * 保存整份文件原文（v5 全文编辑）：
     * - 路径必须通过 safePagePath（防穿越）
     * - frontmatter 必须可解析且 id/category 与目标一致（防「编辑 A 存成 B」）
     * - 目标必须已存在（v5 只做编辑，不做新建/改名）
     * - 原子写：先写临时文件再 rename
     * 返回解析后的页面；任何校验失败抛 SaveError（含 status 提示），磁盘不动。
     */
    saveRawPage(id: string, category: WikiCategory, rawText: string): WikiPage;
    sha256(text: string): string;
    private manifestFile;
    private loadManifest;
    private saveManifest;
    /**
     * manifest 的 read-modify-write 合并写：每次写入前重读磁盘再合并本次条目，
     * 避免跨进程（两个 DSH 进程共用同一库）互相覆盖丢失 entries。
     */
    updateManifestMerged(entries: Record<string, ManifestEntry>): void;
    manifestEntry(source: string): ManifestEntry | undefined;
    /** 全部已记录来源 key 列表（对账 deleted 判定用）。 */
    manifestSources(): string[];
    updateManifest(source: string, entry: ManifestEntry): void;
    listPages(): {
        id: string;
        category: WikiCategory;
        title: string;
    }[];
    /**
     * 只读列出页面清单：不调用 ensure()，不创建任何目录/文件。
     * 分类目录缺失时跳过（全新 vault 上检索仍是零写入）。
     * stat 与页缓存复用：每文件一次 stat，mtime 未变则免读盘免解析。
     */
    listPagesReadonly(): {
        id: string;
        category: WikiCategory;
        title: string;
    }[];
}
