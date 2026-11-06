/**
 * 模块包：声明式包（vofa）的清单/计划/安装，移植包（VT13）的预检/安装，
 * 以及包的参数预设。
 *
 * 两条安装路径的差别见 docs/HANDOVER.md「两条安装路径」：
 * 常规包能提前算出 diff，移植包不行（要调 CubeMX），所以走快照 + 进度事件。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { applyPackInstall, planPackInstall, type ApplyStep } from '../services/pack/index'
import { runPortInstall } from '../services/pack/packPortInstaller'
import { deletePackPreset, listPackPresets, listPackPresetsFor, savePackPreset } from '../services/data/packPresetStore'
import { preflight } from '../services/vt13/portRunner'
import { TEMPLATE_FORMAT_DOC, type PackPreset } from '@shared/templateFormat'
import { checkPackCompat, inspectProject, listPacks, loadPack, scanPidStructs } from '../services/pack/packStore'
import { scanSymbols } from '../services/project/symbolScanner'
import { loadVofaMap, saveVofaMap } from '../services/data/vofaMapStore'
import { scanProjectVars } from '../services/project/elfSymbols'
import { loadAddrTable, saveAddrTable } from '../services/data/addrTableStore'
import { IPC } from '@shared/types'
import type { VofaMap } from '@shared/vofaMap'
import type { AddrSlot } from '@shared/addrTable'
import type { PackApplyResult, PackPlan, PackPortPreflightResult, PackPortResult } from '@shared/packTypes'
import type { PackInspectResult, PackPlanOptions } from '@shared/types'

export function registerPack(getWindow: () => BrowserWindow | null): void {
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
        existingFiles: facts.existingVofa,
        symbolHeaders: [...facts.symbolHeaders].map(([symbol, file]) => ({ symbol, file })),
        symbols: scanSymbols(projectRoot),
        savedMap: packId === 'vofa' ? loadVofaMap(projectRoot) : null
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
    /*
     * 每一步都推给界面。CubeMX 那次调用会跑几十秒，`invoke` 在这期间
     * 是拿不到中间状态的 —— 不推进度，用户只能看一个转圈。
     */
    const runId = String(Date.now())
    const onStep = (step: ApplyStep): void => {
      try {
        if (!_e.sender.isDestroyed()) _e.sender.send(IPC.packApplyProgress, { runId, step })
      } catch {
        /* 窗口没了就没人看进度了 */
      }
    }
    return applyPackInstall(plan, { onStep })
  })

  ipcMain.handle(IPC.vofaMapSave, async (_e, projectRoot: string, map: VofaMap) =>
    saveVofaMap(projectRoot, map)
  )

  // 地址级调参的数据源：只读 .elf，不碰工程里任何文件
  ipcMain.handle(IPC.vofaElfVars, async (_e, projectRoot: string, elfPath?: string) =>
    scanProjectVars(projectRoot, elfPath)
  )

  // 地址表本身：跟着工程走的一小份配置，和 vofa_map.json 并列但互不影响
  ipcMain.handle(IPC.vofaAddrLoad, async (_e, projectRoot: string) => loadAddrTable(projectRoot))
  ipcMain.handle(IPC.vofaAddrSave, async (_e, projectRoot: string, slots: AddrSlot[]) =>
    saveAddrTable(projectRoot, slots)
  )

  // ---- 移植包（VT13 这类）------------------------------------------------
  //
  // 和上面的 packPlan/packApply 是两条路：移植包要调 CubeMX 这种外部程序，
  // 改的文件数没法事先确定，所以不能像常规包那样「先算 diff 再确认」。
  // 保底手段是「动手前存快照」，出问题用「历史与恢复」整体还原。

  ipcMain.handle(
    IPC.packPortPreflight,
    async (_e, packId: string, projectRoot: string): Promise<PackPortPreflightResult> => {
      const pack = listPacks().find((p) => p.id === packId)
      if (!pack) {
        return {
          ok: false,
          items: [{ label: '模块包', level: 'err', detail: `找不到模块包 ${packId}` }],
          iocPath: null
        }
      }
      return preflight(projectRoot, pack)
    }
  )

  ipcMain.handle(
    IPC.packPortInstall,
    async (
      _e,
      options: { packId: string; projectRoot: string; skipCubeMx?: boolean }
    ): Promise<PackPortResult> => {
      /** 这一次运行的标识，用来把进度事件和具体某次调用对上 */
      const runId = String(Date.now())
      const pack = listPacks().find((p) => p.id === options.packId)
      if (!pack) {
        return {
          ok: false,
          preflight: { ok: false, items: [], iocPath: null },
          steps: [],
          acceptance: [],
          snapshotId: null,
          errors: [`找不到模块包 ${options.packId}`],
          warnings: []
        }
      }
      return runPortInstall({
        root: options.projectRoot,
        pack,
        skipCubeMx: options.skipCubeMx,
        /*
         * 每完成一步就推给渲染进程。
         *
         * 用 runId 区分不同的运行（用户连点两次、或者中途重跑），
         * 界面只认当前这次，防止上一轮的残留事件把进度条弄乱。
         *
         * `_e.sender` 是发起这次调用的那个窗口；窗口关了 send 会抛，
         * 所以包一层 try —— 用户关窗口不该让移植流水线崩掉。
         */
        onProgress: (step) => {
          try {
            if (!_e.sender.isDestroyed()) {
              _e.sender.send(IPC.packPortProgress, { runId, step })
            }
          } catch {
            /* 窗口没了就没人看进度了，不影响流程本身 */
          }
        }
      })
    }
  )

  // ---- 模块包模板 -------------------------------------------------------
  ipcMain.handle(IPC.packPresetList, async (_e, packId?: string) =>
    packId ? listPackPresetsFor(packId) : listPackPresets()
  )
  ipcMain.handle(IPC.packPresetSave, async (_e, preset: PackPreset) => savePackPreset(preset))
  ipcMain.handle(IPC.packPresetDelete, async (_e, id: string) => deletePackPreset(id))

  /** 格式说明（给「复制格式说明」按钮用） */
  ipcMain.handle(IPC.templateFormatDoc, async () => TEMPLATE_FORMAT_DOC)
}
