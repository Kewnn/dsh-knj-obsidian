import { homedir } from 'node:os';
import { join } from 'node:path';
import { VaultManager } from "./vault-manager.js";
import { mountTools } from "./tools.js";
import { mountWikiRoutes } from "./routes.js";
import { installTrigger } from "./trigger.js";
export const name = 'dsh-knj-obsidian';
function defaultRegistryPath() {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(dshHome, 'knj-obsidian', 'vaults.json');
}
export function apply(ctx, config) {
    // ⚠️ workspaceRegistry 是「可选」依赖，绝不能写进 inject 数组：cordis 对硬依赖缺失的
    // entry 置 INACTIVE，回调永不执行——routes 和 tools 会整体静默失效（宿主改名/移除该服务时）。
    // tools/webServer 由官方 base bundles 保证提供，是安全的核心依赖。
    ctx.inject(['tools', 'webServer'], (hostCtx) => {
        const host = hostCtx;
        // 防御性读取 workspaceRegistry：注入后容忍服务异常/缺失，失败仅回退 cwd 单库
        let workspaceRoots = [];
        try {
            const withGet = hostCtx;
            const registry = withGet.workspaceRegistry
                ?? (typeof withGet.get === 'function' ? withGet.get('workspaceRegistry') : undefined);
            workspaceRoots = registry?.list() ?? [];
        }
        catch {
            // 宿主未提供 workspaceRegistry：仅 cwd 种子，不阻塞启动
        }
        const manager = new VaultManager({
            registryFile: config?.vaultRegistryFile ?? defaultRegistryPath(),
            cwdRoot: process.cwd(),
            workspaceRoots,
        });
        const disposeTools = mountTools(hostCtx, manager);
        const disposeRoutes = mountWikiRoutes(host, manager);
        // 任务级知识触发（L1）+ 回合级沉淀提醒（L5）：只读、不阻断，KNJ_OBSIDIAN_TRIGGER=off 可关。
        const disposeTrigger = installTrigger(hostCtx, manager);
        return () => {
            disposeTools();
            disposeRoutes();
            disposeTrigger();
        };
    });
}
