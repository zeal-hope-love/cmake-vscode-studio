/**
 * 工程检测总入口：把 CMake / CubeMX / 构建产物 / .vscode 现状汇总成 ProjectInfo。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type {
  BuildDir,
  CmakeCache,
  CmakePreset,
  ProjectInfo,
  ProjectIssue,
  VscodeFileState
} from '@shared/types'
import {
  parseBuildPresetNames,
  parseCmakeCache,
  parseCmakelists,
  parseCmakePresets
} from './cmakeParser'
import { findIocFile, parseIoc } from './ioc'
import { readJsonFile } from './jsonc'
import { findProjectRoot, toPosix } from './paths'
import { inspectVscodeOwnership } from './vscodeOwnership'

/** 本工具负责读写的 .vscode 文件（顺序即界面展示顺序） */
export const MANAGED_VSCODE_FILES: Array<[string, string]> = [
  ['launch.json', '调试配置'],
  ['tasks.json', '任务'],
  ['settings.json', '工作区设置'],
  ['c_cpp_properties.json', 'IntelliSense']
]

/** 记录每个工程解析出来的 buildPresets 名字，供生成器判断能否用 `--preset` */
const buildPresetCache = new Map<string, Set<string>>()

export function getBuildPresetNames(root: string): Set<string> {
  return buildPresetCache.get(root.toLowerCase()) ?? new Set()
}

const ARTIFACT_SUFFIXES = ['.elf', '.hex', '.bin', '.axf', '.map']

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function scanBuildDir(dir: string): BuildDir | null {
  if (!isDir(dir)) return null

  const cacheFile = join(dir, 'CMakeCache.txt')
  const ninjaFile = join(dir, 'build.ninja')
  const makeFile = join(dir, 'Makefile')

  const hasCache = isFile(cacheFile)
  if (!hasCache && !isFile(ninjaFile) && !isFile(makeFile)) return null

  const cache: CmakeCache | null = hasCache ? parseCmakeCache(cacheFile) : null

  const artifacts: string[] = []
  try {
    for (const child of readdirSync(dir)) {
      if (ARTIFACT_SUFFIXES.includes(child.slice(child.lastIndexOf('.')).toLowerCase())) {
        const full = join(dir, child)
        if (isFile(full)) artifacts.push(full)
      }
    }
  } catch {
    /* ignore */
  }

  if (!artifacts.length) {
    try {
      for (const child of readdirSync(dir)) {
        if (child.startsWith('.')) continue
        const sub = join(dir, child)
        if (!isDir(sub)) continue
        for (const grand of readdirSync(sub)) {
          if (ARTIFACT_SUFFIXES.includes(grand.slice(grand.lastIndexOf('.')).toLowerCase())) {
            const full = join(sub, grand)
            if (isFile(full)) artifacts.push(full)
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  const cc = join(dir, 'compile_commands.json')

  return {
    path: dir,
    name: basename(dir),
    presetName: null,
    buildType: cache?.buildType ?? null,
    generator: cache?.generator ?? (isFile(ninjaFile) ? 'Ninja' : null),
    cache,
    artifacts: artifacts.sort(),
    elf: artifacts.find((a) => a.toLowerCase().endsWith('.elf')) ?? null,
    compileCommands: isFile(cc) ? cc : null,
    configured: cache !== null
  }
}

function collectBuildDirs(root: string, presets: CmakePreset[]): BuildDir[] {
  const candidates: string[] = []

  for (const preset of presets) {
    if (!preset.binaryDir) continue
    candidates.push(
      /^[A-Za-z]:[\\/]/.test(preset.binaryDir) ? preset.binaryDir : join(root, preset.binaryDir)
    )
  }

  const buildRoot = join(root, 'build')
  if (isDir(buildRoot)) {
    candidates.push(buildRoot)
    try {
      for (const child of readdirSync(buildRoot).sort()) {
        if (child.startsWith('.')) continue
        const full = join(buildRoot, child)
        if (isDir(full)) candidates.push(full)
      }
    } catch {
      /* ignore */
    }
  }

  try {
    for (const child of readdirSync(root).sort()) {
      const lower = child.toLowerCase()
      if (!lower.startsWith('cmake-build-') && lower !== 'out' && !lower.startsWith('build-')) continue
      const full = join(root, child)
      if (isDir(full)) candidates.push(full)
    }
  } catch {
    /* ignore */
  }

  const seen = new Set<string>()
  const result: BuildDir[] = []

  for (const raw of candidates) {
    // 统一成规范化绝对路径再去重：preset 的 binaryDir 与目录扫描出来的
    // 写法可能不一样（"a/b" vs "a\\b"），不规范化就会重复出现
    let cand = raw
    try {
      cand = resolve(raw)
    } catch {
      /* 保留原样 */
    }

    const key = cand.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const bd = scanBuildDir(cand)
    if (!bd) continue

    for (const preset of presets) {
      if (preset.binaryDir && preset.binaryDir.toLowerCase() === cand.toLowerCase()) {
        bd.presetName = preset.name
        break
      }
    }
    if (!bd.presetName) {
      const match = presets.find((p) => p.name.toLowerCase() === bd.name.toLowerCase())
      if (match) bd.presetName = match.name
    }
    if (!bd.buildType && bd.presetName) {
      bd.buildType = presets.find((p) => p.name === bd.presetName)?.buildType ?? null
    }

    result.push(bd)
  }

  result.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  return result
}

/**
 * 在构建目录里找「最新」的固件产物（按修改时间）。
 *
 * 只在固件名是猜出来的时候用它补正 —— 同一个 build 目录里可能同时躺着
 * 改名前的旧 elf 和新 elf，取第一个会取到旧的，取最新的才靠谱。
 */
function pickNewestArtifact(buildDirs: BuildDir[]): string | null {
  let best: { path: string; mtime: number } | null = null
  for (const bd of buildDirs) {
    for (const artifact of bd.artifacts) {
      if (!/\.(elf|axf)$/i.test(artifact)) continue
      let mtime = 0
      try {
        mtime = statSync(artifact).mtimeMs
      } catch {
        continue
      }
      if (!best || mtime > best.mtime) best = { path: artifact, mtime }
    }
  }
  return best?.path ?? null
}

function relativizeCmakePaths(paths: string[], root: string): string[] {
  return paths.map((raw) => {
    if (/^[A-Za-z]:[\\/]|^\\\\/.test(raw)) {
      try {
        return toPosix(relative(root, raw))
      } catch {
        return toPosix(raw)
      }
    }
    return toPosix(raw)
  })
}

function describeVscodeFile(name: string, data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '存在'
  const obj = data as Record<string, unknown>

  if (name === 'launch.json') {
    const n = Array.isArray(obj.configurations) ? obj.configurations.length : 0
    return `存在，含 ${n} 个调试配置`
  }
  if (name === 'tasks.json') {
    const n = Array.isArray(obj.tasks) ? obj.tasks.length : 0
    return `存在，含 ${n} 个任务`
  }
  if (name === 'settings.json') {
    return `存在，含 ${Object.keys(obj).length} 项设置`
  }
  if (name === 'c_cpp_properties.json') {
    const n = Array.isArray(obj.configurations) ? obj.configurations.length : 0
    return `存在，含 ${n} 组 IntelliSense 配置`
  }
  return '存在'
}

/**
 * 两个工程名算不算「一样」。
 * 忽略大小写，并把 - 和 _ 视作等价：很多工程文件夹用 -、CMake 目标用 _，
 * 这种不该一直报警告。
 */
function sameProjectName(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, '')
  return norm(a) === norm(b)
}

export function scanProject(projectPath: string, resolveUp = true): ProjectInfo {
  let root = projectPath
  if (resolveUp) {
    const found = findProjectRoot(projectPath)
    if (found) root = found
  }

  const issues: ProjectIssue[] = []
  const notes: string[] = []

  /** 记一条「需要注意的问题」，可以顺带附上一个能直接点的修复动作 */
  const warn = (message: string, fix?: ProjectIssue['fix']): void => {
    issues.push(fix ? { message, fix } : { message })
  }

  if (!isDir(root)) {
    throw new Error(`目录不存在: ${root}`)
  }

  // ---- CMakeLists.txt ---------------------------------------------------
  const parsed = parseCmakelists(join(root, 'CMakeLists.txt'))
  if (!parsed.exists) {
    warn('工程根目录没有 CMakeLists.txt，可能选错了目录')
  } else if (!parsed.targets.length) {
    warn('CMakeLists.txt 里没解析到 add_executable/add_library，ELF 名将回退到 project() 或目录名')
  }

  // CubeMX 生成的工程把 HAL 的 include / define 放在子目录里（典型是
  // cmake/stm32cubemx/CMakeLists.txt），只解析根文件会得到空的 IntelliSense 配置。
  // 这里只往下看一层，避免在大工程上做无谓的递归。
  const includeDirsFromRoot = [...parsed.includeDirs]
  const definesFromRoot = [...parsed.defines]
  for (const sub of parsed.subdirectories.slice(0, 8)) {
    const subFile = join(root, sub, 'CMakeLists.txt')
    if (!isFile(subFile)) continue
    const subParsed = parseCmakelists(subFile)
    for (const d of subParsed.includeDirs) {
      const asRelative = /^[A-Za-z]:[\\/]|^\\\\/.test(d) ? d : join(sub, d)
      if (!includeDirsFromRoot.includes(asRelative)) includeDirsFromRoot.push(asRelative)
    }
    for (const d of subParsed.defines) {
      if (!definesFromRoot.includes(d)) definesFromRoot.push(d)
    }
  }

  // ---- CMakePresets.json ------------------------------------------------
  let presets: CmakePreset[] = []
  let presetFile: string | null = null
  let presetFileKind = ''
  for (const fname of ['CMakePresets.json', 'CMakeUserPresets.json']) {
    const candidate = join(root, fname)
    if (!isFile(candidate)) continue
    const parsedPresets = parseCmakePresets(candidate)
    if (parsedPresets.length) {
      presets = parsedPresets
      presetFile = candidate
      presetFileKind = fname
      buildPresetCache.set(root.toLowerCase(), parseBuildPresetNames(candidate))
      break
    }
  }
  if (!presetFile) {
    buildPresetCache.set(root.toLowerCase(), new Set())
    const hasEmpty = isFile(join(root, 'CMakePresets.json'))
    warn(
      hasEmpty
        ? 'CMakePresets.json 存在但没解析到 configurePresets'
        : '没有 CMakePresets.json：CMake Tools 无法一键切换 Debug/Release，构建目录需要自己保证存在'
    )
  }

  // ---- build 目录 -------------------------------------------------------
  const buildDirs = collectBuildDirs(root, presets)
  if (!buildDirs.length) {
    warn('没有找到已 configure 的构建目录（build/Debug 之类），烧录前需要先构建')
  }

  // ---- CubeMX .ioc ------------------------------------------------------
  const iocFile = findIocFile(root)
  const ioc = iocFile ? parseIoc(iocFile) : null
  if (iocFile && ioc && !ioc.device) {
    warn(`${basename(iocFile)} 里没有 Mcu.CPN / Mcu.UserName，芯片型号需要手填`)
  }
  if (!iocFile) {
    notes.push('没有 .ioc 文件：按通用 CMake 工程处理，不会生成 STM32 专用调试配置')
  }

  // ---- 工具链线索 -------------------------------------------------------
  const hints: string[] = []
  for (const bd of buildDirs) if (bd.cache?.toolchainFile) hints.push(bd.cache.toolchainFile)
  for (const preset of presets) if (preset.toolchainFile) hints.push(preset.toolchainFile)
  let toolchainHint: string | null = hints[0] ?? null
  if (!toolchainHint && ioc) {
    const guess = join(root, 'cmake', 'gcc-arm-none-eabi.cmake')
    if (isFile(guess)) toolchainHint = guess
  }

  // ---- .vscode 现状 -----------------------------------------------------
  const vscodeDir = join(root, '.vscode')
  const vscodeFiles: Record<string, VscodeFileState> = {}

  for (const [fname] of MANAGED_VSCODE_FILES) {
    const filePath = join(vscodeDir, fname)
    if (!isFile(filePath)) {
      vscodeFiles[fname] = {
        name: fname,
        path: filePath,
        exists: false,
        valid: null,
        error: null,
        note: '不存在（将新建）',
        data: null
      }
      continue
    }
    const res = readJsonFile(filePath)
    vscodeFiles[fname] = {
      name: fname,
      path: filePath,
      exists: true,
      valid: res.ok,
      error: res.error,
      note: res.ok ? describeVscodeFile(fname, res.data) : `存在但无法解析：${res.error}`,
      data: res.ok ? res.data : null
    }
  }

  const openocdCfgFiles: string[] = []
  if (isDir(vscodeDir)) {
    try {
      for (const f of readdirSync(vscodeDir).sort()) {
        if (/^openocd-.*\.cfg$/i.test(f)) openocdCfgFiles.push(join(vscodeDir, f))
      }
    } catch {
      /* ignore */
    }
  }

  // ---- 派生字段 ---------------------------------------------------------
  const exeTarget = parsed.targets.find((t) => t.kind === 'executable')
  const anyTarget = parsed.targets[0]

  let elfName =
    exeTarget?.name ?? anyTarget?.name ?? parsed.projectName ?? ioc?.projectName ?? basename(root)
  let elfSource =
    exeTarget?.source ??
    (parsed.projectName
      ? 'CMakeLists.txt project(...)'
      : ioc?.projectName
        ? '.ioc ProjectManager.ProjectName'
        : '工程目录名（推断）')
  let elfNameConfidence: ProjectInfo['elfNameConfidence'] = exeTarget
    ? 'declared'
    : anyTarget || parsed.projectName
      ? 'derived'
      : 'guessed'

  // 构建目录里的 ELF 只能用来「补正」和「核对」，不能无条件压过 CMake 的声明。
  //
  // 踩过的坑：工程从 legacy-name 改名成 test-01 之后，build/Debug 里同时留着
  // legacy-name.elf（旧）和 test-01.elf（新）。旧版逻辑直接取第一个产物，
  // 于是生成的 launch.json 指向了早就过期的 legacy-name.elf。
  const artifactStems = [
    ...new Set(
      buildDirs
        .flatMap((b) => b.artifacts)
        .filter((a) => /\.(elf|axf)$/i.test(a))
        .map((a) => basename(a).replace(/\.(elf|axf)$/i, ''))
        .filter(Boolean)
    )
  ]

  if (elfNameConfidence === 'guessed' && artifactStems.length) {
    // 名字本来就是猜的，让实际产物来定
    const best = pickNewestArtifact(buildDirs)
    const stem = best ? basename(best).replace(/\.(elf|axf)$/i, '') : ''
    if (stem) {
      notes.push(`固件名是从 ${elfSource} 猜的，改用构建目录里实际存在的 ${basename(best!)}`)
      elfName = stem
      elfSource = `构建产物 ${basename(best!)}`
      elfNameConfidence = 'derived'
    }
  } else if (artifactStems.length) {
    // 声明是权威的。但构建目录里如果还有对不上的产物，多半是改名前的残留 ——
    // 两种情形都要报：① 只有旧产物；② 新旧并存（用户真实遇到的就是这种）
    const stale = artifactStems.filter((s) => s.toLowerCase() !== elfName.toLowerCase())

    if (stale.length) {
      const staleList = stale.map((s) => `${s}.elf`).join('、')

      // 顺带把「要删哪些文件」算出来，界面上就能一键清理，而不用自己去找路径。
      // 同一个 stem 下的 .elf / .map / .bin / .hex 都算这批发陈旧产物。
      const staleLower = stale.map((s) => s.toLowerCase())
      const staleFiles = [
        ...new Set(
          buildDirs
            .flatMap((b) => b.artifacts)
            .filter((a) =>
              staleLower.includes(
                basename(a)
                  .replace(/\.[^.]+$/, '')
                  .toLowerCase()
              )
            )
            .map((a) => relative(root, a).replace(/\\/g, '/'))
        )
      ]

      warn(
        stale.length === artifactStems.length
          ? `build 目录里的产物是 ${staleList}，与 CMake 声明的目标名 ${elfName} 不一致。` +
              `已按 CMakeLists.txt 为准；这些多半是改名前的旧产物，建议清理后重新构建。`
          : `build 目录里有多个不同名字的产物，其中 ${staleList} 与 CMake 声明的目标名 ` +
              `${elfName} 不一致，多半是改名前的旧产物，建议清理后重新构建。`,
        staleFiles.length
          ? {
              kind: 'remove-build-artifacts',
              label: `清理 ${staleFiles.length} 个陈旧产物`,
              files: staleFiles,
              hint: staleFiles.join('、')
            }
          : undefined
      )
    }
  }

  /**
   * 目录名 vs CMake 工程名。
   *
   * 这是「从模板复制一个工程、只改了文件夹名」留下的典型坑：目录叫 target-car，
   * 而 CMakeLists.txt 里还写着 set(CMAKE_PROJECT_NAME standard_robot)，
   * 于是构建产物叫 standard_robot.elf，但 VSCode 的构建分析器、别人看目录名、
   * Keil 工程覆盖都按 target-car 去找 —— 对不上，还很难查（文件都在，就是不显示）。
   *
   * 这里只**提示**，不自动改：改名会改变产物名，可能牵动烧录脚本、别人的 mdk 工程，
   * 得由用户拍板。确认了再点按钮走 projectRenamePlan/Apply（带 diff 和快照）。
   */
  const folderName = basename(root)
  const cmakeName = parsed.projectName ?? null
  if (cmakeName && !sameProjectName(folderName, cmakeName)) {
    warn(
      `工程目录叫 ${folderName}，但 CMake 里声明的工程名是 ${cmakeName} —— ` +
        `构建产物会叫 ${cmakeName}.elf，而 VSCode 的构建分析器等工具按文件夹名找，容易对不上。`,
      {
        kind: 'rename-project',
        label: `把工程名改成 ${folderName}`,
        files: ['CMakeLists.txt'],
        hint: `set(CMAKE_PROJECT_NAME ${cmakeName}) → ${folderName}（.ioc 也会一起改名）`,
        targetName: folderName
      }
    )
  }

  /**
   * .vscode/settings.json 里的 `cmake.cmakePath` 指向的程序是否真的存在。
   *
   * 这坑很隐蔽：配置文件格式完全合法、界面上也看不出问题，但 CMake Tools 配置不起来，
   * 于是 VS Code 的构建分析器拿不到构建目标，退回按文件夹名猜 —— 猜出来的 ELF 不存在，
   * 报「映射文件数据不可用」。这类问题**必须工具主动查出来**，否则根本没法定位。
   *
   * 常见来源：STM32Cube for VS Code 扩展写了个 `cube-cmake`（它的私有包装），
   * 但那个程序并不在 PATH 里。本工具不自动改别人的配置，只报出来 + 给正确路径建议。
   */
  try {
    const settingsFile = join(vscodeDir, 'settings.json')
    if (existsSync(settingsFile)) {
      const j = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
      const raw = j['cmake.cmakePath']
      if (typeof raw === 'string' && raw.trim()) {
        const val = raw.trim()
        const bare = !/[\\/]/.test(val)
        const found = bare
          ? (process.env.PATH ?? '')
              .split(';')
              .filter(Boolean)
              .some((d) => existsSync(join(d, `${val}.exe`)) || existsSync(join(d, val)))
          : existsSync(val)
        if (!found) {
          warn(
            `.vscode/settings.json 里 cmake.cmakePath 设成了「${val}」，但找不到这个程序 —— ` +
              `CMake Tools 会配置失败，VS Code 的构建分析器等工具也就拿不到构建目标（表现为「映射文件数据不可用」）。` +
              `建议改成真实的 cmake 路径，或者删掉这一项让它走 PATH。`,
            undefined
          )
        }
      }
    }
  } catch {
    /* settings.json 解析不了就当没有，别为了这个把检测搞崩 */
  }
  /** 哪些 .vscode 文件确实是本工具写的（按内容特征认） */
  const ownership = inspectVscodeOwnership(root)

  const device = ioc?.device ?? null
  const toolchainLower = (toolchainHint ?? '').toLowerCase()
  const isEmbedded =
    ioc !== null ||
    toolchainLower.includes('arm-none-eabi') ||
    toolchainLower.includes('gcc-arm') ||
    buildDirs.some((b) =>
      `${b.cache?.cCompiler ?? ''}${b.cache?.toolchainFile ?? ''}`
        .toLowerCase()
        .includes('arm-none-eabi')
    )

  return {
    root,
    name: basename(root),
    cmakeMinimum: parsed.cmakeMinimum,
    targets: parsed.targets,
    cmakeProjectName: parsed.projectName,
    presets,
    presetFile,
    presetFileKind,
    buildDirs,
    ioc,
    toolchainHint,
    vscodeDir,
    vscodeFiles,
    // 「哪些是本工具写的」按**内容特征**判断，不是看文件在不在 ——
    // 只看存在性的话，清除配置时会把 STM32Cube / CMake Tools 扩展写的同名文件删掉。
    toolWrittenFiles: ownership.ours,
    foreignVscodeFiles: ownership.all.filter((v) => !v.ours).map((v) => ({ path: v.path, why: v.why })),
    openocdCfgFiles,
    includeDirs: relativizeCmakePaths(includeDirsFromRoot, root),
    defines: definesFromRoot,
    hasCompileCommands: parsed.hasCompileCommands || buildDirs.some((b) => b.compileCommands !== null),
    // warnings 与 issues 一一对应：warnings 是给只用文本的地方用的
    warnings: issues.map((i) => i.message),
    issues,
    notes,
    // 派生
    elfName,
    elfSource,
    elfNameConfidence,
    device,
    isEmbedded
  }
}

export { existsSync, isDir, isFile }
