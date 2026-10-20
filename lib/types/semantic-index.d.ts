export declare const DEFAULT_MODEL_FILENAME = "embeddinggemma-300M-Q8_0.gguf";
/** 与 QMD 默认一致的上游仓库（文件名相同）；仅作为人工下载提示，不会被插件自动使用。 */
export declare const MODEL_DOWNLOAD_URL = "https://hf-mirror.com/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf";
export declare const FORMAL_CATEGORIES: readonly ["concepts", "entities", "references", "synthesis", "projects", "dictionaries", "tables"];
export declare const DEFAULT_LIMIT = 8;
export declare const MAX_LIMIT = 20;
export interface StateHomePaths {
    root: string;
    modelsDir: string;
    dbPath: string;
    configPath: string;
}
export declare function resolveStateHome(home?: string): StateHomePaths;
export declare function resolveModelPath(home?: string, filename?: string): string;
/** 本地模型发现：存在返回绝对路径，否则 undefined（调用方据此给出“未就绪”答案）。 */
export declare function findModel(home?: string, filename?: string): string | undefined;
/** 每个库一个集合：path = <vault>/.wiki，pattern 只匹配七个正式分类。 */
export declare function buildCollectionConfig(vaultRoot: string, collectionId?: string): {
    collections: {
        [x: string]: {
            path: string;
            pattern: string;
        };
    };
};
export declare function clampLimit(value: unknown): number;
export interface SemanticHit {
    id: string;
    category: string;
    title: string;
    snippet: string;
    score?: number;
}
/**
 * 结果记录 → vault 内相对路径。
 * 实测 QMD 命中字段：`displayPath`（如 probe-wiki/concepts/rate-limiting.md）、
 * `filepath`（qmd://<collection>/concepts/rate-limiting.md URI）、`docid`（**内容哈希**，不是页面 id）。
 * 因此按 displayPath → path → filepath → file 取值，并剥掉 qmd://<collection>/ 前缀。
 * docid 绝不参与：它是哈希，拿来当 id 会给出无意义的「页面」。
 */
export declare function recordRelPath(record: Record<string, unknown>): string;
/**
 * 相对路径 → { id, category }。
 * 只接受 <category>/<file>.md 且分类属于七个正式目录：_system/（会话归档）、wiki-export/、
 * _raw/ 等内部位置即便被索引命中也不会成为检索结果。
 */
export declare function pageRefOf(relPath: string): {
    id: string;
    category: string;
} | undefined;
/** 去重键：<category>/<id>（同一页面在不同通道里的路径写法可能不同，但推导出的页面引用一致）。 */
export declare function recordKey(record: Record<string, unknown>): string;
/**
 * 结果整形：只保留有界字段；id/category 由路径推导（非正式分类/非 .md 一律丢弃）；
 * 标题优先取 frontmatter title；score 缺失时保持 undefined（不编造）。
 */
export declare function shapeSearchResults(raw: ReadonlyArray<Record<string, unknown>>, limit: number): SemanticHit[];
export type SemanticState = 'ready' | 'index-empty' | 'index-stale';
/**
 * 索引状态分类。注意 QMD 的 `getStatus()` 真实返回是
 * `{ totalDocuments, needsEmbedding, hasVectorIndex, collections[] }`（**不是** documents/embeddings），
 * 因此以 totalDocuments / needsEmbedding / hasVectorIndex 为准，同时兼容旧的 documents/embeddings 形态。
 */
export declare function classifyStatus(status: {
    documents?: number;
    embeddings?: number;
    totalDocuments?: number;
    needsEmbedding?: number;
    hasVectorIndex?: boolean;
}): SemanticState;
/** 待嵌入篇数（用于「索引陈旧」的可执行提示）。 */
export declare function pendingEmbeddingCount(status: {
    documents?: number;
    embeddings?: number;
    totalDocuments?: number;
    needsEmbedding?: number;
}): number;
export type NotReadyReason = 'model-missing' | 'library-missing';
/** 未就绪答案：给出可执行信息，绝不静默联网。 */
export declare function notReadyMessage(reason: NotReadyReason, modelsDir?: string, filename?: string): string;
/**
 * 禁用 QMD 的云端模型：把查询扩展（generate）与精排（rerank）指向本地**不存在**的路径。
 * 依据：这两个模型的默认值是 hf: 云端 URI，而 node-llama-cpp 的 resolveModelFile 在文件缺失时
 * 会直接联网下载（见 node_modules/@tobilu/qmd/dist/llm.js 注释 “resolveModelFile handles HF URIs
 * and downloads to the cache dir”）。指向本地后，任何误用都只是一次本地失败，绝不产生网络请求。
 */
export declare function offlineModelPins(modelsDir: string): {
    generate: string;
    rerank: string;
};
/** 记录 → 稳定去重键：见文件上方的 recordKey（<category>/<id>）。 */
/**
 * 多通道融合（RRF）：每个通道按名次贡献 1/(60+rank)，按融合分数降序取前 limit 条。
 * 同一页面只出现一次（保留首次出现的记录字段），score = 融合分数（越大越相关，非概率）。
 */
export declare function fuseRanked(channels: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, limit: number): Array<Record<string, unknown>>;
export interface OfflineSearchOutcome {
    results: SemanticHit[];
    /** 通道降级说明（有则必须如实回报给调用方）。 */
    degraded?: string;
    channels: {
        vector: number;
        lexical: number;
    };
}
/**
 * 严格离线的检索通道组合：向量（本地嵌入模型）+ BM25（无需模型），本地 RRF 融合。
 * 刻意**不使用** store.search() 的混合检索——那会拉起查询扩展与精排两个云端模型。
 * 任一通道失败都降级并如实说明，绝不抛异常。
 */
export declare function runOfflineSearch(store: SemanticStore, query: string, limit: number): Promise<OfflineSearchOutcome>;
/**
 * 进程环境版的离线模型配置（键名即 QMD 读取的环境变量）。
 * 为什么必须设：QMD 的**分块**路径（`chunkDocumentByTokens` → `getDefaultLlamaCpp()` → `llm.tokenize()`）
 * 走的是**模块级单例**，它不读我们传给 `createStore` 的 config，只认 env / 默认值。
 * 不设 env 时单例会去解析默认的 `hf:` 云端模型并在缺失时联网下载——实测表现为 embed 阶段
 * 无限等待（进程内存不涨、CPU 不动、模型从未加载）。
 */
export declare function offlineModelEnv(modelsDir: string, modelPath: string): Record<string, string>;
/** 把离线模型配置写进当前进程环境（幂等；只影响本进程，宿主重启即消失）。 */
export declare function applyOfflineModelEnv(models: {
    embed: string;
    generate: string;
    rerank: string;
}): void;
/** QMD `getStatus()` 的松散形态（真实字段 + 兼容旧字段）。 */
export interface SemanticStatusRaw {
    documents?: number;
    embeddings?: number;
    totalDocuments?: number;
    needsEmbedding?: number;
    hasVectorIndex?: boolean;
    collections?: ReadonlyArray<Record<string, unknown>>;
}
export interface SemanticStore {
    /**
     * QMD 的混合检索（BM25 + 向量 + **LLM 查询扩展** + RRF + **LLM 精排**）。
     * 本插件**不调用**：扩展模型默认 hf:tobil/qmd-query-expansion-1.7B、精排模型默认
     * hf:ggml-org/Qwen3-Reranker-0.6B，缺失时 node-llama-cpp 会自动联网下载。
     * 严格离线只用下面两个单通道方法（见 runOfflineSearch）。
     */
    search?(options: {
        query: string;
        limit?: number;
        rerank?: boolean;
    }): Promise<ReadonlyArray<Record<string, unknown>>>;
    /** 向量通道：只用本地嵌入模型。 */
    searchVector?(query: string, options?: {
        limit?: number;
    }): Promise<ReadonlyArray<Record<string, unknown>>>;
    /** 关键词通道（BM25）：完全不需要模型。 */
    searchLex?(query: string, options?: {
        limit?: number;
    }): Promise<ReadonlyArray<Record<string, unknown>>>;
    update(options?: Record<string, unknown>): Promise<unknown>;
    embed(options?: Record<string, unknown>): Promise<unknown>;
    getStatus(): Promise<SemanticStatusRaw> | SemanticStatusRaw;
    getIndexHealth?(): unknown;
    addCollection?(name: string, config: {
        path: string;
        pattern?: string;
    }): unknown;
    close?(): unknown;
}
export interface SemanticRuntime {
    status: 'ready' | 'index-empty' | 'index-stale';
    modelPath: string;
    modelPresent: boolean;
    store: SemanticStore | null;
    /** 索引计数（供工具如实回报「有几篇还没嵌入」；模型缺失时为 0）。 */
    index: {
        documents: number;
        pendingEmbedding: number;
        hasVectorIndex: boolean;
    };
}
export interface CreateRuntimeOptions {
    vaultRoot: string;
    home?: string;
    /** 测试注入点：跳过真实库加载与模型检查。 */
    storeFactory?: (opts: {
        dbPath: string;
        config: unknown;
    }) => Promise<SemanticStore>;
    /** 测试注入点：强制“库缺失”。 */
    libraryUnavailable?: boolean;
}
/**
 * 创建（或复用）当前库的语义检索运行时。库缺失/模型缺失都返回可诊断结果，不抛异常。
 */
export declare function createSemanticRuntime(opts: CreateRuntimeOptions): Promise<SemanticRuntime>;
