import type { VaultStore } from './vault-store.ts';
import { type Taxonomy, type LoadTaxonomyOptions } from './taxonomy.ts';
/** 标签审计结果（对齐上游 tag-taxonomy Mode 1 的四类问题 + 分层词表带来的两项提示）。 */
export interface TagAudit {
    /** 是否存在可用词表（基础层或本库层任一有效）。false 时 unknown/aliasUsed/promote 恒为空 */
    taxonomyPresent: boolean;
    /** 是否存在有效的**本库**词表文件（_meta/taxonomy.md）。false 表示只靠基础层的 Type 轴 */
    vaultTaxonomyPresent: boolean;
    /** 不在词表里的标签（≥1 页）*/
    unknown: {
        tag: string;
        pages: string[];
    }[];
    /** 用了别名而非规范词 */
    aliasUsed: {
        tag: string;
        canonical: string;
        pages: string[];
    }[];
    /** 超过每页上限的页（系统标签不计入）*/
    overTagged: {
        id: string;
        count: number;
        tags: string[];
    }[];
    /** 零标签页（系统标签不算「有标签」）*/
    untagged: string[];
    /**
     * 升表候选：出现 **≥2 页**的未知词。按词表自己的门槛，只有这些才值得进库级词表——
     * 只出现 1 页的应当换成更宽的规范词，而不是新增。
     */
    promote: {
        tag: string;
        pages: string[];
    }[];
    /**
     * 「上游候选」：本库词表里新增的 Type 词（基础层没有）。Type 轴影响跨项目可比性，
     * 所以新 Type 词先在库级用一阵，确认在 ≥2 个项目都要用后再提到基础层随插件发布。
     */
    localTypeTags: string[];
    /**
     * 「遮蔽」：库级词表**重复登记了基础层已有的词**。因为合并规则是「库级覆盖基础层」，
     * 这些重复项会让基础层对该词的后续更新永远到不了这个库。库级文件只该管 Domain/Project。
     */
    shadowedBaseTags: string[];
}
export interface LintReport {
    orphans: string[];
    brokenLinks: {
        from: string;
        target: string;
    }[];
    missingFrontmatter: string[];
    pageCount: number;
    /** 标签审计（对齐上游 tag-taxonomy；无有效词表时仍给出 overTagged/untagged） */
    tags: TagAudit;
}
/**
 * 标签审计。四类问题与上游一致：未知 / 别名 / 超上限 / 零标签；另加两项分层带来的提示：
 * 升表候选（≥2 页的未知词）与上游候选（库级新增的 Type 词）。
 *
 * 设计取舍（对齐上游）：
 * - 没有**任何**有效词表时**不报**未知/别名/升表——没有「规范」可言，把整库标签报成未知只会是噪声。
 *   超上限与零标签不依赖词表，照报。
 * - 系统标签 visibility/* 全部豁免：不计上限、不查别名、不算未知，也不算「这页有标签」。
 * - 判定优先级：规范词 > 别名 > 未知。
 */
export declare function auditTags(store: VaultStore, taxonomy?: Taxonomy | null): TagAudit;
export declare function lintVault(store: VaultStore, opts?: LoadTaxonomyOptions): LintReport;
