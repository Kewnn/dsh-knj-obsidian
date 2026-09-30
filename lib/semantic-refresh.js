// src/semantic-refresh.ts — 语义索引的「新鲜度」：自动/手动刷新 + 只读状态视图。
//
// 设计约束：
// 1) 严格离线：只在模型本地就位时才跑；缺模型只回报，不联网、不报错。
// 2) 单飞（single-flight）：同一库同时只允许一次刷新，重复调用复用同一个 promise。
// 3) 后台化：刷新在后台跑（真实库冷启动 ~1.5 分钟、稳态 ~40ms/篇），调用方拿到的是
//    「已开始/进行中」而不是阻塞到结束；进度靠 status() 轮询（读 sqlite 的待嵌入数在下降）。
// 4) 不抛异常：任何失败都变成结果里的 note，交给 UI/agent 如实展示。
import { join } from 'node:path';
import { classifyStatus, createSemanticRuntime, notReadyMessage, pendingEmbeddingCount, resolveStateHome, DEFAULT_MODEL_FILENAME, } from "./semantic-index.js";
export const DEFAULT_DEBOUNCE_MS = 15_000;
export const DEFAULT_MAX_AUTO_DOCS = 500;
/** 把 qmd 状态喂给纯函数分类器，返回 {indexState, documents, pendingEmbedding, hasVectorIndex}。 */
export function summarizeStatus(raw) {
    const value = raw ?? {};
    return {
        indexState: classifyStatus(value),
        documents: value.totalDocuments ?? value.documents ?? 0,
        pendingEmbedding: pendingEmbeddingCount(value),
        hasVectorIndex: value.hasVectorIndex ?? (value.embeddings !== undefined),
    };
}
export function createRefresher(opts) {
    const now = opts.now ?? (() => Date.now());
    const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const maxAutoDocs = opts.maxAutoDocs ?? DEFAULT_MAX_AUTO_DOCS;
    const runtimeFactory = opts.runtimeFactory
        ?? ((o) => createSemanticRuntime(o));
    let timer = null;
    let running = null;
    let startedAtMs = null;
    let lastRun;
    let coldStartMs;
    let disposed = false;
    async function run() {
        const startedMs = now();
        startedAtMs = startedMs;
        const at = new Date().toISOString();
        const runtime = await runtimeFactory({ vaultRoot: opts.vaultRoot, home: opts.home });
        const paths = resolveStateHome(opts.home);
        if (!runtime.modelPresent) {
            return {
                ok: false, at, documents: 0, chunks: 0, durationMs: now() - startedMs,
                note: notReadyMessage('model-missing', paths.modelsDir, DEFAULT_MODEL_FILENAME),
            };
        }
        if (!runtime.store) {
            return {
                ok: false, at, documents: 0, chunks: 0, durationMs: now() - startedMs,
                note: notReadyMessage('library-missing'),
            };
        }
        const store = runtime.store;
        try {
            await store.update();
            const embedded = await store.embed();
            const durationMs = now() - startedMs;
            if (coldStartMs === undefined)
                coldStartMs = durationMs;
            return {
                ok: true, at,
                documents: embedded?.docsProcessed ?? 0,
                chunks: embedded?.chunksEmbedded ?? 0,
                durationMs,
            };
        }
        catch (error) {
            return {
                ok: false, at, documents: 0, chunks: 0, durationMs: now() - startedMs,
                note: `刷新失败：${error instanceof Error ? error.message : String(error)}`,
            };
        }
        finally {
            try {
                await store.close?.();
            }
            catch { /* 关闭失败不影响结果 */ }
        }
    }
    function refreshNow() {
        if (running)
            return running;
        const promise = run()
            .then((result) => { lastRun = result; return result; })
            .catch((error) => {
            const fallback = {
                ok: false, at: new Date().toISOString(), documents: 0, chunks: 0, durationMs: 0,
                note: `刷新异常：${error instanceof Error ? error.message : String(error)}`,
            };
            lastRun = fallback;
            return fallback;
        })
            .finally(() => {
            running = null;
            startedAtMs = null;
        });
        running = promise;
        return promise;
    }
    async function fire() {
        timer = null;
        const view = await status();
        if (view.pendingEmbedding > maxAutoDocs) {
            lastRun = {
                ok: false, at: new Date().toISOString(), documents: 0, chunks: 0, durationMs: 0,
                note: `待嵌入 ${view.pendingEmbedding} 篇，超过自动刷新上限 ${maxAutoDocs} 篇：已跳过自动刷新，请在边栏点「更新索引」。`,
            };
            return;
        }
        await refreshNow();
    }
    function schedule() {
        if (disposed)
            return;
        // 关掉自动刷新（仍可用边栏「更新索引」手动跑）：KNJ_OBSIDIAN_AUTO_REFRESH=off
        if ((process.env.KNJ_OBSIDIAN_AUTO_REFRESH ?? '').trim().toLowerCase() === 'off')
            return;
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => { void fire(); }, debounceMs);
        // 后台任务不阻止宿主退出
        if (typeof timer.unref === 'function')
            timer.unref();
    }
    async function status() {
        const base = {
            available: false,
            modelPresent: false,
            indexState: 'index-empty',
            documents: 0,
            pendingEmbedding: 0,
            hasVectorIndex: false,
            refreshing: running !== null,
            ...(startedAtMs === null ? {} : { startedAt: new Date(startedAtMs).toISOString(), elapsedMs: now() - startedAtMs }),
            ...(coldStartMs === undefined ? {} : { coldStartMs }),
            ...(lastRun === undefined ? {} : { lastRun }),
        };
        let runtime = null;
        try {
            runtime = await runtimeFactory({ vaultRoot: opts.vaultRoot, home: opts.home });
        }
        catch (error) {
            return { ...base, note: `语义状态读取失败：${error instanceof Error ? error.message : String(error)}` };
        }
        if (!runtime.modelPresent) {
            return { ...base, modelPresent: false, note: notReadyMessage('model-missing', resolveStateHome(opts.home).modelsDir, DEFAULT_MODEL_FILENAME) };
        }
        if (!runtime.store) {
            return { ...base, modelPresent: true, note: notReadyMessage('library-missing') };
        }
        try {
            const raw = await runtime.store.getStatus();
            const summary = summarizeStatus(raw);
            return { ...base, available: true, modelPresent: true, ...summary };
        }
        catch (error) {
            return { ...base, modelPresent: true, note: `索引状态读取失败：${error instanceof Error ? error.message : String(error)}` };
        }
        finally {
            try {
                await runtime.store.close?.();
            }
            catch { /* 关闭失败不影响状态 */ }
        }
    }
    function dispose() {
        disposed = true;
        if (timer)
            clearTimeout(timer);
        timer = null;
    }
    return { schedule, refreshNow, status, dispose };
}
// ---------- 按库缓存（工具与路由共用同一个刷新器，保证单飞语义生效） ----------
const registry = new Map();
export function refresherFor(vaultRoot, home) {
    const key = `${vaultRoot}::${home ?? ''}`;
    const existing = registry.get(key);
    if (existing)
        return existing;
    const created = createRefresher({ vaultRoot, home: home ?? undefined });
    registry.set(key, created);
    return created;
}
export function disposeRefreshers() {
    for (const refresher of registry.values())
        refresher.dispose();
    registry.clear();
}
/** 由 vault store 推出库根（.wiki 的父目录）。 */
export function vaultRootOf(store) {
    return join(store.wikiRoot, '..');
}
