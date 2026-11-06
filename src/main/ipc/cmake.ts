/**
 * CMake 侧：扫描目标、预览/应用源文件改动、新建源文件、改工程名。
 *
 * 「预览」和「应用」是两条独立通道，因为界面要先给用户看 diff ——
 * 预览只读，应用才落盘（并且先存快照）。
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import { applySourceChange, createSourceFile, previewSourceChange, scanSources, signatureOf } from '../services/project/sourceScanner'
import { readFileSync } from 'node:fs'
import { IPC, type CmakeChangeRequest, type NewFileKind } from '@shared/types'
import type { RenamePlan } from '@shared/types'
import { openSnapshot, recordInstall } from '../services/data/commit'
import { resolveInsideProject } from '../services/generate/writer'
import { captureSnapshot } from '../services/data/snapshotStore'
import { applyProjectRename, planProjectRename } from '../services/project/projectRename'

export function registerCmake(getWindow: () => BrowserWindow | null): void {
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

  /**
   * 把文件移到回收站（不是直接删）。
   *
   * 为什么用回收站而不是 rm：这一栏是「Keil 时代的残留，要不要清理」，
   * 属于**建议性**操作，删错了用户可能就找不回来了。走回收站的话，
   * 判断失误的代价只是去回收站捞一下。同样先存快照。
   */
  ipcMain.handle(IPC.cmakeTrashFiles, async (_e, projectRoot: string, relPaths: string[]) => {
    const result: { ok: boolean; trashed: string[]; errors: string[] } = {
      ok: false,
      trashed: [],
      errors: []
    }
    const targets: Array<{ rel: string; abs: string }> = []
    for (const rel of relPaths) {
      const abs = resolveInsideProject(projectRoot, rel)
      if (!abs) {
        result.errors.push(`${rel}：路径越界，已跳过`)
        continue
      }
      targets.push({ rel, abs })
    }
    if (!targets.length) return result

    // 丢进回收站是**不可逆**的，所以快照存不下就必须停 ——
    // 这里原本只 try/catch 不看返回值，存快照失败照样往下删。
    const gate = openSnapshot(
      projectRoot,
      targets.map((t) => ({ relativePath: t.rel, previous: readFileSync(t.abs, 'utf8') }))
    )
    if (!gate.ok) {
      result.errors.push(gate.message)
      return result
    }

    for (const t of targets) {
      try {
        await shell.trashItem(t.abs)
        result.trashed.push(t.rel)
      } catch (err) {
        result.errors.push(`${t.rel}：${(err as Error).message}`)
      }
    }
    recordInstall(
      projectRoot,
      `清理 ${result.trashed.length} 个残留文件（已移到回收站）`,
      result.errors,
      gate.id
    )
    result.ok = result.errors.length === 0
    return result
  })

  // ---- 改工程名（目录名 vs CMake 工程名 不一致时用）------------------------
  //
  // 检测到不一致时界面给一个按钮，点一下先出 diff（projectRenamePlan，只算不写），
  // 确认后才落盘（projectRenameApply，先存快照）。
  // 改名字是不可逆操作，所以宁可多一步确认。
  ipcMain.handle(
    IPC.projectRenamePlan,
    async (_e, projectRoot: string, newName: string, withIoc?: boolean) =>
      planProjectRename(projectRoot, newName, withIoc ?? true)
  )

  ipcMain.handle(IPC.projectRenameApply, async (_e, plan: RenamePlan) => applyProjectRename(plan))
}
