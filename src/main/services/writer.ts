/**
 * 写盘：生成「将要写入什么」的预览，以及真正落盘（可选先备份）。
 *
 * 安全约束：所有相对路径都会被解析并校验，必须落在工程根之内，
 * 防止模板或界面里出现 `../../` 之类的越界写入。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { inspectVscodeOwnership } from './vscodeOwnership'
import type {
  FilePayload,
  PlanRequest,
  PlannedFile,
  WriteProgress,
  WriteRequest,
  WriteResult
} from '@shared/types'

/** 本工具负责读写的 .vscode 文件（不含动态命名的 openocd-*.cfg） */
export const MANAGED_VSCODE_FILES = [
  'launch.json',
  'tasks.json',
  'settings.json',
  'c_cpp_properties.json'
] as const

/** 把工程内的相对路径解析成绝对路径；越界（`../`）返回 null */
export function resolveInsideProject(projectRoot: string, relativePath: string): string | null {
  const root = resolve(projectRoot)
  const target = resolve(root, normalize(relativePath))
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

const resolveInside = resolveInsideProject

export function readTextIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/** 列出工程里本工具管理的文件（相对工程根），只包含实际存在的 */
export function listManagedFiles(projectRoot: string): string[] {
  // 只返回**确认是本工具写的**那些。
  // 以前这里只判断「文件存在」，于是会把 STM32Cube / CMake Tools 扩展写的
  // 同名文件也当成自己的 —— 用户点「清除配置」就把别人的配置删了。
  // 现在按内容特征认（见 vscodeOwnership.ts），认不出来的一律不碰。
  return inspectVscodeOwnership(projectRoot).ours
}

/** 删除本工具管理的文件；`.vscode` 因此变空的话一并删掉，尽量回到「从没配置过」的样子 */
export function removeManagedFiles(projectRoot: string): { deleted: string[]; errors: string[] } {
  const deleted: string[] = []
  const errors: string[] = []

  for (const relative of listManagedFiles(projectRoot)) {
    const target = resolveInsideProject(projectRoot, relative)
    if (!target) {
      errors.push(`${relative}: 路径越界，已跳过`)
      continue
    }
    try {
      rmSync(target, { force: true })
      deleted.push(target)
    } catch (err) {
      errors.push(`${relative}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const vscodeDir = join(projectRoot, '.vscode')
  try {
    if (existsSync(vscodeDir) && readdirSync(vscodeDir).length === 0) rmdirSync(vscodeDir)
  } catch {
    /* 删不掉就算了，空目录无害 */
  }

  return { deleted, errors }
}

export function planFiles(request: PlanRequest): PlannedFile[] {
  const { projectRoot, files } = request
  const planned: PlannedFile[] = []

  for (const file of files) {
    const target = resolveInside(projectRoot, file.relativePath)
    if (!target) {
      planned.push({
        name: file.name,
        path: join(projectRoot, file.relativePath),
        relativePath: file.relativePath,
        content: file.content,
        exists: false,
        previous: null
      })
      continue
    }

    const previous = readTextIfExists(target)
    planned.push({
      name: file.name,
      path: target,
      relativePath: file.relativePath,
      content: file.content,
      exists: previous !== null,
      previous
    })
  }

  return planned
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

export function writeFiles(
  request: WriteRequest,
  onProgress?: (progress: WriteProgress) => void
): WriteResult {
  const { projectRoot, files, backup } = request
  const result: WriteResult = {
    written: [],
    unchanged: [],
    backups: [],
    errors: [],
    backupDir: null,
    snapshotId: null
  }

  let backupDir: string | null = null
  const total = files.length

  files.forEach((file, index) => {
    const base = { relativePath: file.relativePath, name: file.name, index, total }

    const target = resolveInside(projectRoot, file.relativePath)

    if (!target) {
      result.errors.push(`${file.relativePath}: 路径越界，已拒绝写入`)
      onProgress?.({ ...base, status: 'error', message: '路径越界' })
      return
    }

    try {
      onProgress?.({ ...base, status: 'writing' })

      const previous = readTextIfExists(target)

      if (previous !== null && previous === file.content) {
        result.unchanged.push(target)
        onProgress?.({ ...base, status: 'unchanged' })
        return
      }

      if (previous !== null && backup) {
        if (!backupDir) {
          backupDir = join(projectRoot, '.vscode', '.backup', timestamp())
          mkdirSync(backupDir, { recursive: true })
          result.backupDir = backupDir
        }
        const flatName = file.relativePath.replace(/[\\/]/g, '__')
        copyFileSync(target, join(backupDir, flatName))
        result.backups.push(join(backupDir, flatName))
      }

      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content, { encoding: 'utf8' })
      result.written.push(target)
      onProgress?.({ ...base, status: 'written' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`${file.relativePath}: ${msg}`)
      onProgress?.({ ...base, status: 'error', message: msg })
    }
  })

  return result
}

export function asPayloads(files: PlannedFile[]): FilePayload[] {
  return files.map((f) => ({ name: f.name, relativePath: f.relativePath, content: f.content }))
}
