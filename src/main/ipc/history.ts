/**
 * 写入历史：列表、新增、删除、清空。
 *
 * 历史是**用户唯一的审计线索** —— 哪一次写入改了什么、失败了几项。
 * 这里只做转发；真正的追加逻辑在各条写入路径里（写之前就记，
 * 失败项也要进历史，否则用户会以为「没写」等于「没事」）。
 *
 * 注意：模板批量套用的通道（`templateApplyBatch`）**不在这里**，
 * 它属于模板域，见 `template.ts` —— 以前它被塞在历史段后面，
 * 分段注释没覆盖到，容易以为它是历史功能。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { IPC, type HistoryEntry } from '@shared/types'
import { addHistory, clearHistory, listHistory, removeHistory } from '../services/data/historyStore'

export function registerHistory(_getWindow: () => BrowserWindow | null): void {
  // ---- 历史记录 ---------------------------------------------------------
  ipcMain.handle(IPC.historyList, async () => listHistory())
  ipcMain.handle(IPC.historyAdd, async (_e, entry: Omit<HistoryEntry, 'id' | 'at'>) =>
    addHistory(entry)
  )
  ipcMain.handle(IPC.historyRemove, async (_e, id: string) => removeHistory(id))
  ipcMain.handle(IPC.historyClear, async () => clearHistory())
}
