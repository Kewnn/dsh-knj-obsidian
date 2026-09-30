import { loadTaxonomy, isSystemTag, TAG_LIMIT, TYPE_SECTION } from "./taxonomy.js";
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
/** 业务标签：排除系统标签组（visibility/*）——它们不计上限、不参与别名映射、不算未知。 */
function domainTags(tags) {
    return tags.filter((t) => !isSystemTag(t));
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
export function auditTags(store, taxonomy = loadTaxonomy(store)) {
    const pages = store.listPages();
    const unknownPages = new Map();
    const aliasPages = new Map();
    const overTagged = [];
    const untagged = [];
    for (const p of pages) {
        const page = store.readPage(p.id, p.category);
        if (!page)
            continue; // 无 frontmatter 的页已由 missingFrontmatter 报，这里不重复报
        const tags = domainTags(page.tags);
        if (tags.length === 0)
            untagged.push(p.id);
        if (tags.length > TAG_LIMIT)
            overTagged.push({ id: p.id, count: tags.length, tags });
        if (!taxonomy)
            continue;
        for (const t of tags) {
            const canonical = taxonomy.aliases.get(t);
            if (canonical) {
                const hit = aliasPages.get(t) ?? { canonical, pages: [] };
                hit.pages.push(p.id);
                aliasPages.set(t, hit);
            }
            else if (!taxonomy.canonical.has(t)) {
                const list = unknownPages.get(t) ?? [];
                list.push(p.id);
                unknownPages.set(t, list);
            }
        }
    }
    const byTag = (a, b) => (a.tag < b.tag ? -1 : 1);
    const unknown = [...unknownPages.entries()].map(([tag, pgs]) => ({ tag, pages: pgs })).sort(byTag);
    return {
        taxonomyPresent: taxonomy !== null,
        vaultTaxonomyPresent: taxonomy?.hasVaultFile ?? false,
        unknown,
        aliasUsed: [...aliasPages.entries()].map(([tag, v]) => ({ tag, canonical: v.canonical, pages: v.pages })).sort(byTag),
        overTagged,
        untagged,
        // 升表门槛就是词表自己写的那条：≥2 页才值得新增
        promote: unknown.filter((u) => u.pages.length >= 2),
        localTypeTags: taxonomy
            ? taxonomy.entries
                .filter((e) => e.origin === 'vault' && e.section === TYPE_SECTION && !taxonomy.baseTags.has(e.tag))
                .map((e) => e.tag)
                .sort()
            : [],
        // 库级重复登记基础层已有的词 → 会遮蔽基础层的后续更新
        shadowedBaseTags: taxonomy
            ? taxonomy.entries
                .filter((e) => e.origin === 'vault' && taxonomy.baseTags.has(e.tag))
                .map((e) => e.tag)
                .sort()
            : [],
    };
}
export function lintVault(store, opts = {}) {
    const pages = store.listPages();
    const ids = new Set(pages.map((p) => p.id));
    const incoming = new Map();
    const outCount = new Map();
    const brokenLinks = [];
    const missingFrontmatter = [];
    for (const p of pages) {
        const page = store.readPage(p.id, p.category);
        if (!page) {
            // 读不出来（无 frontmatter）的页面：标记缺 frontmatter，正文不可解析，无出链
            missingFrontmatter.push(p.id);
            continue;
        }
        if (!page.created || !page.source || !page.confidence) {
            missingFrontmatter.push(p.id);
        }
        const body = page.body;
        let out = 0;
        for (const m of body.matchAll(WIKILINK_RE)) {
            out += 1;
            const target = m[1].trim();
            if (!ids.has(target)) {
                brokenLinks.push({ from: p.id, target });
            }
            else {
                const list = incoming.get(target) ?? [];
                list.push(p.id);
                incoming.set(target, list);
            }
        }
        outCount.set(p.id, out);
    }
    // 孤儿定义（有意与 graph-engine.ts 不同，双语义并存，勿"统一"）：
    // - lint 此处为「宽语义」：双向链接未织好的页面都算孤儿（有出无入、有入无出、完全无链接），
    //   即只有「既有出链又有入链」的页面才算真正织入图谱——服务检查清单；
    // - graph-engine 为「严格语义」（!hasOut && !hasIn 才灰显）——服务视觉呈现，仅有入链的页不是视觉孤点。
    const orphans = pages
        .filter((p) => {
        const hasOut = (outCount.get(p.id) ?? 0) > 0;
        const hasIn = (incoming.get(p.id) ?? []).length > 0;
        return !hasOut || !hasIn;
    })
        .map((p) => p.id);
    return { orphans, brokenLinks, missingFrontmatter, pageCount: pages.length, tags: auditTags(store, loadTaxonomy(store, opts)) };
}
