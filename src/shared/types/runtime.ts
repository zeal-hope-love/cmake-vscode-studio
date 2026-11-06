/**
 * 运行期：批量套用模板、启动/取消构建进程、输出流。
 *
 * 进程输出按行推给渲染进程，`stream` 用来区分 stdout/stderr/system
 * （system 是我们自己加的提示，例如「进程已退出，code=1」）。
 */


export interface BatchRequest {
  projectRoots: string[]
  templateId: string
  backup: boolean
}

export interface BatchItemResult {
  projectRoot: string
  ok: boolean
  message: string
  written: string[]
}

export interface BatchResult {
  templateId: string
  items: BatchItemResult[]
}

// ==========================================================================
// 运行（构建 / 烧录）
// ==========================================================================

export interface RunRequest {
  /** 给用户看的标题，例如「构建 Debug」 */
  title: string
  command: string
  args: string[]
  cwd: string
}

export interface RunStarted {
  runId: string
  title: string
  commandLine: string
}

export interface RunOutput {
  runId: string
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface RunExit {
  runId: string
  code: number | null
  signal: string | null
  durationMs: number
}

