// src/types.ts
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
/** 由规范化 root 派生的稳定 vault id（跨进程一致）。 */
export function vaultIdOf(root) {
    return 'v-' + createHash('sha1').update(resolve(root)).digest('hex').slice(0, 12);
}
