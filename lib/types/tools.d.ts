import type { Context } from '@deepseek-ai/cordis';
import type { VaultProvider } from './types.ts';
import { type SemanticRuntime } from './semantic-index.ts';
/**
 * 写页后主动回报的标签现状（**全库口径**，不是本批次口径）——把标签维护从「拉」变「推」：
 * 不主动报，词表就永远不会演化（没人会想起来调 wiki_lint）。
 * 只报，不改：新增规范词是知识分类判断，必须由人/agent 决定。
 */
export interface TagHint {
    taxonomyPresent: boolean;
    unknownCount: number;
    aliasCount: number;
    untaggedCount: number;
    /** 出现 ≥2 页的未知词 —— 达到词表自己的升表门槛，可直接粘进库级词表 */
    promote: {
        tag: string;
        pages: string[];
    }[];
    localTypeTags: string[];
    shadowedBaseTags: string[];
}
/** wiki_query 的语义兜底阈值：词面候选少于该数时才启用语义层（省算力——嵌入调用只在词面几乎无果时发生）。 */
export declare const SEMANTIC_FALLBACK_MIN_CANDIDATES = 2;
export interface MountToolsOptions {
    /** 测试注入点：替换语义运行时创建（默认按当前库创建进程内 QMD 运行时）。 */
    semanticRuntimeFactory?: (vaultRoot: string) => Promise<SemanticRuntime>;
}
/**
 * 语义兜底开关：`KNJ_OBSIDIAN_SEMANTIC_FALLBACK=off` 时完全关闭。
 * 与 `KNJ_OBSIDIAN_AUTO_REFRESH=off` 同族：单元测试与离线环境用它避免加载 300M 嵌入模型、
 * 不去碰用户真实的 ~/.dsh/qmd（模型冷启动一次就要几十秒，测试里不可接受）。
 */
export declare function semanticFallbackEnabled(): boolean;
/** 关闭并清空所有缓存的语义运行时（插件 dispose 时调用，避免 sqlite 句柄与模型常驻）。 */
export declare function disposeSemanticRuntimes(): void;
export declare function mountTools(ctx: Context, provider: VaultProvider, opts?: MountToolsOptions): () => void;
