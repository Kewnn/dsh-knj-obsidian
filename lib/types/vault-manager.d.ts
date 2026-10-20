import { VaultStore } from './vault-store.ts';
import type { VaultListEntry, VaultProvider, VaultRecord } from './types.ts';
/** 宿主工作区种子（path=工作区根目录，title=展示名） */
export interface WorkspaceSeed {
    path: string;
    title?: string;
}
export interface VaultManagerOptions {
    /** 注册表文件路径（默认 <DSH_HOME|~/.dsh>/knj-obsidian/vaults.json） */
    registryFile: string;
    /** 宿主进程启动目录（cwd 种子，保证「打开就有库」） */
    cwdRoot: string;
    /** 宿主工作区列表（自动发现每个工作区的库） */
    workspaceRoots?: WorkspaceSeed[];
}
export declare class VaultManager implements VaultProvider {
    private readonly opts;
    private registry;
    private readonly seeds;
    /** root → VaultStore 复用：VaultStore 携带 mtime 页缓存，按请求新建实例会让缓存永远失效 */
    private readonly stores;
    constructor(opts: VaultManagerOptions);
    private load;
    /** 原子写：tmp + rename（崩溃不会留下截断的半份注册表；Windows rename 被占用时回退直接写）。 */
    private persist;
    private persistIfChanged;
    private seed;
    listVaults(): VaultListEntry[];
    currentRecord(): VaultRecord | null;
    /** 按根取复用的 VaultStore（首次创建时可选 ensure 脚手架）。 */
    private storeFor;
    current(): VaultStore;
    /** 只读视图：返回复用 store，绝不 ensure()/mkdir（GET 端点零写副作用）。 */
    currentReadonly(): VaultStore;
    switchVault(id: string): VaultRecord | null;
    /**
     * 自动跟随（工作区激活）：只注册 + 切换当前库，**不写盘建库**。
     * 建库是显式动作（边栏「初始化知识库」→ agent 调 wiki_init，或用户显式挂接/首次真实写入）。
     */
    activateRoot(root: string): VaultRecord;
    /** 只登记进注册表（零写盘）：未注册目录的自动发现路径用。 */
    private registerRoot;
    attachRoot(root: string, name?: string): VaultRecord;
    removeVault(id: string): boolean;
    private find;
    private countPages;
}
