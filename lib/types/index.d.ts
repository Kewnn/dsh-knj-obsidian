import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-knj-obsidian";
export interface Config {
    /** vault 目录名（默认 .wiki）。v1 未实现：apply 忽略 config，目录名为 vault-store 硬编码常量；v2 接入。 */
    vaultDirName?: string;
    /** vault 注册表文件路径（v7；默认 <DSH_HOME|~/.dsh>/knj-obsidian/vaults.json） */
    vaultRegistryFile?: string;
}
export declare function apply(ctx: Context, config?: Config): void;
