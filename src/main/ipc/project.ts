/**
 * 工程本身：扫描/载入、生成 .vscode 配置、快照与还原、清理陈旧产物。
 *
 * 这是通道最多的一段，但都围绕一件事：**把检测结果写成一份能用的工程配置**。
 * 真正算内容的逻辑在 services/generators + services/writer，这里只做参数校验和转发。
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type CleanArtifactsResult, type ClearResult, type GenOptions, type PlanRequest, type ProjectLoadResult, type RestoreResult, type WriteRequest, type WriteResult } from '@shared/types'
import { defaultGenOptions, generateBundle } from '../services/generate/generators'
import { scanProject } from '../services/project/scanner'
import { detectTools } from '../services/project/toolDetector'
import { discoverProjects } from '../services/project/workspaceFinder'
import { getSettings, rememberProject } from '../services/data/settingsStore'
import { addHistory, projectActions, recordClear, recordRestore, recordWrite, recordWriteAbort } from '../services/data/historyStore'
import { listManagedFiles, planFiles, readTextIfExists, removeManagedFiles, resolveInsideProject, writeFiles } from '../services/generate/writer'
import { captureSnapshot, listSnapshots, restoreSnapshot } from '../services/data/snapshotStore'
import { pruneUndefined, findCodeCli } from './common'

export function registerProject(getWindow: () => BrowserWindow | null): void {
  // ---- 工程 -------------------------------------------------------------
  ipcMain.handle(
    IPC.projectLoad,
    async (
      _e,
      projectRoot: string,
      overrides: Partial<GenOptions> = {},
      probeVersions = false
    ): Promise<ProjectLoadResult> => {
      const project = scanProject(projectRoot)
      const settings = getSettings()
      const tools = detectTools(settings.tools, probeVersions)
      const base = defaultGenOptions(project, tools, settings)
      const options: GenOptions = { ...base, ...pruneUndefined(overrides) }
      const bundle = generateBundle(project, options)
      /*
       * 记住「最近工程」是锦上添花，**失败了不能让打开工程这件事跟着失败**。
       *
       * 实测踩过：启动瞬间配置文件被抢，rememberProject 抛 EPERM，
       * 整个 project:load 挂掉，界面弹「载入失败」—— 用户看到的就是
       * 「打不开工程」，实际上工程数据早就算好了，只是最后记一笔失败而已。
       */
      try {
        rememberProject(project.root)
      } catch (err) {
        console.warn(
          '[project] 没能记进「最近工程」（不影响打开）：',
          err instanceof Error ? err.message : err
        )
      }
      return { project, tools, options, bundle }
    }
  )

  ipcMain.handle(IPC.projectGenerate, async (_e, projectRoot: string, options: GenOptions) => {
    const project = scanProject(projectRoot)
    return generateBundle(project, options)
  })

  ipcMain.handle(IPC.projectDiscover, async () => discoverProjects())

  ipcMain.handle(IPC.projectReadFile, async (_e, projectRoot: string, name: string) => {
    const filePath = join(projectRoot, '.vscode', name)
    if (!existsSync(filePath)) return { exists: false, text: '', error: null }
    try {
      return { exists: true, text: readFileSync(filePath, 'utf8'), error: null }
    } catch (err) {
      return {
        exists: true,
        text: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(IPC.projectOpenInVSCode, async (_e, target: string) => {
    const codeCmd = findCodeCli()
    if (codeCmd) {
      spawn(`"${codeCmd}" "${target}"`, {
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()
      return
    }
    spawn('cmd', ['/c', 'start', '', 'code', target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
  })

  ipcMain.handle(IPC.projectOpenInExplorer, async (_e, target: string) => {
    const path = existsSync(target) ? target : target.replace(/[\\/][^\\/]*$/, '')
    await shell.openPath(path)
  })

  // ---- 工具 -------------------------------------------------------------
  ipcMain.handle(IPC.toolsDetect, async (_e, options?: { probeVersions?: boolean }) => {
    const settings = getSettings()
    return detectTools(settings.tools, options?.probeVersions ?? false)
  })

  // ---- 生成 / 写入 ------------------------------------------------------
  ipcMain.handle(IPC.configPlan, async (_e, request: PlanRequest) => planFiles(request))

  ipcMain.handle(IPC.configWrite, async (_e, request: WriteRequest): Promise<WriteResult> => {
    /*
     * 整个流程包在 try 里，是为了「失败了也要进历史」。
     *
     * 以前只记成功/逐文件失败两种情况：如果卡在 planFiles（比如工程被删了）
     * 或 captureSnapshot（快照目录被占用）抛异常，IPC 直接 reject ——
     * 界面一行红字，历史页干干净净，回头根本查不到「我那次点写入发生了什么」。
     */
    let snapshotId: string | null = null
    try {
      // 先把「将要被覆盖掉的内容」存成快照，再落盘 —— 顺序反了就还原不回去了。
      // 只记录内容确实会变的文件，内容没变的不进快照。
      const planned = planFiles({ projectRoot: request.projectRoot, files: request.files })
      const changed = planned
        .filter((f) => f.previous !== f.content)
        .map((f) => ({ relativePath: f.relativePath, previous: f.previous }))

      snapshotId = captureSnapshot(request.projectRoot, changed)

      const result = writeFiles(request, (progress) => {
        getWindow()?.webContents.send(IPC.configWriteProgress, progress)
      })

      recordWrite(request.projectRoot, result.written, result.errors, snapshotId)

      return { ...result, snapshotId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[config:write] 没走完：', err)
      recordWriteAbort(request.projectRoot, message)
      throw err
    }
  })

  // ---- 快照 / 还原 ------------------------------------------------------
  ipcMain.handle(IPC.snapshotList, async (_e, projectRoot: string) => listSnapshots(projectRoot))

  ipcMain.handle(
    IPC.snapshotRestore,
    async (_e, projectRoot: string, snapshotId: string): Promise<RestoreResult> => {
      const result = await restoreSnapshot(projectRoot, snapshotId)
      recordRestore(projectRoot, result.restored, result.removed)
      return result
    }
  )

  /**
   * 清除本工具写入的 .vscode 配置，让工程回到「从没配置过」的样子。
   * 删之前同样存一份快照 —— 误点了还能从「备份与还原」里恢复。
   */
  ipcMain.handle(IPC.configClear, async (_e, projectRoot: string): Promise<ClearResult> => {
    const entries = listManagedFiles(projectRoot)
      .map((relativePath) => {
        const abs = resolveInsideProject(projectRoot, relativePath)
        return { relativePath, previous: abs ? readTextIfExists(abs) : null }
      })
      .filter((e) => e.previous !== null)

    const snapshotId = captureSnapshot(projectRoot, entries)
    const { deleted, errors } = removeManagedFiles(projectRoot)

    recordClear(projectRoot, deleted, errors, snapshotId)

    return { deleted, errors, snapshotId }
  })

  // ---- 清理构建目录里的陈旧产物 ------------------------------------------
  /**
   * 本工具唯一会**删工程内文件**的操作，所以不信任传入的路径：
   *   1. 必须解析到工程根之内（挡 `../`）
   *   2. 后缀必须是构建产物（挡误删源码）
   *   3. 必须是已存在的普通文件
   * 任一条不过就跳过并记进 errors，不会「尽力而为」地删。
   */
  ipcMain.handle(
    IPC.projectCleanArtifacts,
    async (_e, projectRoot: string, relativePaths: string[]): Promise<CleanArtifactsResult> => {
      const ALLOWED = /\.(elf|axf|map|bin|hex|o|obj|d|lst|su)$/i
      const removed: string[] = []
      const errors: string[] = []
      let freedBytes = 0

      for (const relativePath of relativePaths) {
        const abs = resolveInsideProject(projectRoot, relativePath)
        if (!abs) {
          errors.push(`${relativePath}：路径越出工程范围，已跳过`)
          continue
        }
        if (!ALLOWED.test(abs)) {
          errors.push(`${relativePath}：不是构建产物后缀，已跳过（防止误删源码）`)
          continue
        }
        try {
          const stat = statSync(abs)
          if (!stat.isFile()) {
            errors.push(`${relativePath}：不是普通文件，已跳过`)
            continue
          }
          rmSync(abs, { force: true })
          removed.push(relativePath)
          freedBytes += stat.size
        } catch (err) {
          errors.push(`${relativePath}：${err instanceof Error ? err.message : String(err)}`)
        }
      }

      addHistory({
        kind: 'clear',
        title: `清理陈旧构建产物（${removed.length} 个）`,
        detail: removed.length
          ? `${removed.join('、')} · 释放 ${(freedBytes / 1024).toFixed(0)} KB`
          : errors.join('；') || '没有可清理的文件',
        ok: errors.length === 0,
        projectRoot,
        actions: projectActions(projectRoot)
      })

      return { removed, errors, freedBytes }
    }
  )
}
