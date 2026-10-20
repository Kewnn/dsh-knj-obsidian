// src/vault-manager.ts
// v7 多 vault 管理：注册表（持久化）+ 当前库切换 + 新建/挂接/移除 + 工作区自动发现。
// 注册表只记录库的「身份与指向」，绝不移动/删除磁盘上的库文件。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { VaultStore } from "./vault-store.js";
import { vaultIdOf } from "./types.js";
function defaultNameFor(root, seeds) {
    const r = resolve(root);
    const hit = seeds.find((s) => resolve(s.path) === r);
    if (hit?.title?.trim())
        return hit.title.trim();
    return basename(r) || r;
}
export class VaultManager {
    opts;
    registry = { version: 1, currentVaultId: null, vaults: [] };
    seeds;
    /** root → VaultStore 复用：VaultStore 携带 mtime 页缓存，按请求新建实例会让缓存永远失效 */
    stores = new Map();
    constructor(opts) {
        this.opts = opts;
        this.seeds = opts.workspaceRoots ?? [];
        this.load();
        this.seed();
    }
    // ---------- 持久化（tmp+rename 原子写；仅内容变化时写盘） ----------
    load() {
        try {
            if (!existsSync(this.opts.registryFile))
                return;
            const raw = JSON.parse(readFileSync(this.opts.registryFile, 'utf8'));
            if (raw && Array.isArray(raw.vaults)) {
                this.registry = {
                    version: 1,
                    currentVaultId: typeof raw.currentVaultId === 'string' ? raw.currentVaultId : null,
                    // 过滤畸形条目（root 必须存在）；id 缺失/不合法时按根重算
                    vaults: raw.vaults
                        .filter((v) => !!v && typeof v.root === 'string' && typeof v.name === 'string')
                        .map((v) => ({ id: vaultIdOf(v.root), name: v.name, root: resolve(v.root), source: v.source })),
                    removedRoots: Array.isArray(raw.removedRoots) ? raw.removedRoots.filter((r) => typeof r === 'string') : [],
                };
            }
        }
        catch {
            // 损坏的注册表从空重建，不崩
        }
    }
    /** 原子写：tmp + rename（崩溃不会留下截断的半份注册表；Windows rename 被占用时回退直接写）。 */
    persist() {
        mkdirSync(dirname(this.opts.registryFile), { recursive: true });
        const json = JSON.stringify(this.registry, null, 2);
        const tmp = this.opts.registryFile + '.tmp-' + Date.now();
        writeFileSync(tmp, json, 'utf8');
        try {
            renameSync(tmp, this.opts.registryFile);
        }
        catch {
            try {
                rmSync(tmp, { force: true });
            }
            catch { /* best effort */ }
            writeFileSync(this.opts.registryFile, json, 'utf8');
        }
    }
    persistIfChanged(before) {
        if (JSON.stringify(this.registry) !== before)
            this.persist();
    }
    // ---------- 种子（幂等，每次启动执行；尊重 removedRoots 的移除决定） ----------
    seed() {
        const before = JSON.stringify(this.registry);
        const removed = new Set((this.registry.removedRoots ?? []).map((r) => resolve(r)));
        const add = (root, source) => {
            const r = resolve(root);
            if (removed.has(r))
                return;
            if (this.registry.vaults.some((v) => resolve(v.root) === r))
                return;
            this.registry.vaults.push({ id: vaultIdOf(r), name: defaultNameFor(r, this.seeds), root: r, source });
        };
        add(this.opts.cwdRoot, 'cwd');
        for (const w of this.seeds) {
            // 目录已消失的已注册工作区跳过，避免幽灵库
            if (!existsSync(w.path))
                continue;
            add(w.path, 'workspace');
        }
        const current = this.registry.vaults.find((v) => v.id === this.registry.currentVaultId);
        if (!current) {
            const first = this.registry.vaults.find((v) => resolve(v.root) === resolve(this.opts.cwdRoot)) ?? this.registry.vaults[0];
            this.registry.currentVaultId = first?.id ?? null;
        }
        this.persistIfChanged(before);
    }
    // ---------- VaultProvider ----------
    listVaults() {
        return this.registry.vaults.map((v) => ({
            ...v,
            pageCount: this.countPages(v.root),
            // 未初始化 = 磁盘上还没有 .wiki（注册≠建库；初始化只由显式动作或首次写入触发）
            initialized: existsSync(join(v.root, '.wiki')),
        }));
    }
    currentRecord() {
        return this.find(this.registry.currentVaultId) ?? this.registry.vaults[0] ?? null;
    }
    /** 按根取复用的 VaultStore（首次创建时可选 ensure 脚手架）。 */
    storeFor(root, ensure) {
        const r = resolve(root);
        let store = this.stores.get(r);
        if (!store) {
            store = new VaultStore(r);
            this.stores.set(r, store);
            if (ensure)
                store.ensure();
        }
        return store;
    }
    current() {
        const rec = this.currentRecord();
        if (!rec) {
            // 防御：seed 后至少存在 cwd 库；仍兜底直接以 cwd 建库
            return this.storeFor(this.opts.cwdRoot, true);
        }
        return this.storeFor(rec.root, true);
    }
    /** 只读视图：返回复用 store，绝不 ensure()/mkdir（GET 端点零写副作用）。 */
    currentReadonly() {
        const rec = this.currentRecord();
        if (!rec)
            return this.storeFor(this.opts.cwdRoot, false);
        return this.storeFor(rec.root, false);
    }
    switchVault(id) {
        const rec = this.find(id);
        if (!rec)
            return null;
        this.registry.currentVaultId = rec.id;
        this.persist();
        return rec;
    }
    /**
     * 自动跟随（工作区激活）：只注册 + 切换当前库，**不写盘建库**。
     * 建库是显式动作（边栏「初始化知识库」→ agent 调 wiki_init，或用户显式挂接/首次真实写入）。
     */
    activateRoot(root) {
        const r = resolve(root);
        const existing = this.registry.vaults.find((v) => resolve(v.root) === r);
        const rec = existing ?? this.registerRoot(r);
        this.registry.currentVaultId = rec.id;
        this.persist();
        return rec;
    }
    /** 只登记进注册表（零写盘）：未注册目录的自动发现路径用。 */
    registerRoot(root, name) {
        const r = resolve(root);
        const removed = this.registry.removedRoots ?? [];
        if (removed.some((x) => resolve(x) === r)) {
            this.registry.removedRoots = removed.filter((x) => resolve(x) !== r);
        }
        const already = this.registry.vaults.find((v) => resolve(v.root) === r);
        if (already)
            return already;
        const rec = { id: vaultIdOf(r), name: name?.trim() || basename(r) || r, root: r, source: 'workspace' };
        this.registry.vaults.push(rec);
        this.registry.currentVaultId = rec.id;
        this.persist();
        return rec;
    }
    attachRoot(root, name) {
        const r = resolve(root);
        // 目录不存在 → 自动创建（新建库）；已存在 → 直接挂接。库文件永不删除/移动。
        if (!existsSync(r))
            mkdirSync(r, { recursive: true });
        this.storeFor(r, true).ensure(); // 脚手架 .wiki（index/manifest/分类目录，零页面）
        // 显式挂接是最强的回来意图：清除历史移除标记
        const removed = this.registry.removedRoots ?? [];
        if (removed.some((x) => resolve(x) === r)) {
            this.registry.removedRoots = removed.filter((x) => resolve(x) !== r);
        }
        const existing = this.registry.vaults.find((v) => resolve(v.root) === r);
        if (existing) {
            if (name?.trim()) {
                existing.name = name.trim();
                this.persist();
            }
            return existing;
        }
        const rec = { id: vaultIdOf(r), name: name?.trim() || basename(r) || r, root: r, source: 'attached' };
        this.registry.vaults.push(rec);
        this.registry.currentVaultId = rec.id;
        this.persist();
        return rec;
    }
    removeVault(id) {
        const idx = this.registry.vaults.findIndex((v) => v.id === id);
        if (idx === -1)
            return false;
        // 任何来源的库都可移除：cwd/workspace 种子每次启动会重新尝试加入，
        // 因此把根目录记入 removedRoots 才能让移除在重启后仍然生效（显式 attach 可解除）。
        const removedRoot = resolve(this.registry.vaults[idx].root);
        this.registry.vaults.splice(idx, 1);
        this.registry.removedRoots = [...(this.registry.removedRoots ?? []), removedRoot];
        if (this.registry.currentVaultId === id) {
            this.registry.currentVaultId = this.registry.vaults[0]?.id ?? null;
        }
        this.persist();
        return true;
    }
    // ---------- 内部 ----------
    find(id) {
        if (!id)
            return undefined;
        return this.registry.vaults.find((v) => v.id === id);
    }
    countPages(root) {
        try {
            return this.storeFor(root, false).listPagesReadonly().length;
        }
        catch {
            return 0;
        }
    }
}
