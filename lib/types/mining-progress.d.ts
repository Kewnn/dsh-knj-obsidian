export type MiningKind = 'enum' | 'db';
export type ModuleStateValue = 'pending' | 'done' | 'partial';
export interface ModuleState {
    state: ModuleStateValue;
    updatedAt: string;
}
export interface MiningProgress {
    version: 1;
    kind: MiningKind;
    modules: Record<string, ModuleState>;
}
export declare function readProgress(progressFile: string, kind: MiningKind): MiningProgress;
export declare function markModule(progress: MiningProgress, module: string, state: ModuleStateValue, progressFile: string): void;
export declare function pendingModules(progress: MiningProgress): string[];
export declare function progressFileFor(wikiRoot: string, kind: MiningKind): string;
