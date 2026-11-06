/**
 * 工程探测结果：CMake 侧的事实、.ioc 里的芯片信息、.vscode 现状、以及「有哪些问题」。
 *
 * 这一族回答的是「这个目录到底是不是一个能用的 STM32 CMake 工程」，
 * 全部由 `services/scanner.ts` 产出，界面只读不写。
 */


export interface CmakeTarget {
  name: string
  kind: 'executable' | 'library' | 'unknown'
  /** 从哪条指令解析出来的，用来向用户解释 */
  source: string
}

export interface CmakePreset {
  name: string
  hidden: boolean
  generator: string | null
  binaryDir: string | null
  buildType: string | null
  toolchainFile: string | null
  inherits: string[]
  cacheVariables: Record<string, string>
}

export interface CmakeCache {
  path: string | null
  generator: string | null
  buildType: string | null
  cCompiler: string | null
  cxxCompiler: string | null
  makeProgram: string | null
  toolchainFile: string | null
  exportCompileCommands: boolean | null
  projectName: string | null
}

// ==========================================================================
// STM32 / CubeMX
// ==========================================================================

export interface IocInfo {
  file: string | null
  /** Mcu.CPN，完整订货号，例如 STM32F103C8T6 */
  cpn: string | null
  userName: string | null
  mcuName: string | null
  family: string | null
  package: string | null
  projectName: string | null
  /** 综合推断出的芯片型号 */
  device: string | null
}

// ==========================================================================
// 构建目录 / 工程
// ==========================================================================

export interface BuildDir {
  path: string
  name: string
  presetName: string | null
  buildType: string | null
  generator: string | null
  cache: CmakeCache | null
  artifacts: string[]
  elf: string | null
  compileCommands: string | null
  configured: boolean
}

export interface VscodeFileState {
  name: string
  path: string
  exists: boolean
  /** null 表示文件不存在、无从判断 */
  valid: boolean | null
  error: string | null
  /** 一句人话描述，例如「存在，含 3 个调试配置」 */
  note: string
  /** 解析出来的原始对象；不存在或解析失败时为 null */
  data: unknown
}

/**
 * 一条「需要注意的问题」上可以附带的直接修复动作。
 *
 * 目前只有「删掉构建目录里的陈旧产物」这一种 —— 这是本工具唯一会**删工程内文件**的
 * 动作，所以主进程会对每个路径重新校验（必须在工程内、必须是构建产物后缀），
 * 不信任调用方传来的东西。
 */
export interface ProjectIssueFix {
  kind: 'remove-build-artifacts' | 'rename-project'
  label: string
  /** 相对工程根的路径 */
  files: string[]
  hint: string
  /** kind = rename-project 时：要改成什么名字（通常是文件夹名） */
  targetName?: string
}

/** 改名计划：每个文件的改前/改后全文，交给界面做 diff */
export interface RenameFileChange {
  /** 相对工程根 */
  path: string
  action: 'create' | 'patch' | 'delete' | 'skip'
  before: string | null
  after: string | null
  note: string
}

export interface RenamePlan {
  root: string
  newName: string
  changes: RenameFileChange[]
  /** 说明这次改了什么、为什么有些东西不改 */
  notes: string[]
  /** 有致命问题，不能改 */
  blocked: boolean
}

export interface ProjectIssue {
  message: string
  fix?: ProjectIssueFix
}

export interface ProjectInfo {
  root: string
  name: string
  cmakeMinimum: string | null
  targets: CmakeTarget[]
  cmakeProjectName: string | null
  presets: CmakePreset[]
  presetFile: string | null
  presetFileKind: string
  buildDirs: BuildDir[]
  ioc: IocInfo | null
  toolchainHint: string | null
  vscodeDir: string
  vscodeFiles: Record<string, VscodeFileState>
  /** **确认是本工具写的** .vscode 文件（按内容特征判断，不是看文件存不存在） */
  toolWrittenFiles: string[]
  /** 存在、但看起来是别的扩展写的 —— 清除时不会动它们，这里给理由 */
  foreignVscodeFiles: Array<{ path: string; why: string }>
  openocdCfgFiles: string[]
  includeDirs: string[]
  defines: string[]
  hasCompileCommands: boolean
  /** 注意：由 issues 派生，保持两者一一对应 */
  warnings: string[]
  /** 与 warnings 一一对应，但带可执行动作 */
  issues: ProjectIssue[]
  notes: string[]

  // 派生字段（由主进程算好，渲染进程直接展示）
  elfName: string
  elfSource: string
  /**
   * 固件名的可信度。决定「构建目录里的产物」能不能覆盖它：
   *   declared —— 来自 CMakeLists 的 add_executable，权威；产物不一致时只报警告
   *   derived  —— 来自 project() / set(CMAKE_PROJECT_NAME)，较可信
   *   guessed  —— 来自 .ioc 或目录名，属于猜测，可以让实际产物来纠正
   */
  elfNameConfidence: 'declared' | 'derived' | 'guessed'
  device: string | null
  isEmbedded: boolean
}

// ==========================================================================
// 工具链
// ==========================================================================
