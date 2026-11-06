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
  rmSync
} from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { writeFileWithRetry, type FileWriteResult } from '../util/fileWrite'
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

/** 错误码 → 一句人话，直接进界面（用户不需要看懂 Win32 原文） */
function hintForCode(code: string | undefined): string {
  switch (code) {
    case 'EPERM':
    case 'EACCES':
      return '被别的程序（VSCode / 杀毒软件）短暂占用，或文件是只读的'
    case 'EBUSY':
      return '文件被别的程序打开着'
    case 'ENOENT':
      return '目录不存在（可能刚被删掉）'
    case 'ENOSPC':
      return '磁盘空间不足'
    default:
      return '写入被拒绝'
  }
}

/**
 * 「建不出目录」的翻译。
 *
 * 跟写文件那句要分开：同一个 EPERM，写文件多半是**瞬时占用**（重试就能过），
 * 建目录则是**持续性拒绝**（重试一万次也一样），该说的话完全不同 ——
 * 前者劝用户再点一次，后者要让用户去查安全软件的拦截记录。
 */
function hintForDirCode(code: string | undefined): string {
  switch (code) {
    case 'EPERM':
    case 'EACCES':
      return '这个位置不允许本程序写入 —— 常见原因是安全软件（火绒 / 联想安全 / 企业管控）拦截，或该文件夹只读；把 CV Studio 加入信任区后重试'
    case 'ENOENT':
      return '上一级目录不存在'
    case 'ENOSPC':
      return '磁盘空间不足'
    case 'EROFS':
      return '所在磁盘是只读的'
    default:
      return '没有权限在这里创建目录'
  }
}

/**
 * 一行错误摘要。
 *
 * 刻意**不带绝对路径** —— 路径在上面「哪个文件」那列已经有了，塞进错误行
 * 只会把真正有用的错误码和原因挤到看不见的地方（之前就是这样：
 * 用户看到五行以 `c:\Users\...` 开头的长文本，看不出到底哪里错了）。
 */
function describeFailure(relativePath: string, w: FileWriteResult): string {
  const retried = (w.attempts ?? 1) > 1 ? `，已重试 ${w.attempts} 次` : ''
  // 目录都建不出来时，写文件必然跟着报 ENOENT —— 那是假象。
  // 真正的原因在 dirError 里，必须按它来翻译，否则用户会去追一个不存在的
  // 「目录被删了」。（真机上就踩过：明明是安全软件拦 mkdir，界面却显示目录不存在）
  if (w.dirError) {
    return `${relativePath}：无法创建所在目录（${w.dirError.code ?? 'ERROR'}${retried}）—— ${hintForDirCode(w.dirError.code)}`
  }
  return `${relativePath}：${w.code ?? 'ERROR'}${retried} —— ${hintForCode(w.code)}`
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
  /** 建不出来的目录（目录 → 原因），用来在最后给一句「根因 + 怎么办」 */
  const dirIssues = new Map<string, { code?: string; message: string }>()

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

      // 写入必须走带退避重试的那条路径（目录也由它顺手创建）。
      //
      // 以前这里是裸 writeFileSync：只要撞上 Windows 的瞬时占用（VSCode 正在
      // 索引这个工程、杀毒软件在扫描刚生成的文件），一次 EPERM 就把这个文件
      // 判成失败。实测过：同一个工程 5 个文件全报 EPERM，隔几分钟再写全部正常。
      // 现在由 fileWrite.ts 统一重试（约 1 秒窗口）+ 清只读位，
      // 并且所有失败都走 describeFailure 翻译成中文摘要（完整 Win32 原文进控制台）。
      const w = writeFileWithRetry(target, file.content, file.name)
      if (!w.ok) {
        const line = describeFailure(file.relativePath, w)
        // 完整原文（含绝对路径和 Win32 消息）只进控制台，界面看摘要那一行
        console.error(`[writer] ${line}\n${w.error ?? ''}`)
        result.errors.push(line)
        if (w.dirError) {
          const dir = dirname(target)
          if (!dirIssues.has(dir)) dirIssues.set(dir, w.dirError)
        }
        onProgress?.({ ...base, status: 'error', message: line })
        return
      }

      result.written.push(target)
      onProgress?.({ ...base, status: 'written' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`${file.relativePath}：${msg}`)
      onProgress?.({ ...base, status: 'error', message: msg })
    }
  })

  // 所有文件都卡在「同一个目录建不出来」上时，上面会给出 N 行一模一样的错。
  // 单独提炼一句根因，界面放在最前面 —— 用户只需要读一次「怎么办」。
  if (result.written.length === 0 && dirIssues.size === 1 && result.errors.length === total) {
    const [dir, issue] = [...dirIssues.entries()][0]
    result.blockedReason = `无法在工程里创建 ${dir}（${issue.code ?? 'ERROR'}）—— ${hintForDirCode(issue.code)}`
  }

  return result
}

export function asPayloads(files: PlannedFile[]): FilePayload[] {
  return files.map((f) => ({ name: f.name, relativePath: f.relativePath, content: f.content }))
}
