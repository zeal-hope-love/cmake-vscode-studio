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

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 可以重试的错误码：文件被占用 / 没权限 */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * 退避间隔（毫秒）：10,20,40,80,160,200,200,200 —— 合计约 0.9 秒。
 *
 * 定这么多轮是因为实测：Electron 启动瞬间几个子进程（GPU、网络、渲染）
 * 会同时初始化缓存目录，冲突窗口能到 1 秒。
 */
const BACKOFF = [10, 20, 40, 80, 160, 200, 200, 200]

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

export interface WriteResult {
  ok: boolean
  /** 失败原因（已包含路径和错误码），成功时为 undefined */
  error?: string
}

/**
 * 写文本文件，遇到 EPERM/EBUSY/EACCES 自动重试。
 *
 * 不抛异常 —— 调用方自己决定失败时怎么办（设置写了失败可以降级，
 * 快照写了失败必须中止）。
 *
 * @param label 给人看的描述（出现在失败信息里），比如「快照」
 */
export function writeFileWithRetry(filePath: string, text: string, label: string): WriteResult {
  let dirError: string | null = null
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch (err) {
    dirError = err instanceof Error ? err.message : String(err)
  }

  let lastErr: unknown = null
  for (let i = 0; i <= BACKOFF.length; i++) {
    try {
      writeFileSync(filePath, text, 'utf8')
      return { ok: true }
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!RETRYABLE.has(code)) break
      if (i >= BACKOFF.length) break
      sleepMs(BACKOFF[i])
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '未知错误')
  const code = (lastErr as NodeJS.ErrnoException | null)?.code
  const parts = [`${label}写不进去：${filePath}`]
  if (code) parts.push(`（${code}）`)
  if (dirError) parts.push(`\n建目录也失败了：${dirError}`)
  parts.push(`\n${msg}`)
  return { ok: false, error: parts.join('') }
}