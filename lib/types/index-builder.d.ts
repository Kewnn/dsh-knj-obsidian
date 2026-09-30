import { summarizeBody } from './vault-store.ts';
import type { VaultStore } from './vault-store.ts';
/**
 * 摘要规则由 vault-store 统一提供，且两个派生工件必须给出同一句话：index.md 的描述
 * 优先取页面 frontmatter 的 `summary:`（那正是写进文件的权威值），只有页面没有该字段时
 * 才回退到从正文派生。否则人工撰写的摘要会出现「frontmatter 一个说法、index.md 另一个
 * 说法」，且 index-only 快速层无法用摘要检索到页面。
 * 保留 `summarize` 这个旧导出名，避免破坏既有调用方与声明产物。
 */
export { summarizeBody as summarize };
/** 幂等重建 index.md；返回 { pageCount }。 */
export declare function rebuildIndex(store: VaultStore): {
    pageCount: number;
};
