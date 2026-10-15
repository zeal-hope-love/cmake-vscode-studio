/**
 * 写入快照与还原。
 *
 * 每次真正改动 `.vscode` 之前，把「每个文件原来的内容」记一份到应用自己的数据目录
 * （`%APPDATA%\<app>\snapshots\<工程哈希>\`），这样随时能还原回去，而且**不往用户
 * 工程里塞任何东西**（`.vscode/.backup/` 是可选的另一套，给喜欢把备份留在工程里的人）。
 *
 * 记录「写入前不存在」这件事很重要：还原时要把这些文件删掉，才算真的回到原样。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RestoreResult, SnapshotMeta } from '@shared/types'
import { resolveInsideProject } from './writer'

/** 每个工程最多保留多少条快照 */
const MAX_SNAPSHOTS_PER_PROJECT = 20

/**
 * 快照根目录由调用方注入。
 *
 * 故意不在这里 import electron —— 自检脚本要在纯 node 里跑快照/还原的回归测试，
 * 静态依赖 electron 会让它直接崩。主进程启动时调一次 configureSnapshots() 即可。
 */
let rootDir: string | null = null

export function configureSnapshots(dir: string): void {
  rootDir = dir
}

export interface SnapshotEntry {
  relativePath: string
  /** null 表示写入前这个文件并不存在 */
  previous: string | null
}

interface SnapshotFile extends SnapshotMeta {
  files: SnapshotEntry[]
}

function projectKey(projectRoot: string): string {
  // 归一化再算哈希：同一个工程用 C:/x 和 C:\x 写进来会得到不同的键，
  // 于是「明明存了快照却列不出来」。结尾的分隔符也一并去掉。
  const normalized = projectRoot.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

function projectDir(projectRoot: string): string {
  if (!rootDir) throw new Error('快照目录尚未配置，请先调用 configureSnapshots()')
  return join(rootDir, projectKey(projectRoot))
}

/**
 * 保存一份快照。`entries` 里应当只包含**内容确实会变**的文件。
 * 没有任何需要记录的内容时返回 null（不产生空快照）。
 */
export function captureSnapshot(projectRoot: string, entries: SnapshotEntry[]): string | null {
  if (!entries.length) return null

  try {
    const dir = projectDir(projectRoot)
    mkdirSync(dir, { recursive: true })

    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const snapshot: SnapshotFile = {
      id,
      projectRoot,
      createdAt: Date.now(),
      fileCount: entries.length,
      newFileCount: entries.filter((e) => e.previous === null).length,
      files: entries
    }

    writeFileSync(join(dir, `${id}.json`), JSON.stringify(snapshot), 'utf8')
    pruneOldSnapshots(dir)
    return id
  } catch {
    // 存不下快照不能挡住写入本身
    return null
  }
}

function pruneOldSnapshots(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
    for (const stale of files.slice(MAX_SNAPSHOTS_PER_PROJECT)) {
      rmSync(join(dir, stale), { force: true })
    }
  } catch {
    /* 清理失败无所谓 */
  }
}

export function listSnapshots(projectRoot: string): SnapshotMeta[] {
  const dir = projectDir(projectRoot)
  if (!existsSync(dir)) return []

  const metas: SnapshotMeta[] = []
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SnapshotFile
        if (!parsed?.id) continue
        metas.push({
          id: parsed.id,
          projectRoot: parsed.projectRoot,
          createdAt: parsed.createdAt,
          fileCount: parsed.fileCount,
          newFileCount: parsed.newFileCount
        })
      } catch {
        /* 坏掉的快照跳过 */
      }
    }
  } catch {
    return []
  }

  return metas.sort((a, b) => b.createdAt - a.createdAt)
}

/** 把工程恢复到某次写入之前的状态 */
export function restoreSnapshot(projectRoot: string, snapshotId: string): RestoreResult {
  const result: RestoreResult = { restored: [], removed: [], errors: [] }

  const filePath = join(projectDir(projectRoot), `${snapshotId}.json`)
  if (!existsSync(filePath)) {
    result.errors.push('找不到这条快照，可能已被自动清理')
    return result
  }

  let snapshot: SnapshotFile
  try {
    snapshot = JSON.parse(readFileSync(filePath, 'utf8')) as SnapshotFile
  } catch (err) {
    result.errors.push(`快照读取失败：${err instanceof Error ? err.message : String(err)}`)
    return result
  }

  for (const entry of snapshot.files ?? []) {
    const target = resolveInsideProject(projectRoot, entry.relativePath)
    if (!target) {
      result.errors.push(`${entry.relativePath}：路径越界，已跳过`)
      continue
    }

    try {
      if (entry.previous === null) {
        // 写入前本来没有这个文件 —— 还原就是把它删掉
        if (existsSync(target)) {
          rmSync(target, { force: true })
          result.removed.push(target)
        }
      } else {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, entry.previous, 'utf8')
        result.restored.push(target)
      }
    } catch (err) {
      result.errors.push(`${entry.relativePath}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
