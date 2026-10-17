/**
 * 主进程服务的端到端自检（不依赖 Electron）。
 *
 * 覆盖：
 *   1. 工具探测（含环境变量优先级）
 *   2. 在真实 STM32 工程上做只读检测
 *   3. 在一个合成的 STM32 工程上跑完整流程：检测 → 生成 → 预览 → 写入 → 校验
 *   4. 固件名以 CMake 声明为准（陈旧构建产物的回归）
 *   5. 快照与还原
 *   6. VSCode 工程发现
 *   7. 用生成的 OpenOCD 接线配置真的启动一次 openocd
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { defaultGenOptions, generateBundle } from '../src/main/services/generators'
import { scanProject } from '../src/main/services/scanner'
import {
  buildCmakeModel,
  buildProjectBuildModel,
  collectReferencedPaths
} from '../src/main/services/cmakeModel'
import { planSourceEdit } from '../src/main/services/cmakeEdit'
import { findOrphanNotes, scanSources, renderNewFile } from '../src/main/services/sourceScanner'
import {
  applyProjectRename,
  planProjectRename,
  sameName as sameProjectName
} from '../src/main/services/projectRename'
import { inspectVscodeOwnership } from '../src/main/services/vscodeOwnership'
import { detectTools, findSvdFile } from '../src/main/services/toolDetector'
import { planFiles, writeFiles } from '../src/main/services/writer'
import {
  captureSnapshot,
  configureSnapshots,
  listSnapshots,
  restoreSnapshot
} from '../src/main/services/snapshotStore'
import { discoverProjects, getRecentProjects, parseFileUri } from '../src/main/services/workspaceFinder'
import { BUILTIN_TEMPLATES, isBuiltinTemplateId } from '../src/shared/builtinTemplates'
import {
  findUnresolvedVariables,
  renderTemplateFiles,
  renderTemplateText
} from '../src/shared/templateRender'
import { buildTemplateSkeleton } from '../src/shared/templateSkeleton'
import { TEMPLATE_FILE_KEYS } from '../src/shared/types'
import { adaptTemplateOptions } from '../src/shared/templateAdapt'
import {
  checkPackCompat,
  inspectProject,
  listPacks,
  loadPack,
  readPackFile,
  scanPidStructs
} from '../src/main/services/packStore'
import {
  applyPackInstall,
  planPackInstall,
  renderBind,
  renderConfig
} from '../src/main/services/packInstaller'

let failures = 0
let checks = 0

function check(name: string, condition: boolean, detail = ''): void {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? `  —— ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

// ==========================================================================
// 1. 工具探测
// ==========================================================================

section('1. 工具探测')

const settings: AppSettings = { ...DEFAULT_SETTINGS }
const tools = detectTools(settings.tools, false)

console.log('  查找顺序: 手动指定 → 环境变量 → 系统 PATH → 常见安装位置\n')
for (const [key, item] of Object.entries(tools.items)) {
  console.log(
    `  ${key.padEnd(10)} ${item.found ? '✓' : '·'} ${item.path ?? '(未找到)'}  [${item.source}]`
  )
}
console.log(`\n  环境变量安装根:`)
if (!tools.envRoots.length) {
  console.log('    （未检测到）')
} else {
  for (const root of tools.envRoots) {
    console.log(`    ${root.name.padEnd(22)} ${root.exists ? '✓' : '✗ 路径不存在'}  ${root.value}`)
  }
}
console.log(`  OpenOCD scripts: ${tools.openocdScripts ?? '(未找到)'}`)
console.log(`  SVD 目录       : ${tools.svdDir ?? '(未找到)'}`)

check('探测到 OpenOCD', tools.items.openocd.found, tools.items.openocd.path ?? '')
check('探测到 CMake', tools.items.cmake.found)
check('定位到 OpenOCD scripts 目录', tools.openocdScripts !== null)

// ---- 环境变量优先：只有确实存在这些变量时才断言，换台机器不会误报 ----
if (process.env.STM32CLT_PATH) {
  check(
    '识别到环境变量 STM32CLT_PATH',
    tools.envRoots.some((r) => r.name === 'STM32CLT_PATH' && r.exists),
    JSON.stringify(tools.envRoots)
  )
  check(
    'CMake 来自环境变量而非 PATH',
    tools.items.cmake.source === '环境变量 STM32CLT_PATH',
    tools.items.cmake.source
  )
  check(
    'Ninja 来自环境变量而非 PATH',
    tools.items.ninja.source === '环境变量 STM32CLT_PATH',
    tools.items.ninja.source
  )
  check(
    'arm-none-eabi-gcc 来自环境变量而非 PATH',
    tools.items.arm_gcc.source === '环境变量 STM32CLT_PATH',
    tools.items.arm_gcc.source
  )
  check(
    'arm-none-eabi-gdb 来自环境变量',
    tools.items.arm_gdb.source.startsWith('环境变量'),
    tools.items.arm_gdb.source
  )
  check('CubeCLT 自带的 SVD 目录被识别', tools.svdDir !== null, tools.svdDir ?? '')

  const svd = findSvdFile(tools.svdDir, 'STM32F103C8T6')
  check('能为 STM32F103C8T6 找到 SVD 文件', svd !== null, svd ?? '')
  if (svd) console.log(`    → SVD: ${svd}`)
  check('无法识别的型号返回 null', findSvdFile(tools.svdDir, 'GD32F103') === null)
}

// ---- 手动指定必须压过环境变量 ----
const overridden = detectTools({ cmake: tools.items.cmake.path ?? '' }, false)
check(
  '手动指定优先于环境变量',
  overridden.items.cmake.source === '手动指定',
  overridden.items.cmake.source
)

// ==========================================================================
// 2. 真实工程只读检测
// ==========================================================================

section('2. 真实工程检测（只读）')

/**
 * 真实工程只读检测用的路径。
 *
 * **故意不写死任何本机路径** —— 这是公开仓库，塞个人目录既没意义也泄露信息。
 * 想跑这一段就自己给环境变量（分号分隔），不给就整段跳过：
 *
 *   $env:CFGSTUDIO_TEST_PROJECTS = 'D:\work\firmware-a;D:\work\firmware-b'
 */
const REAL_PROJECTS = (process.env.CFGSTUDIO_TEST_PROJECTS ?? '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)

if (REAL_PROJECTS.length === 0) {
  console.log('  · 没有设置 CFGSTUDIO_TEST_PROJECTS，跳过真实工程检测')
}

let realScanned = 0
for (const root of REAL_PROJECTS) {
  let info
  try {
    info = scanProject(root)
  } catch (err) {
    console.log(`  · 跳过（不存在）: ${root}`)
    continue
  }
  realScanned += 1

  console.log(`\n  --- ${info.name} ---`)
  console.log(`    芯片      : ${info.device ?? '—'}  (family=${info.ioc?.family ?? '—'})`)
  console.log(`    ELF 名    : ${info.elfName}  ← ${info.elfSource}`)
  console.log(`    目标      : ${info.targets.map((t) => `${t.name}[${t.kind}]`).join(', ') || '—'}`)
  console.log(
    `    presets   : ${info.presets.map((p) => `${p.name}${p.hidden ? '(hidden)' : ''}`).join(', ') || '—'}`
  )
  console.log(
    `    build 目录: ${info.buildDirs.map((b) => `${b.name}${b.configured ? '✓' : '✗'}`).join(', ') || '—'}`
  )
  console.log(`    include   : ${info.includeDirs.join(', ') || '—'}`)

  check(`${info.name}: 识别出芯片`, Boolean(info.device), info.device ?? '')
  check(`${info.name}: 识别出 ELF 名`, info.elfName.length > 0, info.elfName)
  check(`${info.name}: 定位到工程根`, info.root.toLowerCase() === root.toLowerCase())
}

// 只有真的配了工程才断言 —— 没配环境变量时整段跳过，
// 不能因为「没给路径」就报失败，那是使用者的选择，不是代码的问题。
if (REAL_PROJECTS.length > 0) {
  check('至少检测到一个真实工程', realScanned > 0, `实际 ${realScanned} 个`)
}

// ==========================================================================
// 3. 合成工程完整流程
// ==========================================================================

section('3. 合成 STM32 工程：检测 → 生成 → 写入 → 校验')

const sandbox = join(tmpdir(), 'cfgstudio-selftest')
rmSync(sandbox, { recursive: true, force: true })
const demo = join(sandbox, 'demo')
mkdirSync(join(demo, 'build', 'Debug'), { recursive: true })
mkdirSync(join(demo, 'build', 'Release'), { recursive: true })
mkdirSync(join(demo, 'Core', 'Inc'), { recursive: true })
mkdirSync(join(demo, 'cmake'), { recursive: true })

writeFileSync(
  join(demo, 'CMakeLists.txt'),
  `cmake_minimum_required(VERSION 3.22)

set(CMAKE_C_STANDARD 11)
set(CMAKE_PROJECT_NAME demo)
set(CMAKE_EXPORT_COMPILE_COMMANDS TRUE)

project(\${CMAKE_PROJECT_NAME})

add_executable(\${CMAKE_PROJECT_NAME})

target_include_directories(\${CMAKE_PROJECT_NAME} PRIVATE
    Core/Inc
    \${CMAKE_CURRENT_SOURCE_DIR}/application
)

target_compile_definitions(\${CMAKE_PROJECT_NAME} PRIVATE
    STM32F103xB
    USE_HAL_DRIVER
)
`,
  'utf8'
)

writeFileSync(
  join(demo, 'CMakePresets.json'),
  JSON.stringify(
    {
      version: 3,
      configurePresets: [
        {
          name: 'default',
          hidden: true,
          generator: 'Ninja',
          binaryDir: '${sourceDir}/build/${presetName}',
          toolchainFile: '${sourceDir}/cmake/gcc-arm-none-eabi.cmake',
          cacheVariables: {}
        },
        { name: 'Debug', inherits: 'default', cacheVariables: { CMAKE_BUILD_TYPE: 'Debug' } },
        { name: 'Release', inherits: 'default', cacheVariables: { CMAKE_BUILD_TYPE: 'Release' } }
      ],
      buildPresets: [
        { name: 'Debug', configurePreset: 'Debug' },
        { name: 'Release', configurePreset: 'Release' }
      ]
    },
    null,
    4
  ),
  'utf8'
)

writeFileSync(
  join(demo, 'demo.ioc'),
  [
    'Mcu.CPN=STM32F103C8T6',
    'Mcu.Family=STM32F1',
    'Mcu.Name=STM32F103C(8-B)Tx',
    'Mcu.Package=LQFP48',
    'ProjectManager.ProjectName=demo',
    ''
  ].join('\n'),
  'utf8'
)

writeFileSync(join(demo, 'cmake', 'gcc-arm-none-eabi.cmake'), '# toolchain\n', 'utf8')

for (const variant of ['Debug', 'Release']) {
  writeFileSync(
    join(demo, 'build', variant, 'CMakeCache.txt'),
    [
      '# synthetic',
      `CMAKE_BUILD_TYPE:STRING=${variant}`,
      'CMAKE_GENERATOR:INTERNAL=Ninja',
      'CMAKE_C_COMPILER:FILEPATH=C:/ST/GNU-tools-for-STM32/bin/arm-none-eabi-gcc.exe',
      'CMAKE_MAKE_PROGRAM:FILEPATH=C:/ST/Ninja/ninja.exe',
      'CMAKE_TOOLCHAIN_FILE:FILEPATH=' +
        join(demo, 'cmake', 'gcc-arm-none-eabi.cmake').replace(/\\/g, '/'),
      'CMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON',
      'CMAKE_PROJECT_NAME:STATIC=demo',
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(join(demo, 'build', variant, 'build.ninja'), '# ninja\n', 'utf8')
  writeFileSync(join(demo, 'build', variant, 'compile_commands.json'), '[]\n', 'utf8')
  writeFileSync(join(demo, 'build', variant, 'demo.elf'), 'ELF', 'utf8')
}

// ---- 检测 ----
const project = scanProject(demo)
check('合成工程：识别芯片 STM32F103C8T6', project.device === 'STM32F103C8T6', project.device ?? '')
check('合成工程：ELF 名为 demo', project.elfName === 'demo', project.elfName)
check(
  '合成工程：解析出 1 个可执行目标',
  project.targets.length === 1 && project.targets[0].kind === 'executable'
)
check(
  '合成工程：preset 的 inherits 已展开（Debug 有 generator）',
  project.presets.find((p) => p.name === 'Debug')?.generator === 'Ninja'
)
check(
  '合成工程：binaryDir 变量已展开为绝对路径',
  Boolean(project.presets.find((p) => p.name === 'Debug')?.binaryDir?.includes('build'))
)
check(
  '合成工程：解析出 include 目录 Core/Inc',
  project.includeDirs.includes('Core/Inc'),
  project.includeDirs.join(',')
)
check(
  '合成工程：支持 ${CMAKE_CURRENT_SOURCE_DIR}/... 形式的 include',
  project.includeDirs.includes('application'),
  project.includeDirs.join(',')
)
check(
  '合成工程：解析出编译宏 STM32F103xB',
  project.defines.includes('STM32F103xB'),
  project.defines.join(',')
)
check('合成工程：找到 2 个构建目录', project.buildDirs.length === 2, String(project.buildDirs.length))
check('合成工程：判为嵌入式工程', project.isEmbedded)

// ---- 生成 ----
const options = defaultGenOptions(project, tools, settings)
console.log(
  `\n  生成参数: probe=${options.probeKey} target=${options.targetCfg} elf=${options.elfName}`
)
console.log(
  `            debugDir=${options.debugDir} preset=${options.debugPreset} hasBuildPresets=${options.hasBuildPresets}`
)

check('默认 target 映射为 stm32f1x.cfg', options.targetCfg === 'stm32f1x.cfg', options.targetCfg)
check(
  '默认 debugDir 为 build/Debug',
  options.debugDir.replace(/\\/g, '/') === 'build/Debug',
  options.debugDir
)
check('识别出 buildPresets', options.hasBuildPresets)

const bundle = generateBundle(project, options)

check(
  '只生成 1 个调试配置（纯烧录交给任务，不冒充调试会话）',
  bundle.launch.configurations.length === 1,
  bundle.launch.configurations.map((c) => c.name).join(' | ')
)
check(
  '不再生成「仅调试（不重新烧录）」—— 容易对着旧固件下断点',
  !bundle.launch.configurations.some((c) => c.name.includes('仅调试')),
  bundle.launch.configurations.map((c) => c.name).join(' | ')
)
/**
 * 曾经想用 `noDebug: true` 让「仅烧录」出现在「运行和调试」下拉里。
 * 实测 **cortex-debug 会忽略 noDebug** —— 照样拉起调试会话、把 CPU halt 住，
 * 结果是「固件烧进去了但板子不跑」。所以那个配置被彻底删掉了，这里钉死不许回来。
 */
check(
  '调试配置里不再出现靠 noDebug 冒充「仅烧录」的项',
  !bundle.launch.configurations.some((c) => c.noDebug === true),
  bundle.launch.configurations.map((c) => `${c.name}:noDebug=${String(c.noDebug)}`).join(' | ')
)
check(
  '「烧录并调试」的 preLaunchTask 是构建任务（先构建再烧）',
  bundle.launch.configurations[0].preLaunchTask === '构建 Debug',
  String(bundle.launch.configurations[0].preLaunchTask)
)
check(
  '调试配置类型为 cortex-debug',
  bundle.launch.configurations.every((c) => c.type === 'cortex-debug')
)
check(
  '调试配置的 executable 指向 build/Debug/demo.elf',
  String(bundle.launch.configurations[0].executable).endsWith('build/Debug/demo.elf'),
  String(bundle.launch.configurations[0].executable)
)
check('调试配置的 device 为 STM32F103C8T6', bundle.launch.configurations[0].device === 'STM32F103C8T6')

/**
 * 纯烧录走任务，而且**默认生成任务就是它** ——
 * Ctrl+Shift+B 一步「构建 + 烧录」，编译不过时依赖链自动停下不会去烧。
 */
const defaultBuildTask = bundle.tasks.tasks.find(
  (t) => typeof t.group === 'object' && (t.group as { isDefault?: boolean }).isDefault === true
)
check(
  '默认生成任务是「烧录并运行 Debug 固件」',
  defaultBuildTask?.label === '烧录并运行 Debug 固件',
  String(defaultBuildTask?.label)
)
check(
  '默认生成任务带 dependsOn 构建（保证先编译）',
  (defaultBuildTask?.dependsOn ?? []).includes('构建 Debug'),
  JSON.stringify(defaultBuildTask?.dependsOn ?? [])
)

check('生成了 openocd 接线配置', bundle.openocdCfg !== null)
check(
  '接线配置文件名正确',
  bundle.openocdCfg?.fileName === 'openocd-stm32f1x-cmsis-dap.cfg',
  bundle.openocdCfg?.fileName ?? ''
)
check(
  '接线配置内容含 interface 与 target',
  Boolean(
    bundle.openocdCfg?.content.includes('source [find interface/cmsis-dap.cfg]') &&
    bundle.openocdCfg?.content.includes('source [find target/stm32f1x.cfg]')
  )
)
check(
  '调试配置引用生成的接线配置文件',
  JSON.stringify(bundle.launch.configurations[0].configFiles ?? []).includes(
    bundle.openocdCfg?.fileName ?? '@@'
  )
)

const defaultBuildTasks = bundle.tasks.tasks.filter(
  (t) =>
    typeof t.group === 'object' && t.group !== null && (t.group as { isDefault?: boolean }).isDefault
)
check('恰好 1 个默认构建任务', defaultBuildTasks.length === 1, String(defaultBuildTasks.length))
check(
  '「构建 Debug」任务本身用 --preset Debug',
  JSON.stringify(bundle.tasks.tasks.find((t) => t.label === '构建 Debug')?.args ?? []) ===
    JSON.stringify(['--build', '--preset', 'Debug']),
  JSON.stringify(bundle.tasks.tasks.find((t) => t.label === '构建 Debug')?.args)
)

const flashTasks = bundle.tasks.tasks.filter((t) => t.label.startsWith('烧录并运行'))
check('生成 2 个烧录任务', flashTasks.length === 2, String(flashTasks.length))
check(
  '烧录任务调用 OpenOCD 并指向接线配置',
  flashTasks.every(
    (t) =>
      t.type === 'process' && JSON.stringify(t.args ?? []).includes(bundle.openocdCfg?.fileName ?? '@@')
  )
)

/**
 * 回归：烧录任务里的 ELF 路径必须**同时**满足两条，缺一条都会让烧录失败，
 * 而且两种失败在界面上长得一模一样（「preLaunchTask 已终止，退出代码为 1」）：
 *
 *   ① 必须用 `${workspaceFolder}/...` 绝对形式 —— 相对路径靠进程工作目录解析，
 *      而任务里的 `options.cwd` 在 VSCode 里并不总能生效。
 *   ② 必须用 **Tcl 花括号** 包起来 —— `${workspaceFolder}` 展开是 Windows 反斜杠路径，
 *      而 `program` 是 Tcl 命令，`\U` `\P` `\R` `\T` 会被当成 Tcl 转义序列吃掉，
 *      OpenOCD 于是报 `Error: couldn't open C:UserssomeoneDesktop...`。
 *      （同一条命令的 `-f` 不受影响，它走 OpenOCD 的 C++ 参数解析器。）
 *
 * 实测量过：裸路径退出码 1；加花括号后 `** Verified OK **`、退出码 0。
 */
check(
  '烧录任务的 ELF 用 ${workspaceFolder} 绝对路径 + Tcl 花括号',
  flashTasks.every((t) => (t.args ?? []).some((a) => /program\s+\{\$\{workspaceFolder\}\//.test(a))),
  flashTasks.map((t) => (t.args ?? []).join(' ')).join(' | ')
)
check(
  '烧录任务里没有未加花括号的 program 目标（防止 Tcl 吃反斜杠）',
  flashTasks.every((t) => !(t.args ?? []).some((a) => /program\s+(?!\{)/.test(a))),
  flashTasks.map((t) => (t.args ?? []).join(' ')).join(' | ')
)
check(
  '烧录任务里没有裸相对路径的 program 目标（防止依赖 cwd）',
  flashTasks.every((t) => !(t.args ?? []).some((a) => /program\s+\{(?!\$\{workspaceFolder\})/.test(a))),
  flashTasks.map((t) => (t.args ?? []).join(' ')).join(' | ')
)

/**
 * 回归：烧录任务必须**先构建**。
 *
 * VSCode 的 dependsOn 默认是 sequence 顺序模式，依赖失败时后续任务不执行 ——
 * 所以编译不过时不会去烧旧固件。Ninja 在源码没变时什么都不做，这个依赖几乎不花时间。
 */
check(
  'Debug 烧录任务依赖「构建 Debug」',
  (flashTasks.find((t) => t.label.includes('Debug'))?.dependsOn ?? []).includes('构建 Debug'),
  JSON.stringify(flashTasks.find((t) => t.label.includes('Debug'))?.dependsOn ?? [])
)
check(
  'Release 烧录任务依赖「构建 Release」',
  (flashTasks.find((t) => t.label.includes('Release'))?.dependsOn ?? []).includes('构建 Release'),
  JSON.stringify(flashTasks.find((t) => t.label.includes('Release'))?.dependsOn ?? [])
)
check(
  'dependsOn 指向的构建任务确实存在（否则 VSCode 会报找不到任务）',
  (() => {
    const labels = new Set(bundle.tasks.tasks.map((t) => t.label))
    return flashTasks.every((t) => (t.dependsOn ?? []).every((d) => labels.has(d)))
  })(),
  flashTasks.map((t) => (t.dependsOn ?? []).join(',')).join(' | ')
)

check(
  'settings.json 含 cortex-debug.openocdPath.windows',
  typeof bundle.settings['cortex-debug.openocdPath.windows'] === 'string'
)
check(
  'settings.json 的路径用正斜杠',
  !String(bundle.settings['cortex-debug.openocdPath.windows'] ?? '').includes('\\')
)
check(
  'c_cpp_properties 指向 compile_commands.json',
  String(bundle.cpp.configurations[0].compileCommands).endsWith('compile_commands.json'),
  String(bundle.cpp.configurations[0].compileCommands)
)
check(
  'c_cpp_properties 含 Core/Inc',
  (bundle.cpp.configurations[0].includePath ?? []).some((p) => p.includes('Core/Inc'))
)

// ---- 预览 + 写入 ----
const stringify = (v: unknown): string => JSON.stringify(v, null, 4) + '\n'
const files = [
  { name: 'launch.json', relativePath: '.vscode/launch.json', content: stringify(bundle.launch) },
  { name: 'tasks.json', relativePath: '.vscode/tasks.json', content: stringify(bundle.tasks) },
  { name: 'settings.json', relativePath: '.vscode/settings.json', content: stringify(bundle.settings) },
  {
    name: 'c_cpp_properties.json',
    relativePath: '.vscode/c_cpp_properties.json',
    content: stringify(bundle.cpp)
  },
  ...(bundle.openocdCfg
    ? [
        {
          name: bundle.openocdCfg.fileName,
          relativePath: `.vscode/${bundle.openocdCfg.fileName}`,
          content: bundle.openocdCfg.content
        }
      ]
    : [])
]

const planned = planFiles({ projectRoot: demo, files })
check('预览得到 5 个待写文件', planned.length === 5, String(planned.length))
check(
  '预览显示这些文件原本都不存在',
  planned.every((p) => !p.exists)
)

const written = writeFiles({ projectRoot: demo, files, backup: false })
check('写入无错误', written.errors.length === 0, written.errors.join('; '))
check('写入 5 个文件', written.written.length === 5, String(written.written.length))

// ---- 校验落盘内容 ----
const launchOnDisk = JSON.parse(readFileSync(join(demo, '.vscode', 'launch.json'), 'utf8'))
check(
  '落盘的 launch.json 能解析且含 1 个配置',
  launchOnDisk.configurations.length === 1,
  String(launchOnDisk.configurations.length)
)

const settingsOnDisk = JSON.parse(readFileSync(join(demo, '.vscode', 'settings.json'), 'utf8'))
check(
  '落盘的 settings.json 含 openocd 路径',
  Boolean(settingsOnDisk['cortex-debug.openocdPath.windows'])
)

const cfgOnDisk = readFileSync(join(demo, '.vscode', 'openocd-stm32f1x-cmsis-dap.cfg'), 'utf8')
check('落盘的 OpenOCD 配置含 target/stm32f1x.cfg', cfgOnDisk.includes('target/stm32f1x.cfg'))

// ---- 幂等性 ----
const again = writeFiles({ projectRoot: demo, files, backup: false })
check(
  '重复写入是幂等的（0 个文件被改动）',
  again.written.length === 0,
  `改动了 ${again.written.length} 个`
)
check('重复写入识别为内容相同', again.unchanged.length === 5, String(again.unchanged.length))

// ---- 备份 ----
const changedFiles = files.map((f) =>
  f.name === 'settings.json'
    ? { ...f, content: f.content.replace('cortex-debug', 'x-cortex-debug') }
    : f
)
const withBackup = writeFiles({ projectRoot: demo, files: changedFiles, backup: true })
check('开启备份后产生了备份文件', withBackup.backups.length === 1, String(withBackup.backups.length))
check('备份目录位于 .vscode/.backup 下', Boolean(withBackup.backupDir?.includes('.backup')))

// ---- 路径越界防护 ----
const evil = writeFiles({
  projectRoot: demo,
  files: [{ name: 'evil.txt', relativePath: '../../evil.txt', content: 'x' }],
  backup: false
})
check('拒绝越界写入', evil.errors.length === 1 && evil.written.length === 0, evil.errors.join('; '))

// ---- 重新检测：应能读到刚写入的文件 ----
const after = scanProject(demo)
check(
  '重新检测读到了 launch.json 与 tasks.json',
  after.vscodeFiles['launch.json'].exists && after.vscodeFiles['tasks.json'].exists
)
check(
  '重新检测识别出 1 个调试配置',
  after.vscodeFiles['launch.json'].note.includes('1'),
  after.vscodeFiles['launch.json'].note
)
check('重新检测发现 1 个 openocd 接线配置', after.openocdCfgFiles.length === 1)

// ==========================================================================
// 4. 回归：陈旧构建产物不能覆盖 CMake 声明的固件名
// ==========================================================================

section('4. 固件名以 CMake 声明为准（陈旧产物不能覆盖它）')

// 真实踩过的坑：工程从 legacy-name 改名成 test-01 之后，build/Debug 里
// 同时留着 legacy-name.elf（旧）和 test-01.elf（新）。旧逻辑取排序第一个，
// 于是生成的 launch.json 指向早就过期的 legacy-name.elf。
writeFileSync(join(demo, 'build', 'Debug', 'stale_old_name.elf'), 'OLD', 'utf8')

const rescanned = scanProject(demo)
check('固件名仍是 CMake 声明的 demo', rescanned.elfName === 'demo', rescanned.elfName)
check(
  '固件名来源标记为 declared',
  rescanned.elfNameConfidence === 'declared',
  rescanned.elfNameConfidence
)
check(
  '对不一致的旧产物给出了警告',
  rescanned.warnings.some((w) => w.includes('stale_old_name')),
  rescanned.warnings.join(' | ')
)

// 反过来：CMake 里根本没有可用的目标名时，才允许用实际产物补正
const noTarget = join(sandbox, 'no-target')
mkdirSync(join(noTarget, 'build', 'Debug'), { recursive: true })
writeFileSync(join(noTarget, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n', 'utf8')
writeFileSync(
  join(noTarget, 'build', 'Debug', 'CMakeCache.txt'),
  'CMAKE_BUILD_TYPE:STRING=Debug\n',
  'utf8'
)
writeFileSync(join(noTarget, 'build', 'Debug', 'real_name.elf'), 'ELF', 'utf8')

const guessed = scanProject(noTarget)
check('没有 CMake 目标名时，改用实际产物补正', guessed.elfName === 'real_name', guessed.elfName)

// compile_commands 必须指向 compile_commands.json，而不是 .elf
const opts = defaultGenOptions(scanProject(demo), tools, settings)
check(
  'compileCommands 指向 compile_commands.json',
  opts.compileCommands.endsWith('compile_commands.json'),
  opts.compileCommands
)

// ==========================================================================
// 5. 快照与还原
// ==========================================================================

section('5. 快照与还原')

configureSnapshots(join(sandbox, 'snapshots'))

const snapDemo = join(sandbox, 'snap-demo')
mkdirSync(join(snapDemo, '.vscode'), { recursive: true })
const userLaunch = '{\n    "version": "0.2.0",\n    "configurations": []\n}\n'
const userSettings = '{\n    "my.own.setting": true\n}\n'
writeFileSync(join(snapDemo, '.vscode', 'launch.json'), userLaunch, 'utf8')
writeFileSync(join(snapDemo, '.vscode', 'settings.json'), userSettings, 'utf8')

const snapPlanned = planFiles({ projectRoot: snapDemo, files })
const snapChanged = snapPlanned
  .filter((f) => f.previous !== f.content)
  .map((f) => ({ relativePath: f.relativePath, previous: f.previous }))

const snapId = captureSnapshot(snapDemo, snapChanged)
const snapMeta = listSnapshots(snapDemo)[0]
check('写入前产生了快照', snapId !== null, String(snapId))
check('快照里记录了 5 个待改文件', snapMeta?.fileCount === 5, String(snapMeta?.fileCount))
check('快照里 3 个是「写入前不存在」', snapMeta?.newFileCount === 3, String(snapMeta?.newFileCount))

const snapWrite = writeFiles({ projectRoot: snapDemo, files, backup: false })
check('写入成功', snapWrite.errors.length === 0, snapWrite.errors.join('; '))
check(
  '写入后 launch.json 已被覆盖',
  readFileSync(join(snapDemo, '.vscode', 'launch.json'), 'utf8') !== userLaunch
)

const restored = restoreSnapshot(snapDemo, snapId!)
check('还原无错误', restored.errors.length === 0, restored.errors.join('; '))
check(
  '还原后 launch.json 回到用户原有内容',
  readFileSync(join(snapDemo, '.vscode', 'launch.json'), 'utf8') === userLaunch
)
check(
  '还原后 settings.json 回到用户原有内容',
  readFileSync(join(snapDemo, '.vscode', 'settings.json'), 'utf8') === userSettings
)
check(
  '还原时删掉了 3 个写入前不存在的文件',
  restored.removed.length === 3,
  String(restored.removed.length)
)
check(
  '还原后 openocd 接线配置已不存在',
  !existsSync(join(snapDemo, '.vscode', 'openocd-stm32f1x-cmsis-dap.cfg'))
)
check('还原后 tasks.json 已不存在', !existsSync(join(snapDemo, '.vscode', 'tasks.json')))

// 越界防护：快照里带 ../ 也不能写到工程外
const evilSnap = captureSnapshot(snapDemo, [{ relativePath: '../../evil.txt', previous: 'x' }])
const evilRestore = restoreSnapshot(snapDemo, evilSnap!)
check('还原时拒绝越界路径', evilRestore.errors.length === 1, evilRestore.errors.join('; '))

// ==========================================================================
// 6. 内置模板
// ==========================================================================

section('6. 内置模板：列表非空，且套用时不会污染目标工程')

check('内置模板列表非空', BUILTIN_TEMPLATES.length >= 1, `实际 ${BUILTIN_TEMPLATES.length} 个`)

const builtin = BUILTIN_TEMPLATES[0]
check('内置模板带 builtin 标记', builtin.builtin === true)
check('内置模板 id 带 builtin: 前缀', isBuiltinTemplateId(builtin.id), builtin.id)
check('用户模板 id 不会被误判成内置', !isBuiltinTemplateId('6f1c9a2e-0000-4000-8000-000000000000'))
check('内置模板只写部分字段（没有写死固件名）', builtin.options.elfName === undefined)

/**
 * 关键回归：内置模板是「部分覆盖」，套用时**绝不能**把目标工程推导出来的
 * 固件名/芯片/构建目录/include 覆盖掉 —— 否则一个通用模板就会把
 * B 工程写成 A 工程的样子。
 */
const fakeBase = {
  elfName: 'demo',
  device: 'STM32F103C8Tx',
  probeKey: 'stlink' as const,
  interfaceCfg: 'interface/stlink.cfg',
  resetConfig: '',
  targetCfg: 'target/stm32f1x.cfg',
  adapterSpeed: 500,
  openocdExe: 'openocd.exe',
  cmakeExe: 'cmake.exe',
  ninjaExe: 'ninja.exe',
  toolchainDir: 'C:/toolchain',
  debugDir: 'build/Debug',
  releaseDir: 'build/Release',
  debugPreset: 'Debug',
  releasePreset: 'Release',
  hasBuildPresets: false,
  configurePreset: '',
  compileCommands: 'build/Debug/compile_commands.json',
  svdFile: '',
  generator: 'Ninja',
  includeDirs: ['/proj/inc'],
  defines: ['BOARD_V2'],
  cStandard: 'c99',
  cppStandard: 'c++14'
}

const adaptedBuiltin = adaptTemplateOptions(builtin.options, fakeBase)
check('内置模板会切到 CMSIS-DAP 探针', adaptedBuiltin.probeKey === 'cmsis-dap')
check('内置模板会设成 1MHz 适配器速度', adaptedBuiltin.adapterSpeed === 1000)
check('内置模板不覆盖固件名', adaptedBuiltin.elfName === 'demo', adaptedBuiltin.elfName)
check('内置模板不覆盖芯片', adaptedBuiltin.device === 'STM32F103C8Tx', adaptedBuiltin.device)
check('内置模板不覆盖构建目录', adaptedBuiltin.debugDir === 'build/Debug', adaptedBuiltin.debugDir)
check('内置模板不覆盖 include', adaptedBuiltin.includeDirs[0] === '/proj/inc')
check('内置模板不覆盖编译宏', adaptedBuiltin.defines[0] === 'BOARD_V2')
check('内置模板不覆盖 C 标准', adaptedBuiltin.cStandard === 'c99', adaptedBuiltin.cStandard)
check('内置模板不覆盖工具链目录', adaptedBuiltin.toolchainDir === 'C:/toolchain')

/**
 * 把内置样板「到底改了什么」钉死：它只该钉住探针和适配器速度，
 * 其余字段必须与「默认（按工程检测）」完全一致 —— 否则一个样板会悄悄改掉别的东西。
 */
const builtinDiff = (Object.keys(fakeBase) as Array<keyof typeof fakeBase>).filter(
  (k) => JSON.stringify(adaptedBuiltin[k]) !== JSON.stringify(fakeBase[k])
)
check(
  '内置样板只改了「探针」和「适配器速度」两项',
  builtinDiff.sort().join(',') === 'adapterSpeed,probeKey',
  builtinDiff.join(',')
)

// ==========================================================================
// 7. VSCode 工程发现
// ==========================================================================

section('7. VSCode 工程发现')

const candidates = discoverProjects(true, true)
console.log(`  发现 ${candidates.length} 个候选工程`)
for (const c of candidates.slice(0, 8)) {
  console.log(`    · ${c.root}   [${c.source}]${c.chip ? `  芯片=${c.chip}` : ''}`)
}
check('工程发现不抛异常', Array.isArray(candidates))

// ---- 回归：VSCode 的 workspace.json 里冒号是编码成 %3A 的 ----
// 早期版本先判断 text[2] === ':' 再解码，导致 /c%3A/... 解析成 /c:/...，
// 「最近打开的工程」永远是空的。这里用两种写法各验一遍。
check(
  'file URI：能解析 file:///c%3A/... （VSCode 实际写法）',
  parseFileUri('file:///c%3A/Users/someone/proj/my-firmware') === 'c:/Users/someone/proj/my-firmware',
  String(parseFileUri('file:///c%3A/Users/someone/proj/my-firmware'))
)
check(
  'file URI：也能解析未编码的 file:///c:/...',
  parseFileUri('file:///c:/Users/someone/Desktop/x') === 'c:/Users/someone/Desktop/x',
  String(parseFileUri('file:///c:/Users/someone/Desktop/x'))
)
check(
  'file URI：中文路径能正确解码',
  parseFileUri('file:///c%3A/Desktop/%E6%B5%8B%E8%AF%95') === 'c:/Desktop/测试'
)
check('file URI：空值返回 null', parseFileUri('') === null)

// ---- 回归：把 APPDATA 指到临时目录，验证「最近打开的工程」真的能扫出来 ----
{
  const fakeAppData = join(sandbox, 'appdata')
  const wsDir = join(fakeAppData, 'Code', 'User', 'workspaceStorage', 'deadbeef')
  mkdirSync(wsDir, { recursive: true })

  const demoUri = `file:///${demo.replace(/\\/g, '/').replace(/:/g, '%3A')}`
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ folder: demoUri }), 'utf8')

  const savedAppData = process.env.APPDATA
  process.env.APPDATA = fakeAppData
  const recents = getRecentProjects()
  process.env.APPDATA = savedAppData

  check('最近工程：能从 workspaceStorage 扫出工程', recents.length === 1, `实际 ${recents.length} 个`)
  check(
    '最近工程：定位到的是工程根',
    recents[0]?.root?.toLowerCase() === demo.toLowerCase(),
    String(recents[0]?.root)
  )
}

// ==========================================================================
// 8. 模板 v2：占位符替换与骨架生成
// ==========================================================================

section('8. 模板 v2：占位符不会被误替换，骨架可以被任何工程套用')

const tvars = {
  elfName: 'test-01',
  device: 'STM32F407IGH6',
  debugDir: 'build/Debug',
  openocdCfg: 'openocd-stm32f4x-cmsis-dap.cfg',
  probeLabel: 'CMSIS-DAP / DAP-Link'
}

const renderedElf = renderTemplateText('${workspaceFolder}/${debugDir}/${elfName}.elf', tvars)
check('占位符按目标工程替换', renderedElf === '${workspaceFolder}/build/Debug/test-01.elf', renderedElf)
check(
  'VSCode 的 ${workspaceFolder} 原样保留（最容易踩的坑）',
  renderTemplateText('${workspaceFolder}/x', tvars) === '${workspaceFolder}/x'
)
const renderedBuildType = renderTemplateText('${workspaceFolder}/build/${buildType}', tvars)
check(
  'CMake Tools 的 ${buildType} 原样保留',
  renderedBuildType === '${workspaceFolder}/build/${buildType}',
  renderedBuildType
)
check(
  '没提供值的变量保持原样（不悄悄变空串）',
  renderTemplateText('${svdFile}', tvars) === '${svdFile}',
  renderTemplateText('${svdFile}', tvars)
)
const unresolved = findUnresolvedVariables('${workspaceFolder}/${svdFile}', tvars)
check(
  '未解析检测不会把 workspaceFolder 算进去',
  unresolved.join(',') === 'svdFile',
  unresolved.join(',')
)

const presetSkeleton = buildTemplateSkeleton({
  target: { editor: 'vscode', buildSystem: 'preset', probe: 'cmsis-dap' },
  options: { probeKey: 'cmsis-dap', adapterSpeed: 1000 }
})
check(
  '骨架四份文件齐全',
  TEMPLATE_FILE_KEYS.every((k) => Boolean(presetSkeleton[k] && presetSkeleton[k].trim())),
  TEMPLATE_FILE_KEYS.filter((k) => !presetSkeleton[k]).join(',')
)
check(
  '骨架每一份都是合法 JSON',
  TEMPLATE_FILE_KEYS.every((k) => {
    try {
      JSON.parse(presetSkeleton[k])
      return true
    } catch {
      return false
    }
  })
)
check('preset 模式下任务用 --preset', presetSkeleton['tasks.json'].includes('--preset'))
check(
  '骨架不写死固件名（必须是占位符）',
  !presetSkeleton['launch.json'].includes('test-01') &&
    presetSkeleton['launch.json'].includes('${elfName}')
)
check('骨架里保留了 VSCode 变量', presetSkeleton['launch.json'].includes('${workspaceFolder}'))

const dirSkeleton = buildTemplateSkeleton({
  target: { editor: 'vscode', buildSystem: 'dir', probe: 'cmsis-dap' },
  options: {}
})
check('dir 模式下任务不用 --preset', !dirSkeleton['tasks.json'].includes('--preset'))

const jlinkSkeleton = buildTemplateSkeleton({
  target: { editor: 'vscode', buildSystem: 'preset', probe: 'jlink-native' },
  options: {}
})
check('非 OpenOCD 探针不生成 openocd 烧录任务', !jlinkSkeleton['tasks.json'].includes('"openocd"'))
check(
  '非 OpenOCD 探针的 launch 不带 configFiles',
  !jlinkSkeleton['launch.json'].includes('configFiles')
)

const renderedFiles = renderTemplateFiles(presetSkeleton, tvars)
check(
  '渲染后落到 .vscode/ 下且四份齐全',
  Object.keys(renderedFiles).sort().join(',') ===
    '.vscode/c_cpp_properties.json,.vscode/launch.json,.vscode/settings.json,.vscode/tasks.json',
  Object.keys(renderedFiles).join(',')
)
check(
  '渲染后 elfName 被真的填进去了',
  renderedFiles['.vscode/launch.json'].includes('build/Debug/test-01.elf')
)

// ==========================================================================
// 9. 用生成的 OpenOCD 配置真的启动一次 openocd
// ==========================================================================

section('9. 用生成的 OpenOCD 接线配置启动 OpenOCD')

const openocdExe = tools.items.openocd.path
if (!openocdExe) {
  console.log('  · 未探测到 openocd.exe，跳过这一节')
} else {
  const cfgPath = join(demo, '.vscode', 'openocd-stm32f1x-cmsis-dap.cfg')
  const res = spawnSync(openocdExe, ['-f', cfgPath, '-c', 'init; exit'], {
    encoding: 'utf8',
    timeout: 25000,
    windowsHide: true
  })
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`

  console.log('  openocd 输出:')
  for (const line of output
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 16)) {
    console.log(`    | ${line}`)
  }

  // 「找不到脚本」是配置生成的硬错误；下面几种都只是**硬件侧**的情况，属正常：
  //   · 没插调试器
  //   · 调试器插了但没响应（连续烧录后会这样，`CMSIS-DAP command CMD_INFO failed` 就是）
  //   · 调试器被别的进程占着（上一个 OpenOCD / 调试会话没退干净）
  // 这条断言要守的是「生成的脚本能被 OpenOCD 正确解析」，不是「硬件一定在状态」，
  // 所以硬件侧的失败一律放行 —— 否则一条自检会被探针的脾气搞成假红。
  const scriptMissing = /Can't find|couldn't find|No such file|Can't find file/i.test(output)
  const adapterUnusable =
    /unable to find a matching|no .*(device|adapter) found|open failed|Failed to open|No CMSIS-DAP|unable to open .*device|CMD_INFO failed|command .* failed|already in use|LIBUSB/i.test(
      output
    )

  check(
    'OpenOCD 能解析生成的 interface/target 脚本（没有找不到文件）',
    !scriptMissing,
    output.slice(0, 200)
  )
  check(
    'OpenOCD 成功初始化，或明确报告硬件侧不可用（没插/没响应/被占用）',
    res.status === 0 || adapterUnusable,
    `exit=${res.status}`
  )
}

// ==========================================================================
// 10. CMake 目标与源文件：位置感知解析 + 加/删源文件
// ==========================================================================

section('10. CMake 构建目标与源文件')

{
  const proj = join(sandbox, 'cmake-src')
  mkdirSync(join(proj, 'application'), { recursive: true })
  mkdirSync(join(proj, 'components'), { recursive: true })
  mkdirSync(join(proj, 'cmake', 'mx'), { recursive: true })

  const CMAKE_SRC = `cmake_minimum_required(VERSION 3.22)

set(CMAKE_PROJECT_NAME demo_robot)
project(\${CMAKE_PROJECT_NAME})

add_executable(\${CMAKE_PROJECT_NAME})

add_subdirectory(cmake/mx)

# 源文件都在这个列表里
target_sources(\${CMAKE_PROJECT_NAME} PRIVATE
    \${CMAKE_CURRENT_SOURCE_DIR}/application/main.c
    \${CMAKE_CURRENT_SOURCE_DIR}/application/gimbal_task.c
    \${CMAKE_CURRENT_SOURCE_DIR}/components/pid.c
)

set(EXTRA_SRcs \${CMAKE_CURRENT_SOURCE_DIR}/components/fifo.c)

target_include_directories(\${CMAKE_PROJECT_NAME} PRIVATE
    \${CMAKE_CURRENT_SOURCE_DIR}/application
    \${CMAKE_CURRENT_SOURCE_DIR}/components
)

target_compile_definitions(\${CMAKE_PROJECT_NAME} PRIVATE ARM_MATH_CM4)

# 另一个文件用了变量列表 —— 展开后是 a;b;c，必须按分号拆开，否则只算一个源文件
target_sources(\${CMAKE_PROJECT_NAME} PRIVATE \${EXTRA_SRcs})
`

  // 子目录：路径写成 ${CMAKE_CURRENT_SOURCE_DIR}/../../Drivers/xxx.c
  // 曾经的坑：见到 ${ 就跳过 → 这些文件全被误判成「没进构建」
  const CMAKE_SUB = `add_library(STM32_Drivers OBJECT)
set(STM32_Drivers_Src
    \${CMAKE_CURRENT_SOURCE_DIR}/../../application/driver_a.c
    \${CMAKE_CURRENT_SOURCE_DIR}/../../application/driver_b.c
)
target_sources(STM32_Drivers PRIVATE \${STM32_Drivers_Src})
`

  writeFileSync(join(proj, 'CMakeLists.txt'), CMAKE_SRC, 'utf8')
  writeFileSync(join(proj, 'cmake', 'mx', 'CMakeLists.txt'), CMAKE_SUB, 'utf8')
  for (const f of [
    'application/main.c',
    'application/gimbal_task.c',
    'application/driver_a.c',
    'application/driver_b.c',
    'components/pid.c',
    'components/fifo.c',
    // 这个只在磁盘上、没写进任何 CMakeLists —— 应该被找出来
    'application/orphan.c',
    // 头文件不该被算成「没进构建」
    'application/main.h'
  ]) {
    writeFileSync(join(proj, ...f.split('/')), 'int x;\n', 'utf8')
  }

  const cmakeFile = join(proj, 'CMakeLists.txt')
  const original = readFileSync(cmakeFile, 'utf8')

  // ---- 解析 ----
  const model = buildCmakeModel(cmakeFile, proj)
  check('CMake: 解析出工程名', model.projectName === 'demo_robot', String(model.projectName))

  const rootTarget = model.targets.find((t) => t.kind === 'executable')
  check('CMake: 找到可执行目标', Boolean(rootTarget), model.targets.map((t) => t.name).join(', '))
  check(
    'CMake: ${CMAKE_CURRENT_SOURCE_DIR} 能展开，源文件不是 0 个',
    (rootTarget?.sources.length ?? 0) === 4,
    String(rootTarget?.sources.length)
  )
  check(
    'CMake: 变量列表按 ; 拆开（EXTRA_SRcs 那条要算进 fifo.c）',
    Boolean(rootTarget?.sources.some((s) => s.relPath === 'components/fifo.c')),
    rootTarget?.sources.map((s) => s.relPath).join(', ')
  )
  check(
    'CMake: include 目录解析正确',
    (rootTarget?.includeDirs.length ?? 0) === 2,
    String(rootTarget?.includeDirs.length)
  )
  check('CMake: define 解析正确', (rootTarget?.defines.length ?? 0) === 1)

  // ---- 全工程引用收集 ----
  const ref = collectReferencedPaths(proj)
  check(
    'CMake: 子目录里的 ${CMAKE_CURRENT_SOURCE_DIR}/../.. 路径也收得到',
    ref.sources.has('application/driver_a.c') && ref.sources.has('application/driver_b.c'),
    [...ref.sources].join(', ')
  )
  check('CMake: 找到了 2 个 CMakeLists', ref.dirs.length === 2, String(ref.dirs.length))

  // ---- 找出「没进构建」的 ----
  const scan = scanSources(proj)
  check(
    'CMake: 只有 orphan.c 被判定为「没进构建」',
    scan.orphans.length === 1 && scan.orphans[0] === 'application/orphan.c',
    scan.orphans.join(', ')
  )
  check(
    'CMake: 头文件不算「没进构建」',
    !scan.orphans.some((o) => o.endsWith('.h')),
    scan.orphans.join(', ')
  )

  // ---- 加入 ----
  const addPlan = planSourceEdit(model, {
    targetName: 'demo_robot',
    add: ['application/orphan.c']
  })
  check('CMake: 加入时找到了就地插入点', !addPlan.usedFallback, addPlan.notes.join(' | '))
  check(
    'CMake: 加入后原文多了一行、且包含新路径',
    addPlan.after.split('\n').length === original.split('\n').length + 1 &&
      addPlan.after.includes('application/orphan.c'),
    `+${addPlan.after.split('\n').length - original.split('\n').length} 行`
  )
  check(
    'CMake: 加入只动了一行（字符差 = 换行 + 缩进 + 路径）',
    addPlan.after.length - original.length === 1 + 4 + 'application/orphan.c'.length,
    String(addPlan.after.length - original.length)
  )

  writeFileSync(cmakeFile, addPlan.after, 'utf8')
  const reparsed = buildCmakeModel(cmakeFile, proj)
  const added = reparsed.targets
    .find((t) => t.kind === 'executable')
    ?.sources.find((s) => s.relPath === 'application/orphan.c')
  check('CMake: 写入后重新解析能读到新文件', Boolean(added), String(added?.line))
  check('CMake: 重新扫描后「没进构建」清空', scanSources(proj).orphans.length === 0)

  // ---- 移除 + 幂等 ----
  const rmPlan = planSourceEdit(reparsed, {
    targetName: 'demo_robot',
    remove: ['application/orphan.c']
  })
  writeFileSync(cmakeFile, rmPlan.after, 'utf8')
  check(
    'CMake: 加完再删能逐字节回到原文件（编辑可逆，不累积垃圾）',
    readFileSync(cmakeFile, 'utf8') === original,
    `差 ${Math.abs(readFileSync(cmakeFile, 'utf8').length - original.length)} 字符`
  )

  // ---- 重复加不会写两遍 ----
  // 注意：planSourceEdit 每次都从磁盘重读，所以这里要拿**当前**内容的模型，
  // 不能用上面那份最初的 model，否则比对的基准对不上。
  const fresh = buildCmakeModel(cmakeFile, proj)
  const dup = planSourceEdit(fresh, { targetName: 'demo_robot', add: ['application/main.c'] })
  check(
    'CMake: 已经在构建里的文件不会重复加',
    dup.added.length === 0 && dup.after === original,
    dup.notes.join(' | ')
  )

  // ---- 目标不存在时不乱动 ----
  const noTarget = planSourceEdit(fresh, { targetName: '不存在的目标', add: ['x.c'] })
  check('CMake: 目标不存在时不乱改，只给提示', noTarget.after === original)

  // ---- file(GLOB) 提示 ----
  const globProj = join(sandbox, 'cmake-glob')
  mkdirSync(globProj, { recursive: true })
  writeFileSync(
    join(globProj, 'CMakeLists.txt'),
    `project(g)\nfile(GLOB SRC CONFIGURE_DEPENDS src/*.c)\nadd_executable(g \${SRC})\n`,
    'utf8'
  )
  const globModel = buildCmakeModel(join(globProj, 'CMakeLists.txt'), globProj)
  check(
    'CMake: 识别 file(GLOB) 并给出「不用手动加」的提示',
    globModel.diagnostics.some((d) => d.includes('GLOB')),
    globModel.diagnostics.join(' | ')
  )

  // ---- 新建文件的骨架 ----
  const skeleton = renderNewFile('task-c', 'application/oled_task.c')
  check(
    'CMake: 任务骨架带任务函数和创建提示',
    skeleton.includes('void oled_task(void const *argument)') && skeleton.includes('osThreadCreate'),
    skeleton.slice(0, 60)
  )
  const header = renderNewFile('h', 'application/oled_task.h')
  check(
    'CMake: 头文件骨架带正确的 include guard',
    header.includes('#ifndef OLED_TASK_H') && header.includes('#define OLED_TASK_H'),
    header.slice(0, 60)
  )
}

// ==========================================================================
// 11. 模块包（vofa）：探测 → 兼容性 → PID 扫描 → 清单 → 写入 → 还原
//
// 用**合成工程**而不是机器上的真工程 —— 换台机器结果一样，而且能精确造出
// 「没有 RX DMA」「有 gimbal_PID_t 成员」这些要测的条件。
// ==========================================================================

section('11. 模块包：探测 / 兼容性 / PID 扫描 / 清单 / 写入 / 还原')

const packRoot = join(sandbox, 'pack-proj')
const put = (rel: string, body: string): void => {
  const p = join(packRoot, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, 'utf8')
}

put(
  'CMakeLists.txt',
  `cmake_minimum_required(VERSION 3.22)
project(demo C CXX ASM)
add_executable(\${CMAKE_PROJECT_NAME})
target_sources(\${CMAKE_PROJECT_NAME} PRIVATE
    Src/main.c
    Src/freertos.c
)
`
)
put('Inc/main.h', '#pragma once\n#include "stm32f4xx_hal.h"\n')
put('Inc/usart.h', '#pragma once\n#include "main.h"\nextern UART_HandleTypeDef huart1;\n')
put(
  'Src/usart.c',
  '#include "usart.h"\nUART_HandleTypeDef huart1;\nDMA_HandleTypeDef hdma_usart1_tx;\n'
)
put(
  'bsp/boards/bsp_usart.h',
  '#pragma once\n#include <stdint.h>\nextern void usart1_tx_dma_enable(uint8_t *data, uint16_t len);\n'
)
put(
  'application/pid.h',
  '#pragma once\ntypedef struct { float Kp, Ki, Kd, max_out, max_iout; } pid_type_def;\n'
)
put(
  'application/gimbal_task.h',
  `#pragma once
#include "pid.h"
typedef struct { float kp, ki, kd, max_out, max_iout; } gimbal_PID_t;
typedef struct {
    gimbal_PID_t gimbal_motor_absolute_angle_pid;
    pid_type_def gimbal_motor_gyro_pid;
    float absolute_angle;
} gimbal_motor_t;
extern const gimbal_motor_t *get_yaw_motor_point(void);
`
)
// 这个类型的成员没有任何全局实例 —— 验证工具「不瞎猜实例名」(bug 回归)
put(
  'application/other_task.h',
  '#pragma once\n#include "pid.h"\ntypedef struct { pid_type_def some_pid; } other_t;\n'
)
put(
  'application/remote_control.h',
  `#pragma once
typedef struct { struct { short ch[5]; } rc; } RC_ctrl_t;
extern const RC_ctrl_t *get_remote_control_point(void);
`
)
put('application/remote_control.c', '#include "remote_control.h"\n#define SBUS_FORWARD_TO_USART1 1\n')
put(
  'Src/freertos.c',
  '#include "cmsis_os.h"\n/* USER CODE END Header */\n/* USER CODE BEGIN Variables */\n'
)
put('Middlewares/rtos/cmsis_os.h', '#pragma once\n')

const vofaPack = loadPack('vofa')
check('Pack: 能装载 vofa 包', vofaPack !== null && (vofaPack?.files.length ?? 0) > 0)
check(
  'Pack: 包列表包含 vofa',
  listPacks().some((p) => p.id === 'vofa'),
  listPacks()
    .map((p) => p.id)
    .join(',')
)

if (vofaPack) {
  const facts = inspectProject(packRoot)
  const compat = checkPackCompat(vofaPack, packRoot, facts)
  const u1 = facts.uarts.find((u) => u.name === 'huart1')

  check(
    'Pack: 合成工程不阻塞安装',
    !compat.blocked,
    JSON.stringify(compat.checks.filter((c) => c.level === 'err'))
  )
  check(
    'Pack: 认到 huart1 有 TX DMA、没有 RX DMA',
    u1?.txDma === 'hdma_usart1_tx' && u1?.rxDma === null,
    `${u1?.txDma} / ${u1?.rxDma}`
  )
  check(
    'Pack: 没 RX DMA 时自动选逐字节中断',
    compat.derived.rxMode === 'it',
    String(compat.derived.rxMode)
  )
  check(
    'Pack: 没有中断入口时自动让模块自带',
    compat.derived.builtinIrq === true,
    String(compat.derived.builtinIrq)
  )
  // bug 回归：不能因为「文件里出现过这个词」就当声明处
  //（工具自己生成的 vofa_config.h 里也有 usart1_tx_dma_enable）
  check(
    'Pack: TX 函数的声明头文件是 bsp_usart.h（要求真有 extern，不是只看出现过）',
    facts.symbolHeaders.get('usart1_tx_dma_enable') === 'bsp/boards/bsp_usart.h',
    String(facts.symbolHeaders.get('usart1_tx_dma_enable'))
  )
  check(
    'Pack: 遥控器访问器的声明头文件是 remote_control.h',
    facts.symbolHeaders.get('get_remote_control_point') === 'application/remote_control.h',
    String(facts.symbolHeaders.get('get_remote_control_point'))
  )

  // ---- PID 扫描 ----
  const cands = scanPidStructs(packRoot)
  const gm = cands.find((c) => c.name === 'gimbal_motor_gyro_pid')
  check('PID: 扫到结构体成员', Boolean(gm))
  check(
    'PID: 识别为 gimbal_motor_t 的成员',
    gm?.isMember === true && gm?.ownerType === 'gimbal_motor_t',
    `${gm?.isMember} / ${gm?.ownerType}`
  )
  check(
    'PID: 云台成员给出可直接用的表达式与判空',
    gm?.suggestedExpr === 'get_yaw_motor_point()->gimbal_motor_gyro_pid' &&
      gm?.suggestedGuard === 'get_yaw_motor_point()',
    gm?.suggestedExpr
  )
  const orphan = cands.find((c) => c.name === 'some_pid')
  check(
    'PID: 查不到全局实例时留空并标记 needsInstance（不编变量名）',
    orphan?.needsInstance === true && orphan?.suggestedExpr === '',
    `needsInstance=${orphan?.needsInstance} expr="${orphan?.suggestedExpr}"`
  )

  // ---- 清单：只算不写 ----
  const bindings = {
    pids: [
      {
        prefix: 'yaw_ang',
        pidType: 'gimbal_PID_t' as const,
        expr: 'get_yaw_motor_point()->gimbal_motor_absolute_angle_pid',
        guard: 'get_yaw_motor_point()',
        include: 'application/gimbal_task.h'
      },
      {
        prefix: 'yaw_spd',
        pidType: 'pid_type_def' as const,
        expr: 'get_yaw_motor_point()->gimbal_motor_gyro_pid',
        guard: 'get_yaw_motor_point()',
        include: facts.headers.get('pid.h')
      }
    ],
    channels: [
      {
        name: 'yaw_get',
        expr: 'get_yaw_motor_point()->absolute_angle',
        guard: 'get_yaw_motor_point()'
      },
      {
        name: 'rc_ch0',
        mirrorFrom: 'get_remote_control_point()->rc.ch[0]',
        guard: 'get_remote_control_point()',
        include: 'application/remote_control.h'
      }
    ]
  }
  const plan = planPackInstall({
    packId: 'vofa',
    root: packRoot,
    params: { ...compat.derived, sendHz: 50 },
    bindings
  })
  check('清单: 不阻塞', !plan.blocked)
  check(
    '清单: 5 个新增 + 3 个补丁',
    plan.changes.filter((c) => c.action === 'create').length === 5 &&
      plan.changes.filter((c) => c.action === 'patch').length === 3,
    plan.changes.map((c) => `${c.action}:${c.path}`).join(' ')
  )
  check(
    '清单: 只算不写 —— 磁盘上还没有 application/vofa',
    !existsSync(join(packRoot, 'application/vofa'))
  )

  // ---- 生成内容 ----
  const cfg = renderConfig(vofaPack, { ...compat.derived, sendHz: 50 }, facts)
  check('生成: RX_MODE=2（逐字节中断）', /#define VOFA_RX_MODE\s+2/.test(cfg))
  check('生成: USE_BUILTIN_IRQ=1', /#define VOFA_USE_BUILTIN_IRQ\s+1/.test(cfg))
  check(
    '生成: TX 头文件是 bsp_usart.h（不是自己 include 自己）',
    /#define VOFA_TX_HEADER\s+"bsp_usart\.h"/.test(cfg),
    cfg.match(/VOFA_TX_HEADER.*/)?.[0]
  )
  const bind = renderBind(vofaPack, bindings, facts)
  check('生成: 绑定体带判空', bind.includes('if (get_yaw_motor_point() != NULL)'))
  check(
    '生成: PID 走对应的辅助函数',
    bind.includes('vofa_reg_pid_gimbal(') && bind.includes('vofa_reg_pid_std(')
  )
  check(
    '生成: 非 fp32 通道生成 fp32 镜像与刷新回调',
    bind.includes('static fp32 vofa_mirror_') && bind.includes('void vofa_bind_tick(void)')
  )
  check('生成: include 了遥控器头文件', bind.includes('#include "remote_control.h"'))

  // ---- 写入 ----
  const apply = applyPackInstall(plan)
  check('写入: 成功且无错误', apply.ok, apply.errors.join(';'))
  check('写入: 拿到快照 id（拿不到就该中止）', Boolean(apply.snapshotId))
  // bug 回归：writeFileSync 不建父目录，漏了这步 application/vofa/ 会是空的
  check(
    '写入: 新建目录被自动创建，5 个文件都在',
    ['vofa_task.c', 'vofa_task.h', 'vofa_types.h', 'vofa_config.h', 'vofa_bind.c'].every((f) =>
      existsSync(join(packRoot, 'application/vofa', f))
    )
  )
  check(
    '写入: CMakeLists 加了两个源文件',
    (() => {
      const t = readFileSync(join(packRoot, 'CMakeLists.txt'), 'utf8')
      return t.includes('application/vofa/vofa_task.c') && t.includes('application/vofa/vofa_bind.c')
    })()
  )
  check(
    '写入: freertos.c 建了任务',
    readFileSync(join(packRoot, 'Src/freertos.c'), 'utf8').includes('osThreadCreate(osThread(vofa)')
  )

  // ---- 还原 ----
  const back = restoreSnapshot(packRoot, apply.snapshotId!)
  check('还原: 无错误', back.errors.length === 0, back.errors.join(';'))
  check('还原: 删掉了 5 个新建文件', back.removed.length === 5, String(back.removed.length))
  // bug 回归：文件删了但空目录留着，看着像「装了一半」
  check('还原: 空的 application/vofa 目录也被清掉', !existsSync(join(packRoot, 'application/vofa')))
  check(
    '还原: CMakeLists 回到原样',
    !readFileSync(join(packRoot, 'CMakeLists.txt'), 'utf8').includes('vofa')
  )
  check(
    '还原: freertos.c 回到原样',
    !readFileSync(join(packRoot, 'Src/freertos.c'), 'utf8').includes('vofa')
  )
  check(
    'Pack: 还原只动工程，没碰 packs 目录本身',
    readPackFile('vofa', 'vofa_task.c')?.includes('vofa_bind_all') === true
  )
}

// ==========================================================================
// 12. 构建图：include() / add_subdirectory() / 变量 / GLOB
//
// 这一节的由来：有工程把源文件清单放在 include() 进来的 .cmake 里（根 CMakeLists
// 里那个 target_sources 是 CubeMX 生成的空占位），只看根文件就会把它们全报成
// 「不在构建里」—— 用户照着点「加入构建」会重复编译、链接报 multiple definition。
// ==========================================================================

section('12. 构建图：include / add_subdirectory / 变量 / GLOB')

const bgRoot = join(sandbox, 'build-graph')
const bgPut = (rel: string, body: string): void => {
  const p = join(bgRoot, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf8')
}

bgPut(
  'CMakeLists.txt',
  `project(demo C)
add_executable(demo)
add_subdirectory(sub)
include(cmake/user.cmake)
file(GLOB EXTRA src/*.c)
`
)
bgPut(
  'cmake/user.cmake',
  `set(APP_ROOT \${CMAKE_CURRENT_LIST_DIR}/..)
set(APP_Src
    \${APP_ROOT}/app/a.c
    \${APP_ROOT}/app/b.c
)
target_sources(demo PRIVATE \${APP_Src})
target_include_directories(demo PRIVATE \${APP_ROOT}/app)
`
)
bgPut(
  'sub/CMakeLists.txt',
  `set(SUB_Src \${CMAKE_CURRENT_SOURCE_DIR}/c.c)
target_sources(demo PRIVATE \${SUB_Src})
`
)
bgPut('app/orphan_x.c', 'int x;\n')
// 跨两行的注释：模拟真实工程里「第一行点名文件、第二行才写原因」的写法
bgPut(
  'note.cmake',
  '# orphan_x.c exists on disk but is NOT part of the build -\n# intentionally excluded.\n'
)
bgPut('app/a.c', 'int a;\n')
bgPut('app/b.c', 'int b;\n')
bgPut('sub/c.c', 'int c;\n')
bgPut('src/d.c', 'int d;\n')

const bg = buildProjectBuildModel(bgRoot)
check(
  '构建图: 跟进了 include() 的 .cmake',
  bg.parsedFiles.includes('cmake/user.cmake'),
  bg.parsedFiles.join(',')
)
check(
  '构建图: 跟进了 add_subdirectory() 的子 CMakeLists',
  bg.parsedFiles.includes('sub/CMakeLists.txt'),
  bg.parsedFiles.join(',')
)
// 变量值里带内置变量（${CMAKE_CURRENT_LIST_DIR}/..）也要能展开 —— 这是第一版只解出 0 个源文件的原因
check(
  '构建图: include 里的源文件算进来了（嵌套变量展开）',
  bg.sources.includes('app/a.c') && bg.sources.includes('app/b.c'),
  bg.sources.join(',')
)
check('构建图: 子目录的源文件也算进来了', bg.sources.includes('sub/c.c'), bg.sources.join(','))
check('构建图: include 目录按 ; 拆开了', bg.includeDirs.includes('app'), bg.includeDirs.join(','))
check(
  '构建图: file(GLOB) 会记进「没看全」，界面据此禁用加入',
  bg.unresolved.some((u) => /GLOB/.test(u)),
  bg.unresolved.join(' / ')
)

// 注释里提到过某个「不在构建里」的文件 —— 界面引用原文 + 标出处，不做语义判断
const bgScan = scanSources(bgRoot)
const noted = findOrphanNotes(bgRoot, bgScan.orphans).find((n) => n.relPath === 'app/orphan_x.c')
check(
  '构建图: 能从构建文件的注释里摘出相关说明',
  Boolean(noted?.notes.length) && /intentionally excluded/.test(noted!.notes[0].text),
  JSON.stringify(noted?.notes ?? [])
)
check(
  '构建图: 摘出来的说明带出处，且只摘相关那一两句（不是整块文件头）',
  noted?.notes[0].file === 'note.cmake' && noted!.notes[0].text.length < 160,
  `${noted?.notes[0]?.file} len=${noted?.notes[0]?.text.length}`
)

// ==========================================================================
// 13. 工程改名：目录名 vs CMake 工程名
//
// 由来：从模板复制了工程、只改了文件夹名，CMakeLists.txt 里还留着模板的名字，
// 于是产物叫 <旧名>.elf，而 VSCode 的构建分析器按文件夹名找 —— 对不上，很难查。
// ==========================================================================

section('13. 工程改名：目录名 vs CMake 工程名')

const rnRoot = join(sandbox, 'rename-proj')
mkdirSync(rnRoot, { recursive: true })
writeFileSync(
  join(rnRoot, 'CMakeLists.txt'),
  `cmake_minimum_required(VERSION 3.22)
set(CMAKE_PROJECT_NAME old_name)
project(\${CMAKE_PROJECT_NAME})
add_executable(\${CMAKE_PROJECT_NAME})
target_link_directories(\${CMAKE_PROJECT_NAME} PRIVATE
)
`,
  'utf8'
)
writeFileSync(
  join(rnRoot, 'old_name.ioc'),
  'ProjectManager.ProjectName=old_name\nMcu.CPN=STM32F407IGH6\n',
  'utf8'
)

check('改名: 名字比较忽略大小写和 -/_ 区别', sameProjectName('target-car', 'target_car'))

const rnPlan = planProjectRename(rnRoot, 'target-car', true)
check('改名: 计划不阻塞', !rnPlan.blocked, rnPlan.notes.join(' / '))
check(
  '改名: CMakeLists 里只换 set(CMAKE_PROJECT_NAME) 的值',
  (() => {
    const a = rnPlan.changes.find((c) => c.path === 'CMakeLists.txt')?.after ?? ''
    // 引用 ${CMAKE_PROJECT_NAME} 的地方必须原样保留，不能被替换成字面量
    return (
      a.includes('set(CMAKE_PROJECT_NAME target-car)') &&
      a.includes('add_executable(${CMAKE_PROJECT_NAME})') &&
      a.includes('target_link_directories(${CMAKE_PROJECT_NAME} PRIVATE')
    )
  })(),
  rnPlan.changes.find((c) => c.path === 'CMakeLists.txt')?.after?.slice(0, 120)
)
check(
  '改名: .ioc 改名 = 新建新名 + 删除旧名',
  rnPlan.changes.some((c) => c.path === 'target-car.ioc' && c.action === 'create') &&
    rnPlan.changes.some((c) => c.path === 'old_name.ioc' && c.action === 'delete')
)
check(
  '改名: 新 .ioc 内部 ProjectName 也改了',
  (rnPlan.changes.find((c) => c.path === 'target-car.ioc')?.after ?? '').includes(
    'ProjectManager.ProjectName=target-car'
  )
)
check('改名: 计划阶段不写盘', readFileSync(join(rnRoot, 'CMakeLists.txt'), 'utf8').includes('old_name'))

const rnApply = applyProjectRename(rnPlan)
check('改名: 落盘成功且有快照', rnApply.ok && Boolean(rnApply.snapshotId), rnApply.errors.join(';'))
check(
  '改名: 磁盘上确实是新名字，旧 .ioc 已不存在',
  readFileSync(join(rnRoot, 'CMakeLists.txt'), 'utf8').includes('set(CMAKE_PROJECT_NAME target-car)') &&
    !existsSync(join(rnRoot, 'old_name.ioc')) &&
    existsSync(join(rnRoot, 'target-car.ioc'))
)

// 还原后应该回到旧名字、旧 .ioc 回来
const rnBack = restoreSnapshot(rnRoot, rnApply.snapshotId!)
check(
  '改名: 快照能还原（旧名字回来、新 .ioc 被删掉）',
  rnBack.errors.length === 0 &&
    readFileSync(join(rnRoot, 'CMakeLists.txt'), 'utf8').includes('old_name') &&
    existsSync(join(rnRoot, 'old_name.ioc')) &&
    !existsSync(join(rnRoot, 'target-car.ioc')),
  rnBack.errors.join(';')
)

// ==========================================================================
// 14. .vscode 文件归属：只有确实是本工具写的才允许删
//
// 由来：本工具和 STM32Cube / CMake Tools 扩展都往 .vscode 里写同名文件。
// 以前「清除配置」只判断文件存在，于是会把别人的配置当自己的删掉 —— 不可逆。
// ==========================================================================

section('14. .vscode 文件归属：区分本工具写的和别人写的')

const owRoot = join(sandbox, 'ownership')
const owVscode = join(owRoot, '.vscode')
mkdirSync(owVscode, { recursive: true })

// 别人写的：settings 只有 cmake.*，c_cpp_properties 用 msvc
writeFileSync(
  join(owVscode, 'settings.json'),
  JSON.stringify({ 'cmake.cmakePath': 'cube-cmake', 'cmake.configureArgs': [] }, null, 4),
  'utf8'
)
writeFileSync(
  join(owVscode, 'c_cpp_properties.json'),
  JSON.stringify(
    {
      configurations: [
        {
          name: 'STM32',
          compileCommands: '${workspaceFolder}/build/Debug/compile_commands.json',
          intelliSenseMode: 'windows-msvc-x64'
        }
      ],
      version: 4
    },
    null,
    4
  ),
  'utf8'
)
// 本工具写的：settings 有 C_Cpp.default.*，c_cpp_properties 用 gcc
writeFileSync(
  join(owVscode, 'launch.json'),
  JSON.stringify(
    { configurations: [{ name: 'Debug 调试', type: 'cortex-debug', preLaunchTask: '构建 Debug' }] },
    null,
    4
  ),
  'utf8'
)
writeFileSync(
  join(owVscode, 'tasks.json'),
  JSON.stringify({ tasks: [{ label: '构建 Debug', type: 'shell' }] }, null, 4),
  'utf8'
)
writeFileSync(
  join(owVscode, 'openocd-stm32f4x-cmsis-dap.cfg'),
  'source [find interface/cmsis-dap.cfg]\n',
  'utf8'
)

const ow = inspectVscodeOwnership(owRoot)
check(
  '归属: 认出本工具写的 launch/tasks/openocd',
  ['.vscode/launch.json', '.vscode/tasks.json', '.vscode/openocd-stm32f4x-cmsis-dap.cfg'].every((p) =>
    ow.ours.includes(p)
  ),
  ow.ours.join(',')
)
check(
  '归属: 别人写的 settings.json 不算本工具的',
  !ow.ours.includes('.vscode/settings.json'),
  ow.all.find((v) => v.path.endsWith('settings.json'))?.why
)
check(
  '归属: 别人写的 c_cpp_properties.json（msvc）不算本工具的',
  !ow.ours.includes('.vscode/c_cpp_properties.json'),
  ow.all.find((v) => v.path.endsWith('c_cpp_properties.json'))?.why
)
check(
  '归属: 每个判断都带理由，界面能解释为什么不删',
  ow.all.every((v) => v.why.length > 0)
)

// ==========================================================================
// 汇总
// ==========================================================================

rmSync(sandbox, { recursive: true, force: true })

section('结果')
console.log(`  共 ${checks} 项检查，失败 ${failures} 项`)
if (failures > 0) {
  console.log('  ✗ 自检未通过')
  process.exit(1)
}
console.log('  ✓ 全部通过')
