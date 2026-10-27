/**
 * 配置生成器：把「检测结果 + 用户选择的参数」变成 4~5 个待写入文件的内容。
 *
 * 这里是整个工具的核心 —— 生成什么、哪些字段用 ${workspaceFolder} 变量、
 * 哪个条目当默认构建任务，全部集中在这一个文件里，方便对照修改。
 */

import { basename } from 'node:path'
import type {
  ConfigBundle,
  CppConfiguration,
  CppPropertiesFile,
  GenOptions,
  LaunchConfig,
  LaunchFile,
  ProjectInfo,
  SettingsFile,
  TaskDef,
  TasksFile,
  ProbeOption,
  AppSettings,
  ToolPaths
} from '@shared/types'
import { probeByKey } from '@shared/probes'
import { mapOpenocdTarget, openocdCfgFileName } from './ioc'
import { getBuildPresetNames } from './scanner'
import { findSvdFile } from './toolDetector'
import { relativePosix, toPosix } from './paths'

const WS = '${workspaceFolder}'

/** 把工程内相对路径包成 VSCode 变量形式，并统一成正斜杠 */
function ws(relPath: string): string {
  return `${WS}/${toPosix(relPath)}`
}

// --------------------------------------------------------------------------
// 默认参数推断
// --------------------------------------------------------------------------

/** 在构建目录里找名字或构建类型匹配的目录 */
function pickBuildDir(project: ProjectInfo, typeHint: string): string | null {
  const hint = typeHint.toLowerCase()
  const byType = project.buildDirs.find((b) => (b.buildType ?? '').toLowerCase() === hint)
  if (byType) return relativePosix(project.root, byType.path)
  const byName = project.buildDirs.find((b) => b.name.toLowerCase().includes(hint))
  if (byName) return relativePosix(project.root, byName.path)
  return null
}

function pickPresetName(project: ProjectInfo, typeHint: string): string | null {
  const hint = typeHint.toLowerCase()
  const usable = project.presets.filter((p) => !p.hidden)
  return (
    usable.find((p) => p.name.toLowerCase() === hint)?.name ??
    usable.find((p) => p.name.toLowerCase().includes(hint))?.name ??
    null
  )
}

export function defaultGenOptions(
  project: ProjectInfo,
  tools: ToolPaths | null,
  settings: AppSettings
): GenOptions {
  const probe = probeByKey(settings.probeKey)

  const debugDir = pickBuildDir(project, 'debug') ?? 'build/Debug'
  const releaseDir = pickBuildDir(project, 'release') ?? 'build/Release'

  const debugPreset = pickPresetName(project, 'debug') ?? 'Debug'
  const releasePreset = pickPresetName(project, 'release') ?? 'Release'

  const device = project.device ?? ''
  const targetCfg =
    settings.targetCfgOverride.trim() ||
    mapOpenocdTarget(device) ||
    (project.buildDirs.length ? 'stm32f1x.cfg' : '')

  const generator =
    project.presets.find((p) => !p.hidden && p.generator)?.generator ??
    project.buildDirs.find((b) => b.generator)?.generator ??
    'Ninja'

  // compile_commands.json 才是 IntelliSense 要的东西。优先用 build 目录里真实存在的那个，
  // 没有就按约定拼一个路径（别再指向 .elf —— 那是早期版本的写法，界面上看着莫名其妙）。
  const debugBuild = project.buildDirs.find((b) => b.name.toLowerCase().includes('debug'))
  const compileCommands = debugBuild?.compileCommands
    ? relativePosix(project.root, debugBuild.compileCommands)
    : `${debugDir}/compile_commands.json`

  const elfName = project.elfName

  return {
    elfName,
    device,
    probeKey: probe.key,
    interfaceCfg: probe.interfaceCfg,
    resetConfig: probe.resetConfig,
    targetCfg,
    adapterSpeed: settings.adapterSpeed,
    openocdExe: tools?.items.openocd?.path ?? '',
    cmakeExe: tools?.items.cmake?.path ?? '',
    ninjaExe: tools?.items.ninja?.path ?? '',
    toolchainDir: tools?.toolchainDir ?? '',
    debugDir,
    releaseDir,
    debugPreset,
    releasePreset,
    hasBuildPresets: getBuildPresetNames(project.root).size > 0,
    configurePreset: debugPreset,
    compileCommands,
    // STM32CubeCLT 自带一份完整的 SVD 包，能对上型号就直接填进调试配置
    svdFile: findSvdFile(tools?.svdDir ?? null, device) ?? '',
    generator,
    includeDirs: project.includeDirs.length ? project.includeDirs : ['.'],
    defines: project.defines,
    cStandard: 'c11',
    cppStandard: 'c++17',
    // Live Watch 是「用户习惯」，从设置里带过来 —— 开一次之后新工程也默认开
    liveWatch: settings.liveWatch ?? false,
    liveWatchSamplesPerSecond: settings.liveWatchSamplesPerSecond ?? 4,
    liveWatchRefreshRate: settings.liveWatchRefreshRate ?? 300
  }
}

/** 修正 compileCommands：默认值要指向 compile_commands.json */
export function normalizeCompileCommands(options: GenOptions): string {
  const cc = options.compileCommands
  if (/compile_commands\.json$/i.test(cc)) return cc
  return `${options.debugDir}/compile_commands.json`
}

// --------------------------------------------------------------------------
// launch.json
// --------------------------------------------------------------------------

/**
 * 烧录任务的 label。
 *
 * 抽成函数是因为「launch.json 里的 preLaunchTask」必须**逐字**对上 tasks.json 里的 label，
 * 两边各写一遍字符串迟早会漂移。
 */
export function flashTaskLabel(kind: 'debug' | 'release'): string {
  return kind === 'debug' ? '烧录并运行 Debug 固件' : '烧录并运行 Release 固件'
}

/**
 * 构建任务的 label。和 flashTaskLabel 一样，抽出来是为了让
 * launch.json 里的 preLaunchTask 与 tasks.json 里的 label 能逐字对上。
 */
export function buildTaskLabel(kind: 'debug' | 'release'): string {
  return kind === 'debug' ? '构建 Debug' : '构建 Release'
}

/** 是不是「用 OpenOCD 命令行烧录」这一路 —— 决定有没有烧录任务可挂 */
function hasFlashTask(o: GenOptions, probe: ProbeOption): boolean {
  return probe.needsOpenocdCfg && Boolean(o.targetCfg)
}

function embeddedConfigs(project: ProjectInfo, o: GenOptions, probe: ProbeOption): LaunchConfig[] {
  const exe = ws(`${o.debugDir}/${o.elfName}.elf`)

  // 探针相关的公共字段
  const extra: Record<string, unknown> = {
    cwd: WS,
    executable: exe
  }
  if (o.device) extra.device = o.device
  if (probe.needsOpenocdCfg && o.targetCfg) {
    extra.configFiles = [ws(`.vscode/${openocdCfgFileName(o.targetCfg, probe.key)}`)]
  }
  if (probe.servertype === 'jlink') {
    extra.interface = 'SWD'
    extra.serverArgs = ['-speed', `${o.adapterSpeed}`]
  }
  if (o.svdFile.trim()) {
    extra.svdFile = /^[A-Za-z]:/.test(o.svdFile) ? toPosix(o.svdFile) : ws(o.svdFile)
  }
  if (o.toolchainDir) {
    extra.armToolchainPath = toPosix(o.toolchainDir)
  }

  /**
   * Live Watch —— 不停机看全局变量（类似 Keil 的 Live Watch）。
   *
   * 只对 openocd / stlink / jlink 三种 gdb-server 有效（cortex-debug 1.12 的
   * CHANGELOG 明确列了这三个；schema 描述里那句 "Only applies to OpenOCD" 是旧文案）。
   * PyOCD 不支持，所以这里按 servertype 过滤，别给不支持的探针塞一个没用的字段。
   *
   * 注意 samplesPerSecond 和界面刷新率是**两回事**：
   *   · samplesPerSecond   每秒采样几次，cortex-debug 限制 0~20
   *   · liveWatchRefreshRate（写在 settings.json 里）面板多久重画一次，默认 300ms
   * 采样快但刷新慢，看起来就是「值跳着变」——这是正常的。
   */
  if (o.liveWatch && ['openocd', 'stlink', 'jlink'].includes(probe.servertype)) {
    const sps = Math.max(0, Math.min(20, Math.round(o.liveWatchSamplesPerSecond ?? 4)))
    extra.liveWatch = { enabled: true, samplesPerSecond: sps }
  }

  // name / type / request 放最前面，生成出来的 JSON 更好读。
  // 返回类型写明确（而不是 Record<string, unknown>），这样和 extra 展开合并后
  // 仍然满足 LaunchConfig 的必填字段，不用到处 as unknown as。
  const head = (
    name: string
  ): Pick<LaunchConfig, 'name' | 'type' | 'request'> & { servertype: string } => ({
    name,
    type: 'cortex-debug',
    request: 'launch',
    servertype: probe.servertype
  })

  /**
   * 只保留一个调试配置。
   *
   * 这里一度还有一个「仅烧录（下载后不调试）」，想让它出现在「运行和调试」下拉里。
   * 试过 `noDebug: true` —— **实测 cortex-debug 会忽略它**：照样拉起完整调试会话、
   * 连上 GDB，把 CPU halt 住，结果是「固件烧进去了，但板子上的程序不跑」。
   *
   * 结论：**VSCode 的「运行和调试」只能放调试会话，烧录天然属于任务。**
   * 纯烧录请用任务「烧录并运行 Debug 固件」（它已是默认生成任务，Ctrl+Shift+B 直接跑，
   * 会先构建再烧、烧完 reset run）。
   *
   * 另外也去掉了「仅调试（不重新烧录）」：构建是增量的（Ninja 没改动就什么都不做），
   * 多烧一遍几乎不花时间，而「不烧录直接调试」很容易让你对着**旧固件**下断点还浑然不觉。
   */
  const configs: LaunchConfig[] = [
    {
      ...head('Debug: 烧录并调试（停在 main）'),
      ...extra,
      runToEntryPoint: 'main',
      preLaunchTask: buildTaskLabel('debug')
    }
  ]

  return configs
}

function nativeConfigs(project: ProjectInfo, o: GenOptions): LaunchConfig[] {
  const isMsvc = /cl(\.exe)?$/i.test(
    project.buildDirs.find((b) => b.cache?.cCompiler)?.cache?.cCompiler ?? ''
  )

  if (isMsvc) {
    return [
      {
        name: 'C/C++: 调试 Debug（MSVC）',
        type: 'cppvsdbg',
        request: 'launch',
        cwd: WS,
        program: ws(`${o.debugDir}/${o.elfName}.exe`),
        args: [],
        stopAtEntry: false,
        environment: [],
        console: 'integratedTerminal'
      }
    ]
  }

  const gdbPath = o.toolchainDir ? toPosix(`${o.toolchainDir}/arm-none-eabi-gdb.exe`) : ''

  return [
    {
      name: 'C/C++: 调试 Debug（gdb）',
      type: 'cppdbg',
      request: 'launch',
      cwd: WS,
      program: ws(`${o.debugDir}/${o.elfName}.exe`),
      args: [],
      stopAtEntry: false,
      externalConsole: false,
      MIMode: 'gdb',
      ...(gdbPath ? { miDebuggerPath: gdbPath } : {}),
      setupCommands: [
        { description: '为 gdb 启用整齐打印', text: '-enable-pretty-printing', ignoreFailures: true }
      ]
    }
  ]
}

function fallbackConfigs(project: ProjectInfo, o: GenOptions): LaunchConfig[] {
  // 既没有 .ioc 也没有可用工具链信息时的兜底：给一份能改的骨架
  return [
    {
      name: 'C/C++: 调试 Debug',
      type: 'cppdbg',
      request: 'launch',
      cwd: WS,
      program: ws(`${o.debugDir}/${o.elfName}.exe`),
      args: [],
      stopAtEntry: false,
      externalConsole: false,
      MIMode: 'gdb'
    }
  ]
}

export function generateLaunch(project: ProjectInfo, o: GenOptions): LaunchFile {
  const probe = probeByKey(o.probeKey)
  let configurations: LaunchConfig[]

  if (project.isEmbedded && o.device) {
    configurations = embeddedConfigs(project, o, probe)
  } else if (project.buildDirs.some((b) => b.cache?.cCompiler)) {
    configurations = nativeConfigs(project, o)
  } else {
    configurations = fallbackConfigs(project, o)
  }

  return { version: '0.2.0', configurations }
}

// --------------------------------------------------------------------------
// tasks.json
// --------------------------------------------------------------------------

export function generateTasks(project: ProjectInfo, o: GenOptions): TasksFile {
  const cmake = o.cmakeExe || 'cmake'
  const tasks: TaskDef[] = []

  // ---- 配置 ----
  if (project.presets.some((p) => !p.hidden)) {
    tasks.push({
      label: `配置 CMake（${o.debugPreset}）`,
      type: 'shell',
      command: cmake,
      args: ['--preset', o.debugPreset],
      options: { cwd: WS },
      problemMatcher: []
    })
  } else {
    const genArgs = ['-S', '.', '-B', o.debugDir]
    if (o.generator) genArgs.push('-G', o.generator)
    genArgs.push('-DCMAKE_BUILD_TYPE=Debug')
    tasks.push({
      label: '配置 CMake（Debug）',
      type: 'shell',
      command: cmake,
      args: genArgs,
      options: { cwd: WS },
      problemMatcher: []
    })
  }

  // ---- 构建 ----
  const buildArgs = (preset: string, dir: string): { args: string[]; usePreset: boolean } => {
    if (o.hasBuildPresets) return { args: ['--build', '--preset', preset], usePreset: true }
    return { args: ['--build', dir], usePreset: false }
  }

  const debugBuild = buildArgs(o.debugPreset, o.debugDir)
  tasks.push({
    label: buildTaskLabel('debug'),
    type: 'shell',
    command: cmake,
    args: debugBuild.args,
    options: { cwd: WS },
    // 注意：**默认生成任务不在这里**，而是给了下面的烧录任务 ——
    // 这样 Ctrl+Shift+B 一步到位「构建 + 烧录」，而编译不过时依赖链会自动停下、不会去烧。
    group: 'build',
    problemMatcher: ['$gcc']
  })

  const releaseBuild = buildArgs(o.releasePreset, o.releaseDir)
  tasks.push({
    label: buildTaskLabel('release'),
    type: 'shell',
    command: cmake,
    args: releaseBuild.args,
    options: { cwd: WS },
    group: 'build',
    problemMatcher: ['$gcc']
  })

  tasks.push({
    label: '清理 Debug',
    type: 'shell',
    command: cmake,
    args: ['--build', o.debugDir, '--target', 'clean'],
    options: { cwd: WS },
    problemMatcher: []
  })

  // ---- 烧录（仅在生成了 OpenOCD 接线配置时才产出）----
  const probe = probeByKey(o.probeKey)
  const needCfg = hasFlashTask(o, probe)
  const openocd = o.openocdExe ? toPosix(o.openocdExe) : 'openocd'

  if (needCfg) {
    const cfgRel = `.vscode/${openocdCfgFileName(o.targetCfg, probe.key)}`
    /**
     * 烧录任务。
     *
     * ⚠️ ELF 一律用 `${workspaceFolder}/...` 的**绝对形式**，不能写 `build/Debug/xxx.elf`
     * 这种相对路径。踩过的坑：任务里虽然写了 `options.cwd = ${workspaceFolder}`，
     * 但 VSCode 里它没按预期生效，于是 OpenOCD 按自己的进程目录去解析相对路径，
     * 报 `Error: couldn't open build/Debug/xxx.elf`、退出码 1，表现为
     * 「preLaunchTask 已终止，退出代码为 1」。同样位置的 `-f` 因为本来就是绝对路径，
     * 反而没事 —— 所以只看报错很容易误判成「探针连不上」。
     */
    /**
     * 烧录任务：**先依赖对应的构建任务**。
     *
     * 加这个依赖的代价几乎为零 —— Ninja 在源码没变时什么都不做，构建几十毫秒就回来了 ——
     * 但换来的是「永远不会把忘记构建的旧固件烧进去」。VSCode 的 `dependsOn` 默认走
     * `sequence` 顺序模式，**构建失败时后续任务不会执行**，所以编译不过也不会去烧。
     * （已知例外是 background 任务，见 microsoft/vscode#70283；我们的是普通 process 任务。）
     *
     * ⚠️ ELF 路径有两个坑，必须同时躲开，否则都会表现成
     * 「preLaunchTask 已终止，退出代码为 1」，极难定位：
     *
     *   坑一 · 相对路径不行。`program build/Debug/x.elf` 要靠进程的工作目录解析，
     *          而任务里的 `options.cwd = ${workspaceFolder}` 在 VSCode 里并不总能生效。
     *          → 必须用 `${workspaceFolder}/...` 的绝对形式。
     *
     *   坑二 · 绝对路径会被 Tcl 吃掉反斜杠。`${workspaceFolder}` 展开出来是 Windows
     *          反斜杠路径，而 `program` 是 **Tcl 命令**，`\U` `\P` `\R` `\T` 会被当成
     *          Tcl 转义序列，于是路径变成 `C:UserssomeoneDesktopproj<TAB>est-01/...`，
     *          OpenOCD 报 `Error: couldn't open ...`。
     *          （同一条命令里的 `-f` 反而没事 —— 它由 OpenOCD 的 C++ 参数解析器处理，不走 Tcl。）
     *          → 用 **Tcl 花括号** 把路径包起来，花括号内不做任何替换。
     *
     * 实测量过：裸路径退出码 1；加花括号后 `** Verified OK **`、退出码 0。
     */
    const flash = (
      label: string,
      dir: string,
      elf: string,
      buildDep: string,
      isDefault = false
    ): TaskDef => ({
      label,
      type: 'process',
      command: o.openocdExe ? o.openocdExe : 'openocd',
      args: ['-f', ws(cfgRel), '-c', `program {${ws(`${dir}/${elf}.elf`)}} verify reset exit`],
      options: { cwd: WS },
      // Debug 那条是**默认生成任务** → Ctrl+Shift+B 一步「构建 + 烧录」
      group: isDefault ? { kind: 'build', isDefault: true } : 'build',
      dependsOn: [buildDep],
      problemMatcher: []
    })

    tasks.push(flash(flashTaskLabel('debug'), o.debugDir, o.elfName, buildTaskLabel('debug'), true))
    tasks.push(flash(flashTaskLabel('release'), o.releaseDir, o.elfName, buildTaskLabel('release')))

    tasks.push({
      label: '擦除芯片（OpenOCD）',
      type: 'process',
      command: o.openocdExe ? o.openocdExe : 'openocd',
      args: ['-f', ws(cfgRel), '-c', 'init; reset halt; flash erase_sector 0 0 last; reset run; exit'],
      options: { cwd: WS },
      problemMatcher: []
    })
  }

  return { version: '2.0.0', tasks }
}

// --------------------------------------------------------------------------
// settings.json
// --------------------------------------------------------------------------

export function generateSettings(project: ProjectInfo, o: GenOptions): SettingsFile {
  const settings: SettingsFile = {}

  if (o.openocdExe) {
    settings['cortex-debug.openocdPath.windows'] = toPosix(o.openocdExe)
    settings['cortex-debug.openocdPath'] = toPosix(o.openocdExe)
  }
  if (o.toolchainDir) {
    settings['cortex-debug.armToolchainPath.windows'] = toPosix(o.toolchainDir)
    settings['cortex-debug.armToolchainPath'] = toPosix(o.toolchainDir)
  }
  // Live Watch 面板的重画频率（毫秒）。这是**用户/工作区设置**，不在 launch.json 里。
  // cortex-debug 官方要求别低于 250ms，否则 VSCode 的 UI 跟不上、看着像卡死。
  if (o.liveWatch) {
    const rate = Math.max(100, Math.min(5000, Math.round(o.liveWatchRefreshRate ?? 300)))
    settings['cortex-debug.liveWatchRefreshRate'] = rate
  }

  settings['cmake.configureOnOpen'] = false
  if (o.generator) settings['cmake.generator'] = o.generator
  settings['cmake.buildDirectory'] = `${WS}/build/\${buildType}`

  settings['C_Cpp.default.compileCommands'] = ws(normalizeCompileCommands(o))
  settings['clangd.arguments'] = [`--compile-commands-dir=${WS}/${toPosix(o.debugDir)}`]

  if (project.isEmbedded) {
    settings['files.associations'] = { '*.h': 'c' }
  }
  settings['files.exclude'] = {
    '**/.git': true,
    '**/.svn': true,
    '**/.DS_Store': true
  }

  return settings
}

// --------------------------------------------------------------------------
// c_cpp_properties.json
// --------------------------------------------------------------------------

export function generateCppProperties(project: ProjectInfo, o: GenOptions): CppPropertiesFile {
  const intelliSenseMode = project.isEmbedded ? 'windows-gcc-arm' : 'windows-gcc-x64'

  const includePath = [
    `${WS}/**`,
    ...o.includeDirs.filter(Boolean).map((d) => (/^[A-Za-z]:/.test(d) ? toPosix(d) : ws(d)))
  ]

  const config: CppConfiguration = {
    name: project.isEmbedded ? 'STM32' : 'CMake',
    compileCommands: ws(normalizeCompileCommands(o)),
    includePath,
    defines: o.defines,
    cStandard: o.cStandard,
    cppStandard: o.cppStandard,
    intelliSenseMode
  }

  return { version: 4, configurations: [config] }
}

// --------------------------------------------------------------------------
// openocd-*.cfg
// --------------------------------------------------------------------------

export function generateOpenocdCfg(
  o: GenOptions,
  probe: ProbeOption
): { fileName: string; content: string } | null {
  if (!probe.needsOpenocdCfg || !o.targetCfg) return null

  const lines = [
    '# 由 CMake / VSCode 工程配置器生成',
    `# 探针: ${probe.label}`,
    `# 目标: ${o.device || '未识别'}`,
    '',
    `source [find ${probe.interfaceCfg || 'interface/cmsis-dap.cfg'}]`,
    `source [find target/${o.targetCfg}]`
  ]

  if (o.adapterSpeed > 0) lines.push(`adapter speed ${o.adapterSpeed}`)
  if (o.resetConfig) lines.push(o.resetConfig)
  lines.push('')

  return {
    fileName: openocdCfgFileName(o.targetCfg, probe.key),
    content: lines.join('\n')
  }
}

// --------------------------------------------------------------------------
// 汇总
// --------------------------------------------------------------------------

export function generateBundle(project: ProjectInfo, o: GenOptions): ConfigBundle {
  const probe = probeByKey(o.probeKey)
  return {
    launch: generateLaunch(project, o),
    tasks: generateTasks(project, o),
    settings: generateSettings(project, o),
    cpp: generateCppProperties(project, o),
    openocdCfg: generateOpenocdCfg(o, probe)
  }
}

/** 把 bundle 摊平成「相对路径 → 文本内容」的待写文件清单 */
export function bundleToFiles(
  bundle: ConfigBundle,
  stringify: (v: unknown) => string
): Array<{ name: string; relativePath: string; content: string }> {
  const files = [
    { name: 'launch.json', relativePath: '.vscode/launch.json', content: stringify(bundle.launch) },
    { name: 'tasks.json', relativePath: '.vscode/tasks.json', content: stringify(bundle.tasks) },
    {
      name: 'settings.json',
      relativePath: '.vscode/settings.json',
      content: stringify(bundle.settings)
    },
    {
      name: 'c_cpp_properties.json',
      relativePath: '.vscode/c_cpp_properties.json',
      content: stringify(bundle.cpp)
    }
  ]

  if (bundle.openocdCfg) {
    files.push({
      name: bundle.openocdCfg.fileName,
      relativePath: `.vscode/${bundle.openocdCfg.fileName}`,
      content: bundle.openocdCfg.content
    })
  }

  return files
}

export { basename }
