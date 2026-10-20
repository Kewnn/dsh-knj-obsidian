const LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const normTitle = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/** 对单页扫描库内相关已有页（排除自身与同批产出的页）。只读，扫描失败不阻断。 */
export function relatedHits(store, exclude, p) {
    const out = [];
    const title = p.title.trim();
    if (!title)
        return out;
    try {
        const links = new Set();
        for (const m of p.body.matchAll(LINK_RE))
            links.add(m[1].trim());
        const tnorm = normTitle(title);
        const hits = [];
        for (const sp of store.listPagesReadonly()) {
            if (sp.id === p.id || exclude.has(sp.id))
                continue;
            const page = store.readPage(sp.id, sp.category);
            if (!page)
                continue;
            const normT = normTitle(page.title);
            const matchedBy = normT === tnorm ? 'title'
                : (normT.length >= 2 && tnorm.length >= 2 && (normT.includes(tnorm) || tnorm.includes(normT))) ? 'title'
                    : (normT.length >= 2 && page.body.toLowerCase().includes(tnorm)) ? 'body'
                        : null;
            if (!matchedBy)
                continue;
            hits.push({
                id: sp.id,
                title: page.title,
                category: sp.category,
                matchedBy,
                linked: links.has(sp.id),
                strong: matchedBy === 'title' && normT === tnorm,
            });
        }
        // strong 优先、title 次之、body 最后；同类保持扫描序；截断 5 条
        const rank = (h) => (h.strong ? 0 : h.matchedBy === 'title' ? 1 : 2);
        out.push(...hits.sort((a, b) => rank(a) - rank(b)).slice(0, 5));
    }
    catch {
        /* 扫描失败不阻断写入 */
    }
    return out;
}
