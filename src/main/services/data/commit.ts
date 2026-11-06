/**
 * 写盘的两道闸：**动手之前存快照**、**动手之后记历史**。
 *
 * ## 为什么要有这个文件
 *
 * 「先存快照，存不下就不许写」这条承诺原本抄在五个地方：常规包装载、
 * 移植包装载、工程重命名、CMakeLists 源文件管理、删除文件。五份写法还各不相同 ——
 * 有的只判空、有的 try/catch、有的**根本没判**（存快照失败照样把文件丢进回收站，
 * 那一步再也回不来了）。
 *
 * 文案也不一致：用户看到的有时是「存快照失败，已中止」，有时是
 * 「没能存下快照，一个文件都没动」，而真正的原因（磁盘满、ACL、路径不可写）
 * 全都丢了 —— 那才是用户唯一能自救的信息。
 *
 * 所以收成两个函数，各调用点只管一件事：失败就把 `message` 塞进 errors。
 *
 * ## 中间那段为什么没抽
 *
 * 写盘本身两边差别太大：常规包是「一次算好全文，逐份覆盖」，移植包是
 * 「改 .ioc → 跑 CubeMX → 打补丁 → 改业务代码」六步各写各的。
 * 硬套一个事务模型只会让后者更难读。抽的是两头，不是全部。
 */

import { captureSnapshotDetailed, type SnapshotEntry } from './snapshotStore'
import { recordWrite } from './historyStore'

export interface SnapshotGate {
  ok: boolean
  /** 成功时的快照 id，失败时 null */
  id: string | null
  /** 失败时可直接展示给用户的整句（已含「已中止」和真实原因） */
  message: string
}

/**
 * 存快照。失败时**返回原因**而不是吞掉 —— 打包版里 stderr 看不到，
 * 界面上那句「快照存不下」是用户唯一的线索。
 */
export function openSnapshot(root: string, entries: SnapshotEntry[]): SnapshotGate {
  let id: string | null = null
  let why = ''
  try {
    const r = captureSnapshotDetailed(root, entries)
    id = r.id
    why = r.error ?? ''
  } catch (err) {
    why = err instanceof Error ? err.message : String(err)
  }
  if (!id) {
    return {
      ok: false,
      id: null,
      message: `没能存下快照（${why || '未知原因'}）。为避免改坏了无法还原，已中止，一个文件都没动。`
    }
  }
  return { ok: true, id, message: '' }
}

/**
 * 记一笔历史。**失败不抛**：历史记不上不该让已经写好的文件变成「失败」，
 * 但也不能静默 —— historyStore 内部会进 pending 队列，下次启动补写。
 */
export function recordInstall(
  root: string,
  title: string,
  errors: string[],
  snapshotId: string | null
): void {
  try {
    recordWrite(root, [title], errors, snapshotId)
  } catch {
    /* 历史记不上不影响主流程 */
  }
}
