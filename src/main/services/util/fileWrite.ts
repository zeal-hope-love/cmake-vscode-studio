/**
 * 带重试的文件写入。
 *
 * ## 为什么要单独抽出来
 *
 * 在这台机器上实测过一个很顽固的现象：**Electron 进程写文件会偶发 EPERM**，
 * 而同一个路径用 Node 进程写就正常。检查过 ACL（`WYFJ\PoXia` 有 FullControl）、
 * 确认过没有别的进程占着文件、事后也能正常写入 —— 就是运行中的瞬时失败。
 *
 * 已经踩过两次：
 *   · `settings.json`（切主题时）
 *   · 快照文件（移植流程第一步就卡住）
 *
 * 两次都是「一次失败就放弃」，于是用户看到「写不进去」。
 * 这个模块把「退避重试」抽出来，所有写用户数据的地方统一用它。
 *
 * ## 为什么用 Atomics.wait 而不是忙等
 *
 * 忙等会一直占着 CPU，把主进程的事件循环堵死 —— 而我们要等的那些
 * 子进程（写缓存、写配置的）也跟着被拖慢，形成「越等越失败」的死循环。
 * Atomics.wait 让当前线程真正挂起，把 CPU 让出去，持锁方才有机会释放。
 */

import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 可以重试的错误码：文件被占用 / 没权限 */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * 退避间隔（毫秒）：10,20,40,80,160,320,320,320,320 —— 合计约 1.6 秒。
 *
 * 定这么多轮是因为实测：Electron 启动瞬间几个子进程（GPU、网络、渲染）
 * 会同时初始化缓存目录，冲突窗口能到 1 秒；如果机器上还跑着火绒这类
 * 实时防护（新建文件先被扫一遍再放行），窗口会更长。
 *
 * 上限刻意停在 1.6 秒：这段是同步等待，主进程会被卡住。再长就不如
 * 直接失败让用户点「重试失败的文件」—— 那个按钮走的是同一套逻辑，
 * 但用户能自己决定什么时候重试。
 */
const BACKOFF = [10, 20, 40, 80, 160, 320, 320, 320, 320]

/** 同步睡眠。见文件头的说明。 */
function sleepMs(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  } catch {
    // 极少数环境不让用，退回忙等
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* fallback */
    }
  }
}

export interface FileWriteResult {
  ok: boolean
  /** 失败原因（已包含路径和错误码），成功时为 undefined */
  error?: string
  /** 失败时的错误码，比如 EPERM / EBUSY / ENOENT */
  code?: string
  /** 实际尝试了几次（1 表示第一次就成功 / 第一次就遇到不可重试错误） */
  attempts?: number
  /**
   * 「所在目录建不出来」的原因（只有这种失败才有）。
   *
   * 单独带出来是因为这里特别容易误诊：目录建不出来时，紧接着的写文件
   * 会报 ENOENT，看起来像是「目录刚被删掉」，实际上是 mkdir 被拒（EPERM）。
   * 之前界面就照着 ENOENT 翻译成「目录不存在」，把排查方向整个带偏了。
   */
  dirError?: { code?: string; message: string }
}

/** 这个错误值不值得重试（被占用 / 没权限 / 只读） */
export function isRetryableWriteError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code ?? ''
  return RETRYABLE.has(code)
}

/**
 * 清掉只读位。
 *
 * Windows 上「文件带只读属性」和「文件被别的进程占着」报的是**同一个** EPERM，
 * 光靠重试救不回来 —— 只读是持续状态，等到天荒地老也不会自己消失。
 * 所以在重试之前顺手把它摘掉：这个工具写的都是自己要管理的配置文件，
 * 本来就不该是只读的。
 */
function clearReadOnly(filePath: string): boolean {
  try {
    const mode = statSync(filePath).mode
    // 已经有写权限就别动，避免无意义地改 mtime/属性
    if (mode & 0o200) return false
    chmodSync(filePath, mode | 0o200)
    return true
  } catch {
    // 文件不存在 / 改不动 —— 交给下面的写入再去撞一次，拿到真实错误
    return false
  }
}

/**
 * 写文本文件，遇到 EPERM/EBUSY/EACCES 自动重试。
 *
 * 不抛异常 —— 调用方自己决定失败时怎么办（设置写了失败可以降级，
 * 快照写了失败必须中止）。
 *
 * @param label 给人看的描述（出现在失败信息里），比如「快照」
 */
export function writeFileWithRetry(filePath: string, text: string, label: string): FileWriteResult {
  let dirError: { code?: string; message: string } | null = null
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch (err) {
    dirError = {
      code: (err as NodeJS.ErrnoException).code,
      message: err instanceof Error ? err.message : String(err)
    }
  }

  let lastErr: unknown = null
  let attempts = 0
  // 只读位只清一次：第一次 EPERM 时怀疑是只读，清完再走重试循环
  let triedClearReadOnly = false

  for (let i = 0; i <= BACKOFF.length; i++) {
    attempts = i + 1
    try {
      writeFileSync(filePath, text, 'utf8')
      return { ok: true, attempts }
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!RETRYABLE.has(code)) break
      if (!triedClearReadOnly) {
        triedClearReadOnly = true
        clearReadOnly(filePath)
      }
      if (i >= BACKOFF.length) break
      sleepMs(BACKOFF[i])
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '未知错误')
  const code = (lastErr as NodeJS.ErrnoException | null)?.code
  const parts = [`${label}写不进去：${filePath}`]
  if (code) parts.push(`（${code}）`)
  if (attempts > 1) parts.push(`，重试 ${attempts} 次仍失败`)
  if (dirError) parts.push(`\n建目录也失败了（${dirError.code ?? 'ERROR'}）：${dirError.message}`)
  parts.push(`\n${msg}`)
  return { ok: false, error: parts.join(''), code, attempts, dirError: dirError ?? undefined }
}