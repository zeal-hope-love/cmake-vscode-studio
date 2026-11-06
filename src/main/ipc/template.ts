/**
 * 配置模板：把当前工程的 .vscode 配置存成模板，或把模板套到别的工程。
 *
 * 套用时要按目标工程重新推导固件名/芯片/构建目录/工具路径
 * （`shared/templateAdapt.ts`），否则模板里的绝对路径会把别的工程带歪。
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { listPackPresets, savePackPreset } from '../services/data/packPresetStore'
import { buildTemplateFile, parseTemplateFile, type PackPreset } from '@shared/templateFormat'
import { listPacks } from '../services/pack/packStore'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type BatchRequest, type BatchResult, type ConfigTemplate } from '@shared/types'
import { deleteTemplate, getTemplate, listTemplates, saveTemplate } from '../services/data/templateStore'
import { recordTemplateDelete, recordTemplateSave } from '../services/data/historyStore'
import { adaptTemplateOptions } from '@shared/templateAdapt'
import { defaultGenOptions, generateBundle } from '../services/generate/generators'
import { getSettings, rememberProject } from '../services/data/settingsStore'
import { detectTools } from '../services/project/toolDetector'
import { scanProject } from '../services/project/scanner'
import { writeFiles } from '../services/generate/writer'
import { bundleToPayloads } from './common'

export function registerTemplate(getWindow: () => BrowserWindow | null): void {
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

  // ------------------------------------------------------------------------
  // 模板导入 / 导出
  // ------------------------------------------------------------------------

  /**
   * 导出一个模板到 .json 文件。
   *
   * 存成 `{ format, version, template }` 而不是裸的模板对象 —— 文件被别的程序
   * 误打开、或者将来格式变了你还能看出这是什么东西。导入时认 format 字段，
   * 不认就当作裸模板再试一次（兼容手写的文件）。
   */
  /**
   * 导出模板。
   *
   * 参数里可以同时带工程配置模板和模块包模板 —— 它们会写进**同一个文件**
   * （格式见 `shared/templateFormat.ts`）。用户想备份「一整套东西」时，
   * 一次导出就够了，不用在两个页面各点一次。
   *
   * @param defaultName 默认文件名（不含扩展名），一般传模板名或「全部模板」
   */
  ipcMain.handle(
    IPC.templateExport,
    async (
      _e,
      payload: { projectTemplates?: ConfigTemplate[]; packPresets?: PackPreset[]; defaultName?: string }
    ): Promise<string | null> => {
      const win = getWindow()
      const projectTemplates = payload?.projectTemplates ?? []
      const packPresets = payload?.packPresets ?? []
      if (projectTemplates.length === 0 && packPresets.length === 0) return null

      const safe = (payload?.defaultName || '模板').replace(/[\\/:*?"<>|]/g, '_')
      const options = {
        title: '导出模板',
        defaultPath: join(app.getPath('documents'), `${safe}.cvstudio.json`),
        filters: [{ name: '模板文件', extensions: ['json'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null

      const file = buildTemplateFile(projectTemplates, packPresets)
      writeFileSync(result.filePath, JSON.stringify(file, null, 2), 'utf8')
      return result.filePath
    }
  )

  /**
   * 从 .json 文件导入模板，可以一次选多个文件，每个文件里也可以有多条。
   *
   * 按每条记录的 `kind` 自动分流：工程配置模板进 templates.json，
   * 模块包模板进 pack-presets.json。
   *
   * 导入的模板一律拿**新 id**，不覆盖本地同名模板 ——
   * 别人给的模板不该把你手里那份顶掉。
   *
   * 模块包模板还会检查 `packId` 是否已安装：没装的包就把那条跳过并计数，
   * 而不是存一个永远用不上的孤儿模板。
   */
  ipcMain.handle(IPC.templateImport, async () => {
    const win = getWindow()
    const options = {
      title: '导入模板',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: '模板文件', extensions: ['json'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null

    const installedPacks = new Set(listPacks().map((p) => p.id))
    let importedProject = 0
    let importedPack = 0
    let skipped = 0
    /** 被跳过的模块包 id，用来告诉用户「你缺哪个包」 */
    const missingPacks = new Set<string>()

    for (const filePath of result.filePaths) {
      try {
        const raw = readFileSync(filePath, 'utf8')
        const parsed = parseTemplateFile(raw)
        skipped += parsed.skipped

        for (const tpl of parsed.projectTemplates) {
          saveTemplate(tpl)
          importedProject++
        }
        for (const preset of parsed.packPresets) {
          if (!installedPacks.has(preset.packId)) {
            missingPacks.add(preset.packId)
            skipped++
            continue
          }
          savePackPreset(preset)
          importedPack++
        }
      } catch {
        skipped++
      }
    }

    return {
      importedProject,
      importedPack,
      imported: importedProject + importedPack,
      skipped,
      missingPacks: [...missingPacks],
      templates: listTemplates(),
      presets: listPackPresets()
    }
  })

  // ---- 批量套用到多个工程 -----------------------------------------------
  //
  // 每个工程独立 try/catch：一个工程不是 CMake 工程不能连坐后面的。
  // 模板里的绝对路径（固件名/芯片/构建目录/工具路径）必须按目标工程重新推导，
  // 所以走 adaptTemplateOptions，而不是直接把 template.options 塞进去。
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
}
