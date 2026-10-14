/**
 * 进程运行器：一键构建 / 烧录，并把输出实时推给界面。
 *
 * 两个 Windows 上的实际坑，这里都处理了：
 *   1. 中文系统下子进程输出可能是 GBK，按 UTF-8 解会乱码 —— 逐行尝试 UTF-8，
 *      失败再退回 GBK。
 *   2. 需要在多字节字符中间断开的地方按行缓冲，不能一个 chunk 一个 chunk 地解。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { RunExit, RunOutput, RunRequest, RunStarted } from '@shared/types'

/** 按行切分 Buffer，并对每一整行做编码探测 */
class LineDecoder {
  private pending = Buffer.alloc(0)

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk])
    let index = this.pending.indexOf(0x0a)
    while (index >= 0) {
      const lineBuf = this.pending.subarray(0, index + 1)
      this.pending = this.pending.subarray(index + 1)
      this.onLine(decodeBuffer(lineBuf))
      index = this.pending.indexOf(0x0a)
    }
  }

  flush(): void {
    if (!this.pending.length) return
    this.onLine(decodeBuffer(this.pending))
    this.pending = Buffer.alloc(0)
  }
}

function decodeBuffer(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

interface RunHandle {
  id: string
  title: string
  child: ChildProcessWithoutNullStreams
  startedAt: number
}

export class ProcessRunner extends EventEmitter {
  private runs = new Map<string, RunHandle>()

  start(request: RunRequest): RunStarted {
    const id = randomUUID()

    if (!existsSync(request.cwd)) {
      throw new Error(`工作目录不存在: ${request.cwd}`)
    }

    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      windowsHide: true,
      shell: false
    }) as ChildProcessWithoutNullStreams

    const handle: RunHandle = { id, title: request.title, child, startedAt: Date.now() }
    this.runs.set(id, handle)

    const commandLine = [request.command, ...request.args]
      .map((part) => (/\s/.test(part) ? `"${part}"` : part))
      .join(' ')

    const emit = (stream: RunOutput['stream'], text: string): void => {
      this.emit('output', { runId: id, stream, text } satisfies RunOutput)
    }

    emit('system', `$ ${commandLine}\n`)
    emit('system', `  (工作目录: ${request.cwd})\n\n`)

    const stdoutDecoder = new LineDecoder((line) => emit('stdout', line))
    const stderrDecoder = new LineDecoder((line) => emit('stderr', line))

    child.stdout.on('data', (chunk: Buffer) => stdoutDecoder.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrDecoder.push(chunk))

    child.on('error', (err) => {
      emit('system', `\n[启动失败] ${err.message}\n`)
    })

    child.on('close', (code, signal) => {
      stdoutDecoder.flush()
      stderrDecoder.flush()

      const durationMs = Date.now() - handle.startedAt
      const exit: RunExit = { runId: id, code, signal, durationMs }
      this.runs.delete(id)
      this.emit('exit', exit)
    })

    return { runId: id, title: request.title, commandLine }
  }

  cancel(runId: string): void {
    const handle = this.runs.get(runId)
    if (!handle) return
    try {
      handle.child.kill()
    } catch {
      /* ignore */
    }
  }

  cancelAll(): void {
    for (const id of [...this.runs.keys()]) this.cancel(id)
  }
}
