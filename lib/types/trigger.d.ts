import type { VaultStore } from './vault-store.ts';
import type { WikiCategory, WikiPage } from './types.ts';
export interface TriggerCandidate {
    id: string;
    category: WikiCategory;
    title: string;
    /** 页面 frontmatter 的 source：提醒里不展开，但保留以便追溯。 */
    source: string;
    /** 命中的词表项（给模型一句「为什么提这一页」）。 */
    hits: string[];
    /** 排序分：2×标题命中数 + 1×标签命中数（仅内部用）。 */
    score: number;
}
export interface MatchOptions {
    /** 最多返回几条（默认 3）。 */
    max?: number;
}
/** 页面侧词表：标签 + 标题词 + **正文小节标题词**（`## Cron 时区被强制成 UTC` 这类）。 */
export declare function lexiconOf(page: Pick<WikiPage, 'title' | 'tags' | 'body'>): {
    tags: string[];
    terms: string[];
    headingTerms: string[];
};
/**
 * 用页面侧词表扫任务原文，返回相关页（按分降序、同分按 id 升序，保证可复现）。
 *
 * 打分 = Σ 命中词权重（按文档频率衰减）。命中不足 / 文本为空 / 空库 → 空数组：
 * 静默是默认行为，不是异常。
 */
export declare function matchTaskPages(store: VaultStore, taskText: string, opts?: MatchOptions): TriggerCandidate[];
/** L1 的提醒文案：给路径、给理由、给「可以忽略」的出口（它不是门禁）。 */
export declare function renderTaskReminder(candidates: readonly TriggerCandidate[]): string;
/** L5 的提醒文案：只在「用过库 + 改了代码 + 没写回」时出现。 */
export declare function renderCaptureReminder(): string;
/** 开关：KNJ_OBSIDIAN_TRIGGER=off 时 L1/L5 全关（与 AUTO_REFRESH/SEMANTIC_FALLBACK 同族）。 */
export declare function triggerEnabled(env?: Record<string, string | undefined>): boolean;
export interface SessionEventLike {
    type?: string;
    seq?: number;
    data?: {
        source?: {
            kind?: string;
        };
        content?: Array<{
            type?: string;
            text?: string;
        }>;
        name?: string;
        arguments?: unknown;
        text?: string;
    };
}
/**
 * 最近一条**直接用户**任务（`user/message` 且 `source.kind === 'user'`）。
 * 判据对齐 dsh-doublecheck 的折叠逻辑：插件注入（kind: 'plugin:<name>'，会话格式 v4 起）、宿主注入的 AGENTS.md
 * （kind: 'agent-instructions'）、运行时上下文快照等一律不算任务——
 * 否则本插件注入的提醒会把自己再触发一次（自激循环）。
 */
export declare function latestDirectUserTask(events: readonly SessionEventLike[]): {
    seq: number;
    text: string;
} | undefined;
export interface TurnFacts {
    /** 本回合读过库（含 read/grep/glob 指向 .wiki，或调用了 wiki_query / wiki_search_semantic）。 */
    readVault: boolean;
    /** 本回合改了库外的文件（改 .wiki 内的页面属于知识维护本身，不算）。 */
    mutatedOutside: boolean;
    /** 本回合写回过库（wiki_capture / wiki_ingest）。 */
    wroteVault: boolean;
}
/** 折叠一个回合的工具调用事实（纯函数；调用方决定回合边界）。 */
export declare function foldTurnFacts(events: readonly SessionEventLike[]): TurnFacts;
/** L5 是否该说话：三者齐备才提醒（宁可不说是第一原则）。 */
export declare function shouldRemindCapture(facts: TurnFacts): boolean;
export interface TriggerDeps {
    /** 注入点：构造模型可见的提醒消息（默认懒加载宿主提供的 @deepseek-ai/dsh-llm）。 */
    createNotice?: (text: string, summary: string) => unknown;
}
/** 触发层只需要 provider 的「当前库」读取能力。 */
export interface VaultProviderLike {
    currentReadonly?: () => VaultStore;
    current?: () => VaultStore;
}
interface AgentLike {
    session?: unknown;
    inject?: (input: unknown) => void;
}
export interface TriggerHost {
    on(event: 'agent/pre-step', handler: (payload: {
        agent?: AgentLike;
    }, next: () => Promise<unknown>) => Promise<unknown>): unknown;
    on(event: 'agent/turn-stopping', handler: (payload: {
        agent?: AgentLike;
    }) => Promise<void>): unknown;
}
export declare function installTrigger(ctx: TriggerHost, provider: VaultProviderLike, deps?: TriggerDeps): () => void;
export {};
