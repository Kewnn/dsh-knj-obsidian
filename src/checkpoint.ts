// src/checkpoint.ts — 还原点（写前快照 + 整库恢复）
// 位置：<vault>/.wiki/_system/checkpoints/<ts>/（内部运行数据，不参与知识检索）
// 内容：七个分类目录的全部 .md + index.md + .manifest.json；恢复时按快照集合整库回写
//（快照中不存在的页面视为“快照前不存在”，恢复时删除——保证批次可整体回滚）。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultStoreLike } from './types.ts'
import type { WikiCategory } from './types.ts'
import { SaveError } from './vault-store.ts'

const CATEGORIES: readonly WikiCategory[] = ['concepts', 'entities', 'references', 'synthesis', 'projects', 'dictionaries', 'tables']
const SNAPSHOT_FILES = ['index.md', '.manifest.json'] as const
/** 还原点 id 的严格形态（createCheckpoint 生成：ISO 时间戳中 : 与 . 替换为 -）。 */
const CHECKPOINT_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

export interface CheckpointMeta { id: string; createdAt: string; pageCount: number }

function checkpointsRoot(store: VaultStoreLike): string {
  return join(store.wikiRoot, '_system', 'checkpoints')
}

/** 校验还原点 id：必须是本模块生成的时间戳形态；拒绝任何路径穿越/怪异片段。 */
function assertCheckpointId(id: string): void {
  if (!CHECKPOINT_ID_RE.test(id)) throw new SaveError(400, `非法还原点 id：${id}`)
}

/** 创建还原点：拷贝当前全部正式页面 + 派生工件；返回元数据。 */
export function createCheckpoint(store: VaultStoreLike): CheckpointMeta {
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(checkpointsRoot(store), id)
  mkdirSync(dest, { recursive: true })
  for (const c of CATEGORIES) {
    const src = join(store.wikiRoot, c)
    if (existsSync(src)) cpSync(src, join(dest, c), { recursive: true })
  }
  for (const f of SNAPSHOT_FILES) {
    const src = join(store.wikiRoot, f)
    if (existsSync(src)) cpSync(src, join(dest, f))
  }
  const pageCount = CATEGORIES.reduce((n, c) => {
    const dir = join(store.wikiRoot, c)
    return n + (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0)
  }, 0)
  return { id, createdAt: new Date().toISOString(), pageCount }
}

/** 列出全部还原点（新→旧）。 */
export function listCheckpoints(store: VaultStoreLike): CheckpointMeta[] {
  const root = checkpointsRoot(store)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const id = e.name
      const dir = join(root, id)
      const pageCount = CATEGORIES.reduce((n, c) => {
        const d = join(dir, c)
        return n + (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')).length : 0)
      }, 0)
      return { id, createdAt: id.replace(/-(\d{2})-(\d{2})$/, ':$1:$2'), pageCount }
    })
    .sort((a, b) => b.id.localeCompare(a.id))
}

/**
 * 恢复到指定还原点。两种模式：
 * - `merge`（默认，非破坏性）：只把快照里的页面**覆盖回**（撤销批次对既有页的修改），
 *   **保留**快照之后新增的页面（可能是其它会话/agent 的正当产物），不动它们；
 * - `exact`（显式选择）：整库回到快照状态，删除快照之后新增的页面。
 *
 * 为什么默认非破坏性：回滚的用途是撤销「刚跑坏的那一批」，而不是抹掉之后所有人的工作。
 */
export function restoreCheckpoint(
  store: VaultStoreLike,
  id: string,
  mode: 'merge' | 'exact' = 'merge',
): { ok: true; pageCount: number; restored: number; keptNewer: number; mode: 'merge' | 'exact' } {
  assertCheckpointId(id)
  if (mode !== 'merge' && mode !== 'exact') throw new SaveError(400, `非法回滚模式：${String(mode)}`)
  const root = checkpointsRoot(store)
  const src = join(root, id)
  if (!existsSync(src)) throw new SaveError(404, `还原点不存在：${id}`)

  let restored = 0
  let keptNewer = 0
  for (const c of CATEGORIES) {
    const snap = join(src, c)
    const live = join(store.wikiRoot, c)
    mkdirSync(live, { recursive: true })
    const snapFiles = existsSync(snap) ? readdirSync(snap).filter((f) => f.endsWith('.md')) : []
    const liveFiles = readdirSync(live).filter((f) => f.endsWith('.md'))
    if (mode === 'exact') {
      // 精确模式：删除快照之后新增的页面
      const snapSet = new Set(snapFiles)
      for (const f of liveFiles) if (!snapSet.has(f)) rmSync(join(live, f), { force: true })
    } else {
      keptNewer += liveFiles.filter((f) => !snapFiles.includes(f)).length
    }
    // 两种模式都要把快照中的页面覆盖回（撤销修改）
    for (const f of snapFiles) {
      cpSync(join(snap, f), join(live, f))
      restored++
    }
  }
  for (const f of SNAPSHOT_FILES) {
    const snapFile = join(src, f)
    if (existsSync(snapFile)) writeFileSync(join(store.wikiRoot, f), readFileSync(snapFile), 'utf8')
  }
  const pageCount = CATEGORIES.reduce((n, c) => {
    const d = join(store.wikiRoot, c)
    return n + (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')).length : 0)
  }, 0)
  return { ok: true, pageCount, restored, keptNewer, mode }
}
