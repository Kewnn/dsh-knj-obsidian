import type { VaultStore } from './vault-store.ts';
/** 每页标签上限（对齐上游 tag-taxonomy 的 "max 5 tags per page"）。 */
export declare const TAG_LIMIT = 5;
/** 词表相对 .wiki 的路径（库级层）。与上游 _meta/taxonomy.md 同路径。 */
export declare const TAXONOMY_REL = "_meta/taxonomy.md";
/** Type 轴的小节名。文件里可写作「Type — 知识类型」，解析后 section 必须正好是它。 */
export declare const TYPE_SECTION = "Type";
/**
 * 系统标签组前缀：上游预留 visibility/ 用于可见性（public/internal/pii）。
 * 约定：不计入 TAG_LIMIT、不参与别名映射、审计时单独报告而不算「未知标签」。
 */
export declare const SYSTEM_TAG_PREFIX = "visibility/";
/** 条目来源层：base = 随插件的共享层；vault = 本库层。 */
export type TagOrigin = 'base' | 'vault';
export interface TaxonomyEntry {
    tag: string;
    section: string;
    description: string;
    aliases: string[];
    origin: TagOrigin;
}
export interface Taxonomy {
    entries: TaxonomyEntry[];
    /** 规范词集合（两层并集） */
    canonical: Set<string>;
    /** 别名 → 规范词（两层并集，库级优先） */
    aliases: Map<string, string>;
    /** 出现顺序的小节名（基础层在前） */
    sections: string[];
    /** 基础层提供的规范词（用于判定「本库新增的 Type 词」） */
    baseTags: Set<string>;
    /** 基础层是否提供了有效词条 */
    hasBase: boolean;
    /** 是否存在有效的库级词表文件 */
    hasVaultFile: boolean;
}
/** 基础词表的路径：包根（lib/ 的上一级）。安装副本即 node_modules/dsh-knj-obsidian/taxonomy.base.md。 */
export declare function baseTaxonomyPath(): string;
/**
 * 解析词表 markdown。可解析的条目格式（其余内容一律当散文忽略）：
 *
 *   ## Domain
 *   - `dsh` — DSH 宿主本体：插件体系、会话机制、编排工具
 *     - aliases: deepseek-harness, plugins
 *
 * 即：`## ` 开小节（`—` 之后的中文注解不进入 section 标识）；`- \`词\``（行首无缩进）
 * 声明一个规范词，`—` 之后是说明；紧随其后的缩进 `- aliases:` 行给该词挂别名。
 * 规则段落里的普通 `- 说明` 不会被误收，因为规范词行**必须**以反引号包裹的词开头。
 */
export declare function parseTaxonomy(text: string, origin?: TagOrigin): Taxonomy;
/**
 * 合并两层：基础层在前，库级层覆盖同名词（描述/别名），但保持基础层的顺序。
 * 任一层为 null 都可以；两层都空则返回 null。
 */
export declare function mergeTaxonomies(base: Taxonomy | null, vault: Taxonomy | null): Taxonomy | null;
export interface LoadTaxonomyOptions {
    /**
     * 覆盖基础层文本，便于测试：
     * - 不传（undefined）→ 读随插件分发的 taxonomy.base.md
     * - null → 显式不用基础层
     * - 字符串 → 用该文本当基础层（空串/只有小节标题都按「无有效基础词表」处理）
     */
    baseText?: string | null;
}
/**
 * 读取生效词表（基础层 ∪ 库级层）。两层都没有有效规范词时返回 null——
 * 调用方据此**跳过**规范词相关检查，而不是把整库标签报成未知，更不是抛异常。
 */
export declare function loadTaxonomy(store: VaultStore, opts?: LoadTaxonomyOptions): Taxonomy | null;
/** 系统标签（visibility/*）等豁免词：不计上限、不参与别名映射、不算未知。 */
export declare function isSystemTag(tag: string): boolean;
