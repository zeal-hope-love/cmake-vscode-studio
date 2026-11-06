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
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { RestoreResult, SnapshotMeta } from '@shared/types'
import { resolveInsideProject } from '../generate/writer'
import { writeFileWithRetry } from '../util/fileWrite'

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
  return captureSnapshotDetailed(projectRoot, entries).id
}

/**
 * 保存快照，**把失败原因一起返回**。
 *
 * 为什么需要这个版本：`captureSnapshot` 失败只返回 null，
 * 调用方拿不到原因，界面只能显示「快照存不下」—— 用户没法自救，
 * 我们自己也排查不了（stderr 在打包版里看不到）。
 *
 * 移植流程用这个版本，失败时把 `error` 直接显示在界面上。
 */
export function captureSnapshotDetailed(
  projectRoot: string,
  entries: SnapshotEntry[]
): { id: string | null; error?: string; usedFallback?: boolean } {
  if (!entries.length) return { id: null, error: '没有需要快照的文件' }

  let primary: string | null = null
  try {
    primary = projectDir(projectRoot)
  } catch {
    // rootDir 没配置（自检脚本里就是这样），直接走降级路径
  }

  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const snapshot: SnapshotFile = {
    id,
    projectRoot,
    createdAt: Date.now(),
    fileCount: entries.length,
    newFileCount: entries.filter((e) => e.previous === null).length,
    files: entries
  }
  const json = JSON.stringify(snapshot)

  /*
   * 依次尝试几个位置。
   *
   * 为什么不是只写一处：实测在某些环境下 Electron 进程**写不进 userData
   * 目录**（EPERM，但同路径 PowerShell / Node 都能写，ACL 也正常）。
   * 重试 8 次（约 1 秒）仍然失败，说明是被持续阻止而不是瞬时冲突。
   *
   * 这时候最合理的做法是**换一个能写的地方**，而不是让整个移植流程卡死 ——
   * 快照的意义是「改坏了能回去」，换个位置存照样能回去。
   *
   * 优先 userData（不污染用户工程）；实在不行退到工程目录下的隐藏文件夹。
   */
  const candidates: Array<{ dir: string; label: string; fallback: boolean }> = []
  if (primary) candidates.push({ dir: primary, label: '应用数据目录', fallback: false })
  /*
   * 降级位置（按优先级）。
   *
   * 实测有的环境里 Electron 进程写 userData 和工程目录**都 EPERM**
   * （ACL 正常、Defender 受控文件夹访问也关着，但就是写不进去）。
   * 所以多备几个位置，总有一个能写。
   *
   * 顺序上优先「离工程近」的，方便用户找到；
   * 最后的临时目录一定可写，作为兜底。
   */
  candidates.push({
    dir: join(projectRoot, '.cvstudio-snapshots', projectKey(projectRoot)),
    label: '工程目录',
    fallback: true
  })
  candidates.push({
    dir: join(dirname(projectRoot), '.cvstudio-snapshots', projectKey(projectRoot)),
    label: '工程上一级目录',
    fallback: true
  })
  candidates.push({
    dir: join(tmpdir(), 'cv-studio-snapshots', projectKey(projectRoot)),
    label: '临时目录',
    fallback: true
  })

  const failures: string[] = []
  for (const c of candidates) {
    try {
      mkdirSync(c.dir, { recursive: true })
      const w = writeFileWithRetry(join(c.dir, `${id}.json`), json, '快照')
      if (!w.ok) {
        failures.push(`${c.label}：${w.error}`)
        continue
      }
      pruneOldSnapshots(c.dir)
      if (c.fallback) {
        console.warn('[snapshot] 应用数据目录写不进去，已改存到工程目录：', c.dir)
      }
      return { id, usedFallback: c.fallback }
    } catch (err) {
      failures.push(`${c.label}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const msg = failures.join('\n')
  console.error('[snapshot] 所有位置都存不下：', msg)
  return { id: null, error: msg }
}

/** @deprecated 旧实现保留作参考 */
function _legacyCaptureSnapshotDetailed(
  projectRoot: string,
  entries: SnapshotEntry[]
): { id: string | null; error?: string } {
  if (!entries.length) return { id: null, error: '没有需要快照的文件' }

  let dir: string
  try {
    dir = projectDir(projectRoot)
  } catch (err) {
    return {
      id: null,
      error: `算不出快照目录：${err instanceof Error ? err.message : String(err)}`
    }
  }

  try {
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

    const w = writeFileWithRetry(join(dir, `${id}.json`), JSON.stringify(snapshot), '快照')
    if (!w.ok) {
      return { id: null, error: w.error }
    }
    pruneOldSnapshots(dir)
    return { id }
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}` : String(err)
    const code = (err as NodeJS.ErrnoException).code ?? ''
    console.error('[snapshot] 存快照失败：', msg, '| dir:', dir)
    return {
      id: null,
      error: `写到 ${dir} 失败${code ? `（${code}）` : ''}：${msg}`
    }
  }
}

/** @deprecated 保留旧实现原因说明，见 captureSnapshotDetailed */
function _legacyCaptureSnapshot(projectRoot: string, entries: SnapshotEntry[]): string | null {
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
  } catch (err) {
    /*
     * 存不下快照不能挡住写入本身 —— 但**必须留下原因**。
     *
     * 早先这里是空 catch，于是移植流程里只显示「快照存不下，已中止」，
     * 完全不知道是磁盘满了、权限不够、还是路径不对。用户拿这句话没法自救。
     */
    console.error('[snapshot] 存快照失败：', err instanceof Error ? err.message : err)
    // projectDir 自己也可能抛（rootDir 没配），不能再让它把错误盖掉
    try {
      console.error('[snapshot] 目标目录：', projectDir(projectRoot))
    } catch {
      console.error('[snapshot] 快照根目录未配置（configureSnapshots 没调用？）')
    }
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

/**
 * 一个工程的所有可能快照目录。
 *
 * 正常情况下只用第一个（userData）。第二个是**降级位置** ——
 * 写不进 userData 时会退到工程目录下，读取和还原也必须能找到那儿，
 * 否则会出现「明明存了快照，列表里却是空的」。
 */
function allDirs(projectRoot: string): string[] {
  const out: string[] = []
  try {
    out.push(projectDir(projectRoot))
  } catch {
    /* rootDir 没配置 */
  }
  // 和 captureSnapshotDetailed 的降级位置保持一致 —— 少写一个就会出现
  // 「存进去了但列表里看不到」「还原时找不到这条快照」
  out.push(join(projectRoot, '.cvstudio-snapshots', projectKey(projectRoot)))
  out.push(join(dirname(projectRoot), '.cvstudio-snapshots', projectKey(projectRoot)))
  out.push(join(tmpdir(), 'cv-studio-snapshots', projectKey(projectRoot)))
  return out
}

export function listSnapshots(projectRoot: string): SnapshotMeta[] {
  const metas: SnapshotMeta[] = []
  const seen = new Set<string>()

  for (const dir of allDirs(projectRoot)) {
    if (!existsSync(dir)) continue
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SnapshotFile
          if (!parsed?.id || seen.has(parsed.id)) continue
          seen.add(parsed.id)
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
      /* 这个目录读不了就看下一个 */
    }
  }

  return metas.sort((a, b) => b.createdAt - a.createdAt)
}

/** 把工程恢复到某次写入之前的状态 */
export function restoreSnapshot(projectRoot: string, snapshotId: string): RestoreResult {
  const result: RestoreResult = { restored: [], removed: [], errors: [] }

  // 两个位置都找一遍 —— 快照可能因为 userData 写不进降级到了工程目录
  let filePath: string | null = null
  for (const dir of allDirs(projectRoot)) {
    const p = join(dir, `${snapshotId}.json`)
    if (existsSync(p)) {
      filePath = p
      break
    }
  }
  if (!filePath) {
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

  // 还原把新建的文件删掉之后，它所在的目录可能就空了（例如 application/vofa/）。
  // 空目录本身无害，但看着像「装了一半」，所以往上清到工程根为止。
  // 只删**确实空**的目录，且有内容就停 —— 不会碰用户自己的东西。
  pruneEmptyDirs(projectRoot, result.removed)

  return result
}

/** 删掉 removed 文件留下的空目录，逐级往上，遇到非空就停 */
function pruneEmptyDirs(projectRoot: string, removed: string[]): void {
  const rootAbs = resolve(projectRoot)
  const candidates = new Set<string>()
  for (const f of removed) {
    let d = dirname(f)
    while (d.length > rootAbs.length && d.startsWith(rootAbs)) {
      candidates.add(d)
      d = dirname(d)
    }
  }
  // 由深到浅，先删子目录再删父目录，否则父目录看着还不空
  for (const d of [...candidates].sort((a, b) => b.length - a.length)) {
    try {
      // rmSync 删目录必须带 recursive —— 只给 force 会抛 EISDIR，
      // 而下面那个 catch 会把它吞掉，于是「清空目录」看着像做了其实没做。
      // 这里已经确认过目录是空的，所以 recursive 不会误删东西。
      if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true, force: true })
    } catch {
      /* 删不掉无所谓，不是错误 */
    }
  }
}
