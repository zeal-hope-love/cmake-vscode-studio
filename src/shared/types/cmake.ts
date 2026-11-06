/**
 * 「构建目标与源文件」页的契约：扫描结果、改动请求、diff 预览、落地结果。
 *
 * 这一组的形状由 `services/cmakeModel.ts`（位置感知的解析器）决定 ——
 * 预览里带的是**精确字符区间**，不是简单的名字列表，否则回写会改错位置。
 */


export interface SourceTargetRow {
  name: string
  kind: string
  declaredLine: number
  declaredCommand: string
  sourceCount: number
  includeCount: number
  defineCount: number
  linkCount: number
  /** 用了 file(GLOB) 自动收集 —— 手动加文件是多余的 */
  usesGlob: boolean
}

export interface CmakeScanResult {
  root: string
  cmakeFile: string
  projectName: string | null
  targets: SourceTargetRow[]
  /** 根目标在构建里的源文件 */
  inBuild: string[]
  /** 磁盘上可编译、但整个工程都没引用到的 —— 「加入构建」的候选 */
  orphans: string[]
  /** 写了但磁盘上没有的 */
  missing: Array<{ relPath: string; raw: string; line: number }>
  /** 整个构建图里的全部 target（说明「为什么有 N 个 CMakeLists」用） */
  allTargets: Array<{
    name: string
    kind: string
    file: string
    sourceCount: number
    isExecutable: boolean
  }>
  /** 构建入口（永远是根 CMakeLists.txt） */
  buildEntry: string
  /** 疑似别的构建系统（Keil/IAR）留下的残留 —— 和「漏加」分开处理 */
  leftovers: Array<{ relPath: string; reason: string; system: string }>
  /** 构建文件的注释里提到某个「不在构建里」的文件的地方 —— 引用原文 + 出处，不做语义判断 */
  orphanNotes: Array<{
    relPath: string
    notes: Array<{ file: string; line: number; text: string }>
  }>
  stats: {
    compilableOnDisk: number
    headersOnDisk: number
    referencedProjectWide: number
    /** 构建定义没看全的地方（file(GLOB)、展开不了的变量等）。非空时「不在构建里」可能不准 */
    cmakeUnresolved: string[]
    /** 解析过哪些 CMake 文件，用来向用户解释结论是怎么来的 */
    cmakeParsedFiles: string[]
    cmakeListsCount: number
  }
  diagnostics: string[]
  /** 展不开变量的条目（认不出是哪个文件），界面上灰着显示 */
  unresolved: Array<{ raw: string; line: number }>
  /** 工程里所有含源码的目录（含 '.'），给「新建文件」的下拉用 */
  dirs: string[]
}

/** 「工程有没有变」的指纹：只 stat 目录和 CMakeLists，比全量扫描便宜得多 */
export interface CmakeSignature {
  dirCount: number
  dirMtimeMax: number
  cmakeMtimeMax: number
  compilableCount: number
}

export interface CmakeChangeRequest {
  root: string
  targetName: string
  add?: string[]
  remove?: string[]
}

export interface CmakeChangePreview {
  file: string
  relativePath: string
  before: string
  after: string
  notes: string[]
  added: string[]
  removed: string[]
  /** 用了「文件末尾托管区块」而不是就地插入 */
  usedFallback: boolean
  changed: boolean
}

export interface CmakeApplyResult {
  ok: boolean
  file: string
  added: string[]
  removed: string[]
  notes: string[]
  usedFallback: boolean
  snapshotId: string | null
  errors: string[]
}

export type NewFileKind = 'c' | 'h' | 'cpp' | 'task-c' | 'task-h'

export interface CreateSourceFileResult {
  ok: boolean
  relPath: string
  absPath: string
  error?: string
}
