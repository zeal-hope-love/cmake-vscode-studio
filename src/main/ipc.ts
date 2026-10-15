/**
 * 所有 IPC 处理器的注册处。
 *
 * 渲染进程没有任何 Node 能力（contextIsolation + sandbox），
 * 凡是碰文件系统/进程的动作都必须经过这里。
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { applyPackInstall, planPackInstall } from './services/packInstaller'
import {
  checkPackCompat,
  inspectProject,
  listPacks,
  loadPack,
  scanPidStructs
} from './services/packStore'
import {
  applySourceChange,
  createSourceFile,
  previewSourceChange,
  scanSources,
  signatureOf
} from './services/sourceScanner'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  IPC,
  type AppSettings,
  type AppInfo,
  type BatchRequest,
  type BatchResult,
  type CleanArtifactsResult,
  type ClearResult,
  type CmakeApplyResult,
  type CmakeChangePreview,
  type CmakeChangeRequest,
  type CmakeScanResult,
  type ConfigTemplate,
  type CreateSourceFileResult,
  type GenOptions,
  type HistoryEntry,
  type NewFileKind,
  type PlanRequest,
  type ProjectLoadResult,
  type RestoreResult,
  type RunRequest,
  type WriteRequest,
  type WriteResult
} from '@shared/types'
import type { PackApplyResult, PackManifest, PackPlan } from '@shared/packTypes'
import type { PackInspectResult, PackPlanOptions } from '@shared/types'
import { defaultGenOptions, generateBundle } from './services/generators'
import { adaptTemplateOptions } from '@shared/templateAdapt'
import { scanProject } from './services/scanner'
import { detectTools } from './services/toolDetector'
import { discoverProjects } from './services/workspaceFinder'
import { getSettings, rememberProject, saveSettings } from './services/settingsStore'
import { deleteTemplate, getTemplate, listTemplates, saveTemplate } from './services/templateStore'
import {
  addHistory,
  clearHistory,
  projectActions,
  listHistory,
  recordBatch,
  recordClear,
  recordProjectLoad,
  recordRestore,
  recordRun,
  recordTemplateDelete,
  recordTemplateSave,
  recordWrite,
  removeHistory
} from './services/historyStore'
import {
  listManagedFiles,
  planFiles,
  readTextIfExists,
  removeManagedFiles,
  resolveInsideProject,
  writeFiles
} from './services/writer'
import {
  captureSnapshot,
  configureSnapshots,
  listSnapshots,
  restoreSnapshot
} from './services/snapshotStore'
import { currentUserDataDir, userDataPath } from './services/store'
import { ProcessRunner } from './services/runner'

const runner = new ProcessRunner()

// 快照存在应用自己的数据目录里，不往用户工程里塞东西
configureSnapshots(userDataPath('snapshots'))

function pruneUndefined<T extends object>(input: T | undefined): Partial<T> {
  if (!input) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

function findCodeCli(): string | null {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
    'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')
  ]
  for (const cand of candidates) {
    if (cand && existsSync(cand)) return cand
  }
  return null
}

/**
 * 模板套用到多个工程时，模板里与「具体工程」绑定的字段（固件名、芯片、
 * 构建目录、工具路径）必须按目标工程重新推导 —— 逻辑在 shared/templateAdapt.ts，
 * 渲染进程套用到当前工程时走的是同一个函数。
 */

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // ---- 应用信息 ---------------------------------------------------------
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    // 版本号来自 package.json 的 version；打包时 electron-builder 用它填 exe 的文件版本
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '—',
    chrome: process.versions.chrome ?? '—',
    node: process.versions.node ?? '—',
    v8: process.versions.v8 ?? '—',
    platform: `${process.platform} ${process.arch}`,
    isPackaged: app.isPackaged,
    // 用实际生效的目录（可能是迁移后的新目录，也可能是迁移失败时回退的老目录）
    userData: currentUserDataDir(),
    packagePath: join(app.getAppPath(), 'package.json')
  }))

  // ---- 设置 -------------------------------------------------------------
  ipcMain.handle(IPC.settingsGet, (): AppSettings => getSettings())

  ipcMain.handle(IPC.settingsSave, (_e, patch: Partial<AppSettings>): AppSettings =>
    saveSettings(patch)
  )

  // ---- 对话框 -----------------------------------------------------------
  ipcMain.handle(IPC.dialogPickDirectory, async (_e, defaultPath?: string) => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择工程目录',
          defaultPath: defaultPath || undefined,
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogPickFile, async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const win = getWindow()
    const options = {
      title: '选择文件',
      properties: ['openFile' as const],
      filters: filters?.length ? filters : [{ name: '所有文件', extensions: ['*'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

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
      rememberProject(project.root)
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
    // 先把「将要被覆盖掉的内容」存成快照，再落盘 —— 顺序反了就还原不回去了。
    // 只记录内容确实会变的文件，内容没变的不进快照。
    const planned = planFiles({ projectRoot: request.projectRoot, files: request.files })
    const changed = planned
      .filter((f) => f.previous !== f.content)
      .map((f) => ({ relativePath: f.relativePath, previous: f.previous }))

    const snapshotId = captureSnapshot(request.projectRoot, changed)

    const result = writeFiles(request, (progress) => {
      getWindow()?.webContents.send(IPC.configWriteProgress, progress)
    })

    recordWrite(request.projectRoot, result.written, result.errors, snapshotId)

    return { ...result, snapshotId }
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

  // ---- CMake 构建目标与源文件 --------------------------------------------
  //
  // 这是**唯一会改到自己手写的构建脚本**的一组接口，所以每一步都留了退路：
  //   cmakeScan    只读，扫目标 + 找出「磁盘上有但没进构建」的
  //   cmakePreview 只算不写，返回改前改后全文给界面做 diff
  //   cmakeApply   写之前先存快照，历史里能一键还原
  //   cmakeCreateFile 建骨架文件（不自动加进构建，加不加由用户在界面上点）
  ipcMain.handle(IPC.cmakeScan, async (_e, projectRoot: string) => scanSources(projectRoot))

  // 轻量指纹：界面每 2 秒问一次「变了吗」，变了才重新全量扫描
  ipcMain.handle(IPC.cmakeSignature, async (_e, projectRoot: string) => signatureOf(projectRoot))

  ipcMain.handle(IPC.cmakePreview, async (_e, req: CmakeChangeRequest) => previewSourceChange(req))

  ipcMain.handle(IPC.cmakeApply, async (_e, req: CmakeChangeRequest) => applySourceChange(req))

  ipcMain.handle(
    IPC.cmakeCreateFile,
    async (_e, projectRoot: string, relPath: string, kind: NewFileKind) =>
      createSourceFile(projectRoot, relPath, kind)
  )

  // ---- 模块包（vofa 等）--------------------------------------------------
  //
  // 和 CMake 那组一样，读写分开：
  //   packList/packInspect/packPlan 只读 —— 看清楚要改什么再决定
  //   packApply 才落盘，写之前存快照，历史页能一键还原
  ipcMain.handle(IPC.packList, async () => listPacks())

  ipcMain.handle(
    IPC.packInspect,
    async (_e, packId: string, projectRoot: string): Promise<PackInspectResult> => {
      const pack = loadPack(packId)
      if (!pack) throw new Error(`找不到模块包 ${packId}`)
      const facts = inspectProject(projectRoot)
      return {
        report: checkPackCompat(pack, projectRoot, facts),
        pidCandidates: scanPidStructs(projectRoot),
        existingFiles: facts.existingVofa
      }
    }
  )

  ipcMain.handle(IPC.packPlan, async (_e, options: PackPlanOptions): Promise<PackPlan> =>
    planPackInstall(options)
  )

  ipcMain.handle(IPC.packApply, async (_e, options: PackPlanOptions): Promise<PackApplyResult> => {
    const plan = planPackInstall(options)
    if (plan.blocked) {
      return {
        ok: false,
        written: [],
        skipped: plan.changes.filter((c) => c.action === 'skip').map((c) => c.path),
        errors: ['有必须先处理的问题，未写入任何文件'],
        snapshotId: null
      }
    }
    return applyPackInstall(plan)
  })

  // ---- 模板 -------------------------------------------------------------
  ipcMain.handle(IPC.templateList, async () => listTemplates())

  ipcMain.handle(IPC.templateSave, async (_e, template: ConfigTemplate) => {
    const before = template.id ? getTemplate(template.id) : null
    const list = saveTemplate(template)
    // 新存的模板 id 可能刚生成，从返回列表里按 updatedAt 找最新那条
    const saved =
      list.find((t) => t.id === template.id) ??
      [...list].filter((t) => !t.builtin).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (saved) {
      recordTemplateSave(saved.id, saved.name, Boolean(before?.builtin))
    }
    return list
  })

  ipcMain.handle(IPC.templateDelete, async (_e, id: string) => {
    const target = getTemplate(id)
    const list = deleteTemplate(id)
    if (target) recordTemplateDelete(target.name)
    return list
  })

  // ---- 历史记录 ---------------------------------------------------------
  ipcMain.handle(IPC.historyList, async () => listHistory())
  ipcMain.handle(IPC.historyAdd, async (_e, entry: Omit<HistoryEntry, 'id' | 'at'>) =>
    addHistory(entry)
  )
  ipcMain.handle(IPC.historyRemove, async (_e, id: string) => removeHistory(id))
  ipcMain.handle(IPC.historyClear, async () => clearHistory())

  ipcMain.handle(IPC.templateApplyBatch, async (_e, request: BatchRequest): Promise<BatchResult> => {
    const template = getTemplate(request.templateId)
    if (!template) {
      return {
        templateId: request.templateId,
        items: request.projectRoots.map((root) => ({
          projectRoot: root,
          ok: false,
          message: '模板不存在',
          written: []
        }))
      }
    }

    const settings = getSettings()
    const tools = detectTools(settings.tools)
    const items: BatchResult['items'] = []

    for (const root of request.projectRoots) {
      try {
        const project = scanProject(root)
        if (!project.buildDirs.length && !project.presets.length && !project.targets.length) {
          items.push({
            projectRoot: root,
            ok: false,
            message: '看起来不是 CMake 工程，已跳过',
            written: []
          })
          continue
        }
        const base = defaultGenOptions(project, tools, settings)
        const options = adaptTemplateOptions(template.options, base)
        const bundle = generateBundle(project, options)
        const files = bundleToPayloads(bundle)
        const result = writeFiles({ projectRoot: project.root, files, backup: request.backup })
        items.push({
          projectRoot: project.root,
          ok: result.errors.length === 0,
          message: result.errors.length
            ? result.errors.join('; ')
            : result.written.length
              ? `写入 ${result.written.length} 个文件`
              : '内容已是最新，无需改动',
          written: result.written
        })
        rememberProject(project.root)
      } catch (err) {
        items.push({
          projectRoot: root,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          written: []
        })
      }
    }

    return { templateId: request.templateId, items }
  })

  // ---- 运行 -------------------------------------------------------------
  runner.on('output', (payload) => {
    getWindow()?.webContents.send(IPC.runOutput, payload)
  })
  runner.on('exit', (payload) => {
    getWindow()?.webContents.send(IPC.runExit, payload)
  })

  ipcMain.handle(IPC.runStart, async (_e, request: RunRequest) => runner.start(request))
  ipcMain.handle(IPC.runCancel, async (_e, runId: string) => {
    runner.cancel(runId)
  })
}

/** 在 ipc 层复用的：bundle → 待写文件 */
function bundleToPayloads(bundle: ReturnType<typeof generateBundle>) {
  const stringify = (value: unknown): string => JSON.stringify(value, null, 4) + '\n'
  const files = [
    { name: 'launch.json', relativePath: '.vscode/launch.json', content: stringify(bundle.launch) },
    { name: 'tasks.json', relativePath: '.vscode/tasks.json', content: stringify(bundle.tasks) },
    {
      name: 'settings.json',
      relativePath: '.vscode/settings.json',
      content: stringify(bundle.settings)
    },
    {
      name: 'c_cpp_properties.json',
      relativePath: '.vscode/c_cpp_properties.json',
      content: stringify(bundle.cpp)
    }
  ]
  if (bundle.openocdCfg) {
    files.push({
      name: bundle.openocdCfg.fileName,
      relativePath: `.vscode/${bundle.openocdCfg.fileName}`,
      content: bundle.openocdCfg.content
    })
  }
  return files
}

export function stopAllRuns(): void {
  runner.cancelAll()
}
