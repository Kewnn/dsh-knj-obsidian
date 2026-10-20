// src/mining-progress.ts
// 断点续传：模块级进度（pending/done/partial）。每模块完成后写回，
// 中断最多丢一个模块。文件落 vault _system/tools/progress-<kind>.json。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function readProgress(progressFile, kind) {
    if (existsSync(progressFile)) {
        try {
            const parsed = JSON.parse(readFileSync(progressFile, 'utf8'));
            if (parsed.version === 1 && parsed.kind === kind)
                return parsed;
        }
        catch { /* 损坏文件按空进度处理 */ }
    }
    return { version: 1, kind, modules: {} };
}
export function markModule(progress, module, state, progressFile) {
    progress.modules[module] = { state, updatedAt: new Date().toISOString() };
    writeFileSync(progressFile, JSON.stringify(progress, null, 2), 'utf8');
}
export function pendingModules(progress) {
    return Object.entries(progress.modules)
        .filter(([, s]) => s.state === 'pending' || s.state === 'partial')
        .map(([m]) => m);
}
export function progressFileFor(wikiRoot, kind) {
    return join(wikiRoot, '_system', 'tools', `progress-${kind}.json`);
}
