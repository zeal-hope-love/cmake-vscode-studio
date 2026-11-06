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

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import {
  buildTemplateFile,
  parseTemplateFile,
  TEMPLATE_FORMAT_DOC,
  isBuiltinPresetId
} from '../src/shared/templateFormat'
import { listBuiltinPackPresets } from '../src/main/services/data/packPresetStore'
import { compareVersion } from '../src/shared/versionCompare'
import {
  captureSnapshotDetailed,
  configureSnapshots,
  listSnapshots,
  restoreSnapshot
} from '../src/main/services/data/snapshotStore'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { defaultGenOptions, generateBundle, generateLaunch } from '../src/main/services/generate/generators'
import { scanProject } from '../src/main/services/project/scanner'
import {
  buildCmakeModel,
  buildProjectBuildModel,
  collectReferencedPaths
} from '../src/main/services/cmake/cmakeModel'
import { planSourceEdit } from '../src/main/services/cmake/cmakeEdit'
import { findOrphanNotes, scanSources, renderNewFile } from '../src/main/services/project/sourceScanner'
import {
  applyProjectRename,
  planProjectRename,
  sameName as sameProjectName
} from '../src/main/services/project/projectRename'
import { inspectVscodeOwnership } from '../src/main/services/generate/vscodeOwnership'
import { detectTools, findSvdFile } from '../src/main/services/project/toolDetector'
import { planFiles, writeFiles } from '../src/main/services/generate/writer'
import { buildWriteRecord } from '../src/main/services/data/historyStore'
import { openSnapshot } from '../src/main/services/data/commit'
import {
  captureSnapshot,
  configureSnapshots,
  listSnapshots,
  restoreSnapshot
} from '../src/main/services/data/snapshotStore'
import { discoverProjects, getRecentProjects, parseFileUri } from '../src/main/services/project/workspaceFinder'
import { BUILTIN_TEMPLATES, isBuiltinTemplateId } from '../src/shared/builtinTemplates'
import {
  findUnresolvedVariables,
  renderTemplateFiles,
  renderTemplateText
} from '../src/shared/templateRender'
import { buildTemplateSkeleton } from '../src/shared/templateSkeleton'
import { TEMPLATE_FILE_KEYS } from '../src/shared/types/index'
import { adaptTemplateOptions } from '../src/shared/templateAdapt'
import {
  checkPackCompat,
  inspectProject,
  listPacks,
  loadPack,
  readPackFile,
  scanPidStructs
} from '../src/main/services/pack/packStore'
import {
  applyPackCore,
  planPackInstall,
  renderBind,
  renderConfig,
  renderGenerated
} from '../src/main/services/pack/index'
import { scanSymbols } from '../src/main/services/project/symbolScanner'
import { checkBaudInCode, peripheralOf, planUartIoc, readRxDmaMode } from '../src/main/services/ioc/uart'
import { parseElfVars } from '../src/main/services/project/elfSymbols'
import {
  ADDR_SLOT_MAX,
  MEM_KINDS,
  buildReadCommand,
  buildSlotCommands,
  buildWriteCommand,
  hexAddr,
  kindFromSize,
  normalizeAddrTable,
  serializeAddrTable,
  slotLegend
} from '../src/shared/addrTable'
import { loadVofaMap, saveVofaMap, vofaMapPath } from '../src/main/services/data/vofaMapStore'
import { bindingFromSymbol, mapToPackBindings } from '../src/shared/vofaMap'

let failures = 0
let checks = 0
let skipped = 0

function check(name: string, condition: boolean, detail = ''): void {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? `  —— ${detail}` : ''}`)
  }
}

/**
 * 跳过一项检查。
 *
 * 用于「环境不具备就没法验证」的断言，比如本机没装 OpenOCD 时，
 * 不该因为写不出 openocdPath 就判定代码坏了 —— 那是环境差异，不是回归。
 * CI 的 windows-latest 就没装 OpenOCD，之前这几项把整条流水线卡红了好几版。
 *
 * 跳过的项单独计数，不计入 failures，也不会伪装成通过（输出里是 `·` 而不是 `✓`）。
 */
function skip(name: string, reason: string): void {
  skipped += 1
  console.log(`  · ${name}  （跳过：${reason}）`)
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

/*
 * OpenOCD 是「用户机器上装没装」的问题，不是代码问题。
 * 装了才断言能探测到；没装就跳过 —— CI 的 windows-latest 就没装，
 * 之前硬断言导致 release 流水线每次都红。
 */
if (tools.items.openocd.found) {
  check('探测到 OpenOCD', true, tools.items.openocd.path ?? '')
  check('定位到 OpenOCD scripts 目录', tools.openocdScripts !== null)
} else {
  skip('探测到 OpenOCD', '本机未安装 OpenOCD')
  skip('定位到 OpenOCD scripts 目录', '本机未安装 OpenOCD')
}
check('探测到 CMake', tools.items.cmake.found)

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

// ---- 多调试器：一个工程同时放 OpenOCD + ST 官方 ST-Link ----
/**
 * 为什么要有这一节：工程里一写 launch.json，VSCode 就不再显示
 * STM32 VS Code Extension 自带的「ST-Link GDB server / J-Link GDB server」，
 * 用户插上 ST-Link 会发现下拉里没有可选项。所以要能把它们补进去。
 */
const multiLaunch = generateLaunch(project, {
  ...options,
  debugTargets: ['probe', 'stlink-gdbserver', 'jlink-gdbserver']
})

check(
  '多调试器：三条配置都生成了',
  multiLaunch.configurations.length === 3,
  multiLaunch.configurations.map((c) => `${c.name}[${c.type}]`).join(' | ')
)
check(
  '多调试器：第一条仍是 cortex-debug（老行为不变）',
  multiLaunch.configurations[0].type === 'cortex-debug' &&
    multiLaunch.configurations[0].name === 'CMSIS-DAP / DAP-Link：烧录并调试',
  `${multiLaunch.configurations[0].name}[${multiLaunch.configurations[0].type}]`
)

/**
 * 名字里必须带探针名。
 *
 * 起因：用户明确要求「不要说 Debug 停在 main，直接说 DAP-Link」。
 * 更要紧的是原理 —— 同时生成了 ST-Link 那条之后，两条都叫「烧录并调试」，
 * 下拉里根本分不出哪条走哪根线，选错就是连不上。
 */
check(
  '探针那条配置名带「DAP-Link」',
  multiLaunch.configurations[0].name.includes('DAP-Link'),
  multiLaunch.configurations[0].name
)
check(
  '两条配置名互不相同（下拉里能分清）',
  new Set(multiLaunch.configurations.map((c) => c.name)).size ===
    multiLaunch.configurations.length,
  multiLaunch.configurations.map((c) => c.name).join(' | ')
)
check(
  'ST-Link 那条名字带 ST-Link',
  multiLaunch.configurations[1].name.includes('ST-Link'),
  multiLaunch.configurations[1].name
)

const stCfg = multiLaunch.configurations.find((c) => c.type === 'stlinkgdbtarget')
check('ST-Link：生成 stlinkgdbtarget 类型', Boolean(stCfg), JSON.stringify(stCfg))
/**
 * deviceName / deviceCore 是 ST 适配器**强校验**的字段：
 * 缺了会直接抛 `Core not found: … verify "deviceCore" attribute`，GDB 起不来。
 */
check('ST-Link：带 deviceName', stCfg?.deviceName === 'STM32F103C8T6', String(stCfg?.deviceName))
check('ST-Link：deviceCore 推导为 Cortex-M3（F1 系列）', stCfg?.deviceCore === 'Cortex-M3', String(stCfg?.deviceCore))
check(
  'ST-Link：preBuild 置空（别去跑 ST 扩展自带构建）',
  stCfg?.preBuild === '',
  `preBuild=${JSON.stringify(stCfg?.preBuild)}`
)
check(
  'ST-Link：preLaunchTask 挂上「构建 Debug」',
  stCfg?.preLaunchTask === '构建 Debug',
  String(stCfg?.preLaunchTask)
)
/**
 * serverExe 绝对不能写绝对路径：ST 适配器是 `switch (serverExe)` 认名字的，
 * 传路径会抛 `Gdb server "…" not known or misspelled`。
 */
check('ST-Link：不写 serverExe 绝对路径', stCfg?.serverExe === undefined, String(stCfg?.serverExe))
check(
  'ST-Link：imagesAndSymbols 指向 Debug 固件',
  Array.isArray(stCfg?.imagesAndSymbols) &&
    String((stCfg?.imagesAndSymbols as Array<{ imageFileName: string }>)[0].imageFileName).endsWith(
      'build/Debug/demo.elf'
    ),
  JSON.stringify(stCfg?.imagesAndSymbols)
)
check(
  'ST-Link：liveWatch 的 samplesPerSecond 是字符串（ST schema 要求）',
  typeof (stCfg?.liveWatch as { samplesPerSecond?: unknown })?.samplesPerSecond === 'string',
  JSON.stringify(stCfg?.liveWatch)
)

const jlCfg = multiLaunch.configurations.find((c) => c.type === 'jlinkgdbtarget')
check('J-Link：生成 jlinkgdbtarget 类型', Boolean(jlCfg), JSON.stringify(jlCfg?.type))
check(
  'J-Link：速度写的是枚举里的值',
  jlCfg?.serverSpeed === undefined || ['1000', '4000'].includes(String(jlCfg?.serverSpeed)),
  String(jlCfg?.serverSpeed)
)

// 脏数据不能把 launch.json 弄成空列表（否则 VSCode 里没有任何可调试项）
const dirtyLaunch = generateLaunch(project, {
  ...options,
  debugTargets: ['不存在', 'probe', 'probe'] as never
})
check(
  '多调试器：非法/重复的目标被清洗成一条',
  dirtyLaunch.configurations.length === 1 && dirtyLaunch.configurations[0].type === 'cortex-debug',
  dirtyLaunch.configurations.map((c) => c.type).join(' | ')
)


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

if (tools.items.openocd.found) {
  check(
    'settings.json 含 cortex-debug.openocdPath.windows',
    typeof bundle.settings['cortex-debug.openocdPath.windows'] === 'string'
  )
  check(
    'settings.json 的路径用正斜杠',
    !String(bundle.settings['cortex-debug.openocdPath.windows'] ?? '').includes('\\')
  )
} else {
  skip('settings.json 含 cortex-debug.openocdPath.windows', '本机未安装 OpenOCD，不会写入该路径')
  skip('settings.json 的路径用正斜杠', '本机未安装 OpenOCD')
}
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
if (tools.items.openocd.found) {
  check(
    '落盘的 settings.json 含 openocd 路径',
    Boolean(settingsOnDisk['cortex-debug.openocdPath.windows'])
  )
} else {
  skip('落盘的 settings.json 含 openocd 路径', '本机未安装 OpenOCD')
}

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

// ==========================================================================
// 3b. 写入失败也要留档
// ==========================================================================
//
// 现场（2026-11-03）：用户工程 .vscode 下 5 个文件全报
//   EPERM: operation not permitted, open '...\launch.json'
// 隔一会儿单独用 Node 写同一个目录又是完全正常的 —— 说明是**瞬时占用**，
// 而当时 writer.ts 是裸 writeFileSync，一次失败就判死。
//
// 另一半原因：文件带只读属性。这一半重试一辈子也救不回来，得先摘只读位。
// 下面两个检查分别覆盖这两件事。

section('3b. 写入失败也要留档（只读文件 / 历史明细）')

const readOnlyFile = join(demo, '.vscode', 'settings.json')
chmodSync(readOnlyFile, 0o444)
const afterReadOnly = writeFiles({ projectRoot: demo, files, backup: false })
check(
  '只读文件也能写进去（先摘掉只读位再写）',
  afterReadOnly.errors.length === 0,
  afterReadOnly.errors.join('; ')
)
check('写完之后文件不是只读状态', (statSync(readOnlyFile).mode & 0o200) !== 0)

// 失败条目长什么样 —— 这是用户「翻历史查原因」时唯一能看到的证据
const failRecord = buildWriteRecord(
  'C:\\proj',
  ['C:\\proj\\.vscode\\launch.json'],
  ['launch.json：EPERM，已重试 9 次 —— 被别的程序（VSCode / 杀毒软件）短暂占用，或文件是只读的'],
  'snap-1'
)
check('失败写入记为 ok:false', failRecord.ok === false)
check('标题里带失败数量', failRecord.title.includes('失败'), failRecord.title)
check(
  '明细里有文件名 + 错误码（不是只有数量）',
  failRecord.detail.includes('launch.json') && failRecord.detail.includes('EPERM'),
  failRecord.detail
)
check(
  '失败条目带「重试写入」按钮，且排在最前',
  failRecord.actions[0]?.kind === 'retry-write',
  failRecord.actions.map((a) => a.kind).join(',')
)
check(
  '失败条目仍保留「还原到这次写入前」',
  failRecord.actions.some((a) => a.kind === 'restore-snapshot')
)

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

// ---- 写盘安全闸：快照存不下就不许写，且要带原因 ----
//
// 这条以前在五个调用点各写一遍，其中两处**没判返回值**（存快照失败照样写/照样删）。
// 现在统一走 openSnapshot，所以这里直接测那个函数。
const gateOk = openSnapshot(snapDemo, snapChanged)
check('安全闸: 正常时放行并给出快照 id', gateOk.ok && Boolean(gateOk.id), gateOk.message)
const gateEmpty = openSnapshot(snapDemo, [])
check('安全闸: 没东西可存时拒绝写', !gateEmpty.ok && gateEmpty.id === null)
check(
  '安全闸: 拒绝时带上真实原因（用户唯一能自救的信息）',
  gateEmpty.message.includes('没有需要快照的文件'),
  gateEmpty.message
)

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
 * 「双调试器」样板。
 *
 * 用户的原话是「直接给我一个两个调试器都有的模板」—— 它的价值就在于
 * **不需要任何额外操作**，选中就同时拿到 OpenOCD 和 ST-Link 两条配置。
 * 这里把这一点钉住：谁敢把 debugTargets 删掉，自检立刻红。
 */
const dualBuiltin = BUILTIN_TEMPLATES.find((t) => t.id.endsWith('dap-link-plus-stlink'))
check('内置模板里有「DAP-Link + ST-Link 双调试器」', Boolean(dualBuiltin), dualBuiltin?.name)
check(
  '双调试器样板：debugTargets 是 probe + stlink-gdbserver',
  JSON.stringify(dualBuiltin?.options.debugTargets) === JSON.stringify(['probe', 'stlink-gdbserver']),
  JSON.stringify(dualBuiltin?.options.debugTargets)
)
check(
  '双调试器样板：探针仍是 CMSIS-DAP（OpenOCD 接线不变）',
  dualBuiltin?.options.probeKey === 'cmsis-dap',
  String(dualBuiltin?.options.probeKey)
)

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
 * 双调试器样板套用后必须真的带上那两条 —— 这条测的是 adaptTemplateOptions
 * 有没有把 debugTargets 当「用户的选择」传下去（它确实在白名单里）。
 */
const adaptedDual = adaptTemplateOptions(dualBuiltin!.options, fakeBase)
check(
  '双调试器样板套用后仍是两条',
  JSON.stringify(adaptedDual.debugTargets) === JSON.stringify(['probe', 'stlink-gdbserver']),
  JSON.stringify(adaptedDual.debugTargets)
)
check(
  '双调试器样板套用后仍不覆盖固件名（和其它模板一致）',
  adaptedDual.elfName === 'demo',
  adaptedDual.elfName
)

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
  '#include "cmsis_os.h"\n/* USER CODE END Header */\n\nvoid MX_FREERTOS_Init(void)\n{\n  /* USER CODE BEGIN RTOS_THREADS */\n  /* USER CODE END RTOS_THREADS */\n}\n'
)
put('Middlewares/rtos/cmsis_os.h', '#pragma once\n')

const vofaPack = loadPack('vofa')

/**
 * 按 render 类型取模板名。
 *
 * 自检里不重写一份 'vofa_config.h.tpl'：如果这么写，pack.json 改了模板名
 * 自检还是绿的，等于没测。这里跟主进程走同一条路径 —— 由清单声明。
 */
function tplOf(kind: 'config' | 'bind'): string {
  const spec = vofaPack?.generated.find((g) => g.render === kind)
  if (!spec) throw new Error(`vofa 包的 generated 里没有 render=${kind} 的项`)
  return spec.template
}

check('Pack: 能装载 vofa 包', vofaPack !== null && (vofaPack?.files.length ?? 0) > 0)
check(
  'Pack: 包列表包含 vofa',
  listPacks().some((p) => p.id === 'vofa'),
  listPacks()
    .map((p) => p.id)
    .join(',')
)

// ---- 生成文件必须由清单声明用哪个渲染器（以前靠模板名里有没有 'config' 猜）----
for (const brief of listPacks()) {
  const m = loadPack(brief.id)
  if (!m) continue
  for (const g of m.generated) {
    check(
      `Pack: ${m.id}/${g.template} 声明了合法 render`,
      g.render === 'config' || g.render === 'bind',
      String(g.render)
    )
    check(
      `Pack: ${m.id}/${g.template} 模板文件真实存在`,
      readPackFile(m.id, g.template) !== null
    )
  }
}

// 缺 render 时必须报错，不能猜 —— 猜错会把变量表塞进绑定模板，写出编译不过的 .c
let noRenderErr = ''
try {
  renderGenerated(
    vofaPack!,
    { template: 'vofa_config.h.tpl', to: 'x.h' } as never,
    { params: {}, bindings: { pids: [], channels: [] } },
    inspectProject(packRoot)
  )
} catch (err) {
  noRenderErr = err instanceof Error ? err.message : String(err)
}
check(
  'Pack: 清单缺 render 时直接报错（不猜渲染器）',
  noRenderErr.includes('没写 render'),
  noRenderErr
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
  const cfg = renderConfig(vofaPack, tplOf('config'), { ...compat.derived, sendHz: 50 }, facts)
  check('生成: RX_MODE=2（逐字节中断）', /#define VOFA_RX_MODE\s+2/.test(cfg))
  check('生成: USE_BUILTIN_IRQ=1', /#define VOFA_USE_BUILTIN_IRQ\s+1/.test(cfg))
  check(
    '生成: TX 头文件是 bsp_usart.h（不是自己 include 自己）',
    /#define VOFA_TX_HEADER\s+"bsp_usart\.h"/.test(cfg),
    cfg.match(/VOFA_TX_HEADER.*/)?.[0]
  )
  const bind = renderBind(vofaPack, tplOf('bind'), bindings, facts)
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
  /**
   * bug 回归：模板里新增了 ${EXTERN_DECLS}，但运行中的主进程还是旧代码，
   * 于是生成的 .c 里留下一行占位符，gcc 报「expected '=', ',', ';' before '{'」，
   * 完全看不出是生成器版本对不上。现在渲染器发现残留就抛错中止写入。
   */
  check(
    '生成: 不留任何未替换的占位符',
    !/\$\{[A-Z_0-9]+\}/.test(cfg) && !/\$\{[A-Z_0-9]+\}/.test(bind),
    (cfg + bind).match(/\$\{[A-Z_0-9]+\}/g)?.join('、')
  )

  // ---- 写入 ----
  const apply = applyPackCore(plan)
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
// 11b. 信号目录 / 映射表 / 动态串口 / 回调冲突
// ==========================================================================

section('11b. 信号目录 / 映射表 / 动态串口 / 回调冲突')

const symRoot = join(sandbox, 'symbol-proj')
const sput = (rel: string, body: string): void => {
  const p = join(symRoot, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, 'utf8')
}

sput(
  'CMakeLists.txt',
  `cmake_minimum_required(VERSION 3.22)
project(symdemo C CXX ASM)
add_executable(\${CMAKE_PROJECT_NAME})
target_sources(\${CMAKE_PROJECT_NAME} PRIVATE
    Src/freertos.c
)
`
)
sput('Inc/main.h', '#pragma once\n#include "stm32f4xx_hal.h"\n')
sput('Inc/usart.h', '#pragma once\n#include "main.h"\nextern UART_HandleTypeDef huart3;\n')
sput(
  'Src/usart.c',
  '#include "usart.h"\nUART_HandleTypeDef huart3;\nDMA_HandleTypeDef hdma_usart3_tx;\n'
)
sput(
  'bsp/bsp_usart.h',
  '#pragma once\n#include <stdint.h>\nextern void usart3_tx_dma_enable(uint8_t *data, uint16_t len);\n'
)
sput(
  'application/pid.h',
  '#pragma once\ntypedef struct { float Kp, Ki, Kd, max_out, max_iout; } pid_type_def;\n'
)
sput(
  'application/gimbal_task.h',
  `#pragma once
#include "pid.h"
typedef struct gimbal_motor {
    pid_type_def gyro_pid;
    float absolute_angle;
    struct gimbal_motor *child;
} gimbal_motor_t;
extern const gimbal_motor_t *get_yaw_motor_point(void);
`
)
sput(
  'application/remote_control.h',
  `#pragma once
#include <stdint.h>
typedef struct {
    struct {
        int16_t ch[5];
    } rc;
} RC_ctrl_t;
extern const RC_ctrl_t *get_remote_control_point(void);
`
)
sput(
  'application/remote_control.c',
  `#include "remote_control.h"
void HAL_UARTEx_RxEventCallback(void *huart, unsigned short Size)
{
    (void)huart;
    (void)Size;
}
`
)
sput('application/globals.h', '#pragma once\nextern float global_vx;\nextern int16_t global_mode;\n')
sput(
  'application/globals.c',
  `#include "globals.h"
float global_vx;
int16_t global_mode;

/* 只在 .c 里定义、头文件没写 extern —— 扫描要能扫到，并自己补声明 */
float only_in_c = 1.5f;
float only_in_c2[3];

/* 文件私有：能看见，但不能绑（别的编译单元取不到地址） */
static pid_type_def file_pid;

void SomeInit(void)
{
    pid_type_def local_pid;
    (void)local_pid;
}
`
)
sput(
  'Src/freertos.c',
  '#include "cmsis_os.h"\n/* USER CODE END Header */\n\nvoid MX_FREERTOS_Init(void)\n{\n  /* USER CODE BEGIN RTOS_THREADS */\n  /* USER CODE END RTOS_THREADS */\n}\n'
)
sput('Middlewares/rtos/cmsis_os.h', '#pragma once\n')

const symFacts = inspectProject(symRoot)
const symCompat = checkPackCompat(vofaPack!, symRoot, symFacts)

check(
  '符号: 没有默认 huart1 时自动改用工程里的 huart3',
  symCompat.derived.uart === 'huart3' && symCompat.uarts.some((u) => u.name === 'huart3'),
  String(symCompat.derived.uart)
)
check(
  '符号: 工程已有 HAL_UARTEx_RxEventCallback 时自动改逐字节中断',
  symCompat.derived.rxMode === 'it',
  String(symCompat.derived.rxMode)
)
check(
  '符号: 合成工程不阻塞',
  !symCompat.blocked,
  JSON.stringify(symCompat.checks.filter((c) => c.level === 'err'))
)

const symScan = scanSymbols(symRoot)
const symFlat = symScan.flat
const kp = symFlat.find((n) => n.path.endsWith('gyro_pid.Kp'))
const angle = symFlat.find((n) => n.path.endsWith('absolute_angle'))
const rc0 = symFlat.find((n) => n.path.endsWith('rc.ch[0]'))
const vx = symFlat.find((n) => n.name === 'global_vx')
const pidNode = symFlat.find((n) => n.valueType === 'pid' && n.pidType === 'pid_type_def')

check(
  '符号: 扫到 PID 字段 Kp 及完整表达式',
  Boolean(kp && kp.expr === 'get_yaw_motor_point()->gyro_pid.Kp'),
  kp?.expr
)
check(
  '符号: 扫到 float 成员（const 访问器下只能看）',
  angle?.valueType === 'float' && angle?.access === 'watch',
  `${angle?.valueType}/${angle?.access}`
)
check(
  '符号: 匿名 struct 里的遥控数组也能展开',
  rc0?.valueType === 'int' && rc0?.expr === 'get_remote_control_point()->rc.ch[0]',
  rc0?.expr
)
check('符号: 全局 float 可看可调', vx?.access === 'both', String(vx?.access))

// ---- 只认 extern 的时代：这两个变量以前根本扫不到 ----
const onlyInC = symScan.tree.find((n) => n.name === 'only_in_c')
const onlyInC2 = symScan.tree.find((n) => n.name === 'only_in_c2')
check(
  '符号: .c 里定义、头文件没写 extern 的变量也能扫到',
  Boolean(onlyInC && onlyInC.valueType === 'float'),
  `${onlyInC?.valueType}/${onlyInC?.file}:${onlyInC?.line}`
)
check(
  '符号: 这类变量会带上自动补的 extern 声明',
  onlyInC?.externDecl === 'extern float only_in_c;',
  onlyInC?.externDecl
)
check(
  '符号: 数组定义也能补声明（保留维度）',
  onlyInC2?.externDecl === 'extern float only_in_c2[3];',
  onlyInC2?.externDecl
)
check(
  '符号: 头文件已声明 extern 的不再重复补（走 include 更干净）',
  vx !== undefined && vx.externDecl === undefined && vx.include,
  `${vx?.externDecl} / include=${vx?.include}`
)
check(
  '符号: static 变量单独归到 statics，且不可绑定',
  symScan.statics.some((n) => n.name === 'file_pid' && n.access === 'none'),
  String(symScan.statics.length)
)
check(
  '符号: static 变量名不会混进可绑定树',
  !symScan.tree.some((n) => n.name === 'file_pid')
)
check(
  '符号: 链接脚本符号被过滤掉',
  !symScan.tree.some((n) => n.name === '_estack' || n.name === '_Min_Stack_Size')
)
check('符号: PID 识别为 tune 组', pidNode?.access === 'tune' && pidNode?.pidType === 'pid_type_def')
check(
  '符号: 函数内变量被标记为不可绑定',
  symScan.locals.some((n) => n.name === 'local_pid' && n.access === 'none')
)

const symBindings = [
  {
    id: 'a',
    name: 'yaw_gyro',
    expr: 'get_yaw_motor_point()->gyro_pid',
    type: 'pid_type_def',
    valueType: 'pid' as const,
    access: 'tune' as const,
    guard: 'get_yaw_motor_point()',
    source: 'scan' as const,
    pidType: 'pid_type_def' as const,
    fields: ['Kp', 'Ki', 'Kd', 'max_out', 'max_iout']
  },
  {
    id: 'b',
    name: 'yaw_angle',
    expr: 'get_yaw_motor_point()->absolute_angle',
    type: 'float',
    valueType: 'float' as const,
    access: 'watch' as const,
    guard: 'get_yaw_motor_point()',
    source: 'scan' as const
  },
  {
    id: 'c',
    name: 'rc_ch0',
    expr: 'get_remote_control_point()->rc.ch[0]',
    type: 'int16_t',
    valueType: 'int' as const,
    access: 'watch' as const,
    guard: 'get_remote_control_point()',
    source: 'scan' as const
  },
  {
    id: 'd',
    name: 'global_vx_tune',
    expr: 'global_vx',
    type: 'float',
    valueType: 'float' as const,
    access: 'tune' as const,
    source: 'scan' as const
  }
]
const symMap = {
  version: 1 as const,
  packId: 'vofa' as const,
  updatedAt: 1,
  bindings: symBindings,
  params: {
    uart: 'huart3',
    sendHz: 50,
    rxMode: 'it',
    builtinIrq: true,
    irqPriority: 5,
    txFn: 'usart3_tx_dma_enable',
    txHeader: 'bsp_usart.h',
    txDma: 'hdma_usart3_tx'
  }
}
const symPb = mapToPackBindings(symMap)
check(
  '映射: PID / 通道 / 单值参数分流正确',
  symPb.pids.length === 1 && symPb.channels.length === 2 && (symPb.params?.length ?? 0) === 1,
  `pids=${symPb.pids.length} channels=${symPb.channels.length} params=${symPb.params?.length ?? 0}`
)
const symBind = renderBind(vofaPack!, tplOf('bind'), symPb, symFacts)
check(
  '映射: 单值可调生成 vofa_reg_param',
  symBind.includes('vofa_reg_param("global_vx_tune"'),
  symBind.slice(0, 200)
)
check(
  '映射: 非 float 通道生成镜像',
  symBind.includes('static fp32 vofa_mirror_') &&
    symBind.includes('get_remote_control_point()->rc.ch[0]')
)

// ---- 生成层：头文件没写 extern 的变量，绑定代码要自己补声明 ----
const noDeclNode = symScan.tree.find((n) => n.name === 'only_in_c')
const noDeclBind = renderBind(
  vofaPack!,
  tplOf('bind'),
  mapToPackBindings({
    version: 1,
    packId: 'vofa',
    updatedAt: 0,
    bindings: noDeclNode ? [bindingFromSymbol(noDeclNode, 'tune', [])] : []
  }),
  symFacts
)
check(
  '生成: 头文件没声明的变量，vofa_bind.c 自己补 extern（用户不用改源码）',
  noDeclBind.includes('extern float only_in_c;'),
  noDeclBind.split('\n').filter((l) => /^\s*extern\s/.test(l)).join(' | ')
)
check(
  '生成: 补的声明在注册之前（否则编译报未声明）',
  noDeclBind.indexOf('extern float only_in_c;') < noDeclBind.indexOf('vofa_reg_param("only_in_c"'),
  '顺序检查'
)

const savedMap = saveVofaMap(symRoot, symMap)
check(
  '映射: 能写进 application/vofa/vofa_map.json',
  savedMap.ok && Boolean(vofaMapPath(symRoot)),
  savedMap.error
)
const loadedMap = loadVofaMap(symRoot)
check('映射: 能原样读回', loadedMap?.bindings.length === 4 && loadedMap?.params?.uart === 'huart3')

const symCfg = renderConfig(vofaPack!, tplOf('config'), symMap.params, symFacts)
check('生成: 串口跟参数走（huart3）', /#define VOFA_UART\s+huart3/.test(symCfg))
check('生成: TX 函数跟参数走', /#define VOFA_TX_FN\(data, len\)\s+usart3_tx_dma_enable/.test(symCfg))
let badHz = false
try {
  renderConfig(vofaPack!, tplOf('config'), { ...symMap.params, sendHz: 0 }, symFacts)
} catch {
  badHz = true
}
check('生成: sendHz=0 被拦下', badHz)

const symPlan = planPackInstall(
  {
    packId: 'vofa',
    root: symRoot,
    params: symMap.params,
    bindings: symPb,
    map: symMap
  },
  symFacts
)
check(
  '清单: 映射表进入改动清单',
  symPlan.changes.some((c) => c.path === 'application/vofa/vofa_map.json')
)
check(
  '清单: 不阻塞',
  !symPlan.blocked,
  JSON.stringify(symPlan.changes.filter((c) => c.action === 'skip'))
)
const symApply = applyPackCore(symPlan)
check('写入: 模块 + 映射表成功', symApply.ok, symApply.errors.join(';'))
const freel = readFileSync(join(symRoot, 'Src/freertos.c'), 'utf8')
check('写入: freertos.c 补了 extern 声明', freel.includes('extern void vofa_task'))
check('写入: freertos.c 在 RTOS_THREADS 里创建任务', freel.includes('osThreadCreate(osThread(vofa)'))
/*
  extern 声明必须在 USER CODE 区内。写进 #include 区的话，CubeMX 下次
  重新生成 freertos.c 会把它一起抹掉 —— 任务创建还在、声明没了，编译直接报错，
  而且报错信息跟 CubeMX 完全看不出关系。
*/
check(
  '写入: extern 声明在 USER CODE 区内（CubeMX 重新生成不会抹掉）',
  freel.indexOf('extern void vofa_task') > freel.indexOf('/* USER CODE BEGIN RTOS_THREADS */')
)
check('写入: 映射表落盘', existsSync(join(symRoot, 'application/vofa/vofa_map.json')))
if (symApply.snapshotId) {
  const symBack = restoreSnapshot(symRoot, symApply.snapshotId)
  check(
    '还原: 信号工程回到原样（映射表回到写入前的那份）',
    symBack.errors.length === 0 &&
      !existsSync(join(symRoot, 'application/vofa/vofa_task.c')) &&
      loadVofaMap(symRoot)?.bindings.length === 4
  )
}

// 回调冲突：工程里同时有 RxEvent 和 RxCplt 时不能再装
sput('application/conflict.c', 'void HAL_UART_RxCpltCallback(void *huart) { (void)huart; }\n')
const conflictFacts = inspectProject(symRoot)
const conflictCompat = checkPackCompat(vofaPack!, symRoot, conflictFacts)
check('兼容性: 两个 HAL 回调都被占用时阻塞', conflictCompat.blocked)

// CMSIS-OS v2：不支持 osThreadDef，必须明确阻塞
sput('Middlewares/rtos/cmsis_os.h', '#pragma once\nvoid osThreadNew(void);\n')
const v2Facts = inspectProject(symRoot)
const v2Compat = checkPackCompat(vofaPack!, symRoot, v2Facts)
check(
  '兼容性: CMSIS-OS v2 阻塞并说明原因',
  v2Compat.blocked && v2Compat.checks.some((c) => c.label === 'CMSIS-OS 版本')
)

// ==========================================================================
// 12. 构建图：include() / add_subdirectory() / 变量 / GLOB
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

// ---- 改名必须同步更新 .vscode 里已经写进去的 ELF 名 ----
//
// 这是一个真实翻过的车：先写了 .vscode（当时 CMake 名是 old_name，所以 launch.json
// 里是 old_name.elf，当时是对的），后来改名只改了 CMakeLists 和 .ioc，
// 结果 launch.json / tasks.json 还指向不存在的 old_name.elf —— F5 报找不到文件、
// 烧录任务也失败，而且看起来像 CMake 的问题，很难查。
const rn2Root = join(sandbox, 'rename-vscode')
mkdirSync(join(rn2Root, '.vscode'), { recursive: true })
writeFileSync(
  join(rn2Root, 'CMakeLists.txt'),
  'set(CMAKE_PROJECT_NAME old_name)\nproject(${CMAKE_PROJECT_NAME})\nadd_executable(${CMAKE_PROJECT_NAME})\n',
  'utf8'
)
writeFileSync(
  join(rn2Root, '.vscode', 'launch.json'),
  JSON.stringify(
    {
      version: '0.2.0',
      configurations: [
        {
          name: 'Debug',
          type: 'cortex-debug',
          executable: '${workspaceFolder}/build/Debug/old_name.elf',
          preLaunchTask: '构建 Debug'
        }
      ]
    },
    null,
    4
  ),
  'utf8'
)
writeFileSync(
  join(rn2Root, '.vscode', 'tasks.json'),
  JSON.stringify(
    {
      version: '2.0.0',
      tasks: [
        {
          label: '烧录',
          type: 'shell',
          args: ['program {${workspaceFolder}/build/Debug/old_name.elf} verify reset exit']
        }
      ]
    },
    null,
    4
  ),
  'utf8'
)

const rn2Plan = planProjectRename(rn2Root, 'new-name', false)
check(
  '改名: 计划里包含 .vscode/launch.json 和 tasks.json 的更新',
  rn2Plan.changes.some((c) => c.path === '.vscode/launch.json' && c.action === 'patch') &&
    rn2Plan.changes.some((c) => c.path === '.vscode/tasks.json' && c.action === 'patch'),
  rn2Plan.changes.map((c) => `${c.action}:${c.path}`).join(' ')
)
const rn2Apply = applyProjectRename(rn2Plan)
check('改名: .vscode 更新写入成功', rn2Apply.ok, rn2Apply.errors.join(';'))
check(
  '改名: launch.json / tasks.json 里不再有旧 ELF 名',
  !readFileSync(join(rn2Root, '.vscode', 'launch.json'), 'utf8').includes('old_name.elf') &&
    !readFileSync(join(rn2Root, '.vscode', 'tasks.json'), 'utf8').includes('old_name.elf') &&
    readFileSync(join(rn2Root, '.vscode', 'launch.json'), 'utf8').includes('new-name.elf') &&
    readFileSync(join(rn2Root, '.vscode', 'tasks.json'), 'utf8').includes('new-name.elf')
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
// 15. Live Watch：不停机看全局变量
//
// cortex-debug 1.12 起提供，靠 launch.json 的 liveWatch 打开；
// 只对 openocd / stlink / jlink 生效（PyOCD 不支持，塞进去是无效字段）。
// ==========================================================================

section('15. Live Watch 生成')

// 合成工程本身没有 .ioc / 设备，会被判成「非嵌入式」→ 生成 cppdbg 配置，
// 而 Live Watch 只存在于 cortex-debug 的嵌入式配置里。
// generateLaunch 的条件是 `project.isEmbedded && o.device`，所以两个都要给足。
const lwProject = { ...scanProject(join(sandbox, 'pack-proj'), false), isEmbedded: true }
const lwBase = {
  ...defaultGenOptions(lwProject, detectTools({}), DEFAULT_SETTINGS),
  device: 'STM32F407IGH6'
}
const lwOf = (o: Record<string, unknown>): unknown => {
  const cfg = generateLaunch(lwProject, { ...lwBase, ...(o as object) } as typeof lwBase)
  return (cfg.configurations[0] as Record<string, unknown>).liveWatch
}

check('LiveWatch: 关闭时不写这个字段', lwOf({ liveWatch: false }) === undefined)
check(
  'LiveWatch: 打开后是 {enabled:true, samplesPerSecond:4}',
  JSON.stringify(lwOf({ liveWatch: true, liveWatchSamplesPerSecond: 4 })) ===
    '{"enabled":true,"samplesPerSecond":4}',
  JSON.stringify(lwOf({ liveWatch: true, liveWatchSamplesPerSecond: 4 }))
)
check(
  'LiveWatch: 采样率超上限 20 会被夹住',
  (lwOf({ liveWatch: true, liveWatchSamplesPerSecond: 50 }) as { samplesPerSecond: number } | undefined)
    ?.samplesPerSecond === 20
)
check(
  'LiveWatch: 负数采样率被夹到 0',
  (lwOf({ liveWatch: true, liveWatchSamplesPerSecond: -5 }) as { samplesPerSecond: number } | undefined)
    ?.samplesPerSecond === 0
)
check(
  'LiveWatch: PyOCD 探针不支持，不写这个字段',
  lwOf({ liveWatch: true, probeKey: 'pyocd' }) === undefined
)

// 默认值 —— 用户要求默认开启。这两个断言防止以后有人手滑改回 false。
check('LiveWatch: 默认设置里是开启的', DEFAULT_SETTINGS.liveWatch === true)
check(
  'LiveWatch: 设置缺字段时按开启处理（老 settings.json 兼容）',
  JSON.stringify(lwOf({} as Record<string, unknown>)) === '{"enabled":true,"samplesPerSecond":4}',
  'defaultGenOptions 没有把默认值带进来'
)

// ==========================================================================
// 汇总
// ==========================================================================

rmSync(sandbox, { recursive: true, force: true })

// ==========================================================================
// 16. 模板导入 / 导出的格式约定
//
// 导出写成 { format, version, exportedAt, template } 而不是裸模板对象；
// 导入要同时认「带包装的」和「裸模板」（兼容手写的文件）。
// 这段逻辑在 ipc.ts 里，没法直接调（依赖 electron），所以这里测同一套判定。
// ==========================================================================

section('16. 模板导入 / 导出格式')

/*
 * 早期这里自己复刻了一份解析逻辑（当时解析写在 ipc.ts 里、依赖 electron 调不动）。
 * 现在解析已经抽到 `shared/templateFormat.ts`，是纯函数，直接调真的那份 ——
 * 复刻版留着只会和真实现渐渐分叉，测了半天测的是假货。
 */

const sampleTpl = {
  id: 'abc',
  name: '测试模板',
  note: '说明',
  createdAt: 1,
  updatedAt: 1,
  target: { editor: 'vscode' },
  options: { device: 'STM32F407IGH6' }
}

/** 便捷包装：解析出第一个工程配置模板，没有就 null */
function parseFirstProject(raw: string): { name?: string } | null {
  const p = parseTemplateFile(raw)
  return p.projectTemplates[0] ?? null
}

check(
  '模板导入：认带 format 包装的文件',
  parseFirstProject(JSON.stringify({ format: 'cv-studio-template', version: 1, template: sampleTpl }))
    ?.name === '测试模板'
)
check(
  '模板导入：也认裸模板（兼容手写文件）',
  parseFirstProject(JSON.stringify(sampleTpl))?.name === '测试模板'
)
check('模板导入：缺 target 的文件被拒绝', parseFirstProject(JSON.stringify({ name: 'x' })) === null)
check('模板导入：非 JSON 被拒绝', parseFirstProject('not json at all') === null)
check(
  '模板导入：空 options 也能进（老模板可能没填参数）',
  (() => {
    const t = parseTemplateFile(JSON.stringify({ target: {}, options: {} }))
    return t !== null
  })()
)

// ==========================================================================
// ==========================================================================
// 17. 模板文件格式（统一格式 · 多模板混装 · 向后兼容）
//
// 真实场景：用户把「一整套调好的东西」导成一个文件发给队友 ——
// 里面既有工程配置模板，也有模块包参数。导入时要按 kind 自动分流。
// ==========================================================================

{
  section('17. 模板文件格式')

  const sampleProject = {
    name: '标准步兵',
    note: 'F407',
    target: { editor: 'vscode', buildSystem: 'cmake', probe: 'cmsis-dap' },
    options: { device: 'STM32F407IGH6' },
    files: { launch: '{}' }
  }
  const samplePreset = {
    packId: 'remote-vt13',
    name: '标准步兵-VT13',
    note: 'USART1',
    params: { usart: 'USART1', demoMode: false }
  }

  // ---- 新格式：混装 ----
  {
    const file = buildTemplateFile([sampleProject as never], [samplePreset as never])
    const raw = JSON.stringify(file)
    const tplParsed = parseTemplateFile(raw)

    check('模板文件: 新格式识别为 v1', tplParsed.format === 'v1', tplParsed.format)
    check('模板文件: 工程配置模板解析出 1 条', tplParsed.projectTemplates.length === 1)
    check('模板文件: 模块包模板解析出 1 条', tplParsed.packPresets.length === 1)
    check('模板文件: 没有跳过任何条目', tplParsed.skipped === 0)
    check(
      '模板文件: 工程模板名字正确',
      tplParsed.projectTemplates[0]?.name === '标准步兵',
      tplParsed.projectTemplates[0]?.name
    )
    check(
      '模板文件: 模块包模板 packId 正确',
      tplParsed.packPresets[0]?.packId === 'remote-vt13',
      tplParsed.packPresets[0]?.packId
    )
    check('模板文件: params 完整保留', tplParsed.packPresets[0]?.params['usart'] === 'USART1')
    check(
      '模板文件: 导入时清了 id（会生成新的，不覆盖本地）',
      tplParsed.projectTemplates[0]?.id === '' && tplParsed.packPresets[0]?.id === ''
    )
  }

  // ---- 旧格式兼容 ----
  {
    const legacy = JSON.stringify({
      format: 'cv-studio-template',
      version: 1,
      template: sampleProject
    })
    const tplParsed = parseTemplateFile(legacy)
    check('模板文件: 旧单模板格式仍能导入', tplParsed.format === 'legacy', tplParsed.format)
    check('模板文件: 旧格式解析出 1 条', tplParsed.projectTemplates.length === 1)
  }

  // ---- 裸对象 ----
  {
    const bareProject = parseTemplateFile(JSON.stringify(sampleProject))
    check('模板文件: 裸工程模板对象能识别', bareProject.projectTemplates.length === 1)

    const barePreset = parseTemplateFile(JSON.stringify(samplePreset))
    check('模板文件: 裸模块包模板对象能识别', barePreset.packPresets.length === 1)
  }

  // ---- 坏输入 ----
  {
    check('模板文件: 非 JSON 返回空', parseTemplateFile('not json').projectTemplates.length === 0)
    check('模板文件: 空数组返回空', parseTemplateFile('[]').skipped === 1)

    // 混进一条坏的，好的照样能进
    const mixed = JSON.stringify({
      format: 'cv-studio-templates',
      version: 1,
      entries: [
        { kind: 'project', template: sampleProject },
        { kind: 'pack', preset: { name: '缺 packId', params: {} } }, // 坏
        { kind: 'unknown-kind' }, // 坏
        { kind: 'pack', preset: samplePreset }
      ]
    })
    const tplParsed = parseTemplateFile(mixed)
    check(
      '模板文件: 坏条目只跳过自己，不连累其它',
      tplParsed.projectTemplates.length === 1 && tplParsed.packPresets.length === 1
    )
    check('模板文件: 跳过数统计正确', tplParsed.skipped === 2, `实际 ${tplParsed.skipped}`)
  }

  // ---- 格式说明 ----
  {
    check('格式说明: 包含 format 字段名', TEMPLATE_FORMAT_DOC.includes('cv-studio-templates'))
    check(
      '格式说明: 说明 kind 两种取值',
      TEMPLATE_FORMAT_DOC.includes('"project"') && TEMPLATE_FORMAT_DOC.includes('"pack"')
    )
    check(
      '格式说明: 有示例代码块',
      TEMPLATE_FORMAT_DOC.includes('```') || TEMPLATE_FORMAT_DOC.includes('{\n')
    )
    check('格式说明: 提到 packId 必须已安装', TEMPLATE_FORMAT_DOC.includes('packId'))
  }
} // end 17

// ==========================================================================
// 18. 模块包内置模板
//
// 每个包在 pack.json 里自带几套默认配置，用户另存的与它们并列。
// 内置的不可删改（想改就另存一份）。
// ==========================================================================

{
  section('18. 模块包内置模板')

  const allBuiltin = listBuiltinPackPresets()
  check('内置模板: 至少有一个模块包带了默认模板', allBuiltin.length > 0, `共 ${allBuiltin.length} 个`)

  const vt13Builtin = listBuiltinPackPresets('remote-vt13')
  check('内置模板: VT13 自带至少 1 个', vt13Builtin.length >= 1, `共 ${vt13Builtin.length} 个`)

  const vofaBuiltin = listBuiltinPackPresets('vofa')
  check('内置模板: VOFA 自带至少 1 个', vofaBuiltin.length >= 1, `共 ${vofaBuiltin.length} 个`)

  check(
    '内置模板: 所有内置模板都标了 builtin',
    allBuiltin.every((p) => p.builtin === true)
  )
  check(
    '内置模板: id 都带 __builtin__ 前缀',
    allBuiltin.every((p) => isBuiltinPresetId(p.id))
  )
  check('内置模板: id 不重复', new Set(allBuiltin.map((p) => p.id)).size === allBuiltin.length)
  check(
    '内置模板: 都归属到真实的模块包',
    allBuiltin.every((p) => p.packId === 'remote-vt13' || p.packId === 'vofa')
  )
  check(
    '内置模板: 参数非空',
    allBuiltin.every((p) => Object.keys(p.params).length > 0)
  )
  check(
    '内置模板: VT13 有一个「跳过 CubeMX」的选项',
    vt13Builtin.some((p) => p.params['demoMode'] === true)
  )
  check('内置模板: isBuiltinPresetId 能区分用户模板', !isBuiltinPresetId('a1b2c3d4-user-made'))
}

// ==========================================================================
// 19. 快照降级：应用数据目录写不进时改存工程目录
//
// 起因：用户的机器上 userData 目录写不进（EPERM），移植流程第一步就卡死。
// 快照的意义是「改坏了能回去」，换个地方存照样能回去 —— 不该让整条流程报废。
// ==========================================================================

{
  section('19. 快照降级')

  const fbRoot = join(tmpdir(), `cv-fallback-${Date.now()}`)
  mkdirSync(fbRoot, { recursive: true })

  // 把主位置指到一个不存在的盘符，模拟「userData 写不进去」
  configureSnapshots('Z:\\definitely-no-such-drive\\snapshots')

  const r1 = captureSnapshotDetailed(fbRoot, [{ relativePath: 'a.c', previous: 'old' }])
  check('快照降级: 主目录写不进时仍能存下', r1.id !== null, r1.error)
  check('快照降级: 标出了走了降级路径', r1.usedFallback === true)

  const fallbackDir = join(fbRoot, '.cvstudio-snapshots')
  check('快照降级: 存到工程下的 .cvstudio-snapshots', existsSync(fallbackDir))

  const listed = listSnapshots(fbRoot)
  check('快照降级: 列表能找到降级存的快照', listed.length === 1, `共 ${listed.length} 条`)

  if (r1.id) {
    const restored = restoreSnapshot(fbRoot, r1.id)
    check('快照降级: 能从降级位置还原', restored.errors.length === 0, restored.errors.join('; '))
    check('快照降级: 还原写出了文件', restored.restored.length === 1)
    check(
      '快照降级: 还原内容正确',
      existsSync(join(fbRoot, 'a.c')) && readFileSync(join(fbRoot, 'a.c'), 'utf8') === 'old'
    )
  }

  // 恢复配置，免得影响后面的用例
  configureSnapshots(join(fbRoot, 'normal'))
  const r2 = captureSnapshotDetailed(fbRoot, [{ relativePath: 'b.c', previous: 'x' }])
  check('快照降级: 主目录可用时走主路径', r2.id !== null && r2.usedFallback === false)

  /*
   * 降级位置不止一个：实测有的环境连**工程目录**都写不进去
   * （mkdir 就 EPERM），所以要往后继续退 —— 工程上一级、临时目录。
   * 这里检查「读取侧」也覆盖了同样的几个位置，否则会出现
   * 「存进去了但列表看不到」。
   */
  const fb2 = join(tmpdir(), `cv-fallback2-${Date.now()}`)
  const proj2 = join(fb2, 'proj')
  mkdirSync(proj2, { recursive: true })

  // 主位置和工程目录都不可写 → 应该退到「工程上一级」
  configureSnapshots('Z:\\no-such\\snapshots')
  chmodSync(proj2, 0o555) // 让工程目录不可写（在 Windows 上不一定生效，所以不 assert 结果）
  const r3 = captureSnapshotDetailed(proj2, [{ relativePath: 'c.c', previous: 'y' }])
  check('快照降级: 多级降级仍能存下', r3.id !== null, r3.error)
  if (r3.id) {
    const l3 = listSnapshots(proj2)
    check(
      '快照降级: 多级降级后列表能找到',
      l3.some((m) => m.id === r3.id)
    )
  }
  try {
    chmodSync(proj2, 0o755)
  } catch {
    /* Windows 上忽略 */
  }
  rmSync(fb2, { recursive: true, force: true })

  rmSync(fbRoot, { recursive: true, force: true })
}

// ==========================================================================

// ==========================================================================
// 20. 版本比较（更新检测要用）
// ==========================================================================

{
  section('20. 版本比较')

  check('版本比较: 2.0.0 > 1.9.9', compareVersion('2.0.0', '1.9.9') > 0)
  check('版本比较: 1.9.9 < 2.0.0', compareVersion('1.9.9', '2.0.0') < 0)
  check('版本比较: 相同版本返回 0', compareVersion('2.0.0', '2.0.0') === 0)

  /*
   * 这一条是关键 —— 按字符串比会得出 '2.0.10' < '2.0.9' 的错误结论。
   */
  check('版本比较: 2.0.10 > 2.0.9（不能按字符串比）', compareVersion('2.0.10', '2.0.9') > 0)

  check('版本比较: 忽略 v 前缀', compareVersion('v2.1.0', '2.0.0') > 0)
  check('版本比较: 忽略预发布后缀', compareVersion('2.0.0-beta', '2.0.0') === 0)
  check('版本比较: 段数不同时短的补零', compareVersion('2.1', '2.1.0') === 0)
}

// ==========================================================================
// 21. 地址表：ELF 符号 -> 地址 -> 固件命令
// ==========================================================================
//
// 这条路的正确性没法靠「跑一遍界面」验证，必须在这一层把字节级的东西钉死：
//   · 符号表解析（偏移错了全盘错，而且界面上看起来还挺像）
//   · 生成的下发命令串（固件按空格分词，多一个空格、少一个 0x 都会静默失败）
//   · 两处常量（ADDR_SLOT_MAX / VOFA_ADDR_SLOT_MAX）必须一致

{
  section('21. 地址表：ELF 符号解析 / 下发命令')

  /** 拼一个最小的 ELF32 小端：只有 .shstrtab / .symtab / .strtab / .data / .bss */
  const buildElf = (
    syms: Array<{ name: string; addr: number; size: number; type: number; bind: number; shndx: number }>
  ): Buffer => {
    const secNames = ['', '.data', '.bss', '.symtab', '.strtab', '.shstrtab']
    let shstr = ''
    const shstrOff: number[] = []
    for (const n of secNames) {
      shstrOff.push(shstr.length)
      shstr += `${n}\0`
    }

    let strtab = '\0'
    const symNameOff: number[] = []
    for (const s of syms) {
      symNameOff.push(strtab.length)
      strtab += `${s.name}\0`
    }

    const symtabSize = 16 * (syms.length + 1)
    const strtabBuf = Buffer.from(strtab, 'latin1')
    const shstrBuf = Buffer.from(shstr, 'latin1')
    const shstrtabSize = shstrBuf.length

    // 内容排布：ehdr | .data | .strtab | .symtab | .shstrtab | 节头表
    const ehsize = 52
    const dataOff = ehsize
    const strtabOff = dataOff + 16
    const symtabOff = strtabOff + strtabBuf.length
    const shstrOff2 = symtabOff + symtabSize
    const shoff = (shstrOff2 + shstrtabSize + 3) & ~3

    const buf = Buffer.alloc(shoff + 40 * secNames.length)

    // ---- ELF 头 ----
    buf.writeUInt32BE(0x7f454c46, 0)
    buf[4] = 1 // ELFCLASS32
    buf[5] = 1 // little endian
    buf[6] = 1 // version
    buf.writeUInt16LE(2, 0x10) // e_type = EXEC
    buf.writeUInt16LE(40, 0x12) // e_machine = ARM
    buf.writeUInt32LE(shoff, 0x20)
    buf.writeUInt16LE(ehsize, 0x28)
    buf.writeUInt16LE(40, 0x2e) // e_shentsize
    buf.writeUInt16LE(secNames.length, 0x30)
    buf.writeUInt16LE(5, 0x32) // .shstrtab 下标

    // ---- .strtab / .shstrtab ----
    strtabBuf.copy(buf, strtabOff)
    shstrBuf.copy(buf, shstrOff2)

    // ---- .symtab ----
    let o = symtabOff + 16 // 跳过 0 号空符号
    for (let i = 0; i < syms.length; i += 1) {
      const s = syms[i]
      buf.writeUInt32LE(symNameOff[i], o)
      buf.writeUInt32LE(s.addr, o + 4)
      buf.writeUInt32LE(s.size, o + 8)
      buf[o + 0x0c] = (s.bind << 4) | s.type
      buf.writeUInt16LE(s.shndx, o + 0x0e)
      o += 16
    }

    // ---- 节头表 ----
    const wSec = (i: number, nameOff: number, type: number, addr: number, off: number, size: number, link: number, entsize: number): void => {
      const at = shoff + i * 40
      buf.writeUInt32LE(nameOff, at)
      buf.writeUInt32LE(type, at + 4)
      buf.writeUInt32LE(addr, at + 8) // .data 要真的带地址，解析器靠它判断 RAM
      buf.writeUInt32LE(off, at + 0x10)
      buf.writeUInt32LE(size, at + 0x14)
      buf.writeUInt32LE(link, at + 0x18)
      buf.writeUInt32LE(entsize, at + 0x24)
    }
    wSec(0, 0, 0, 0, 0, 0, 0, 0)
    wSec(1, shstrOff[1], 1, 0x20000000, dataOff, 16, 0, 0)
    wSec(2, shstrOff[2], 8, 0x20000010, dataOff, 16, 0, 0) // SHT_NOBITS
    wSec(3, shstrOff[3], 2, 0, symtabOff, symtabSize, 4, 16)
    wSec(4, shstrOff[4], 3, 0, strtabOff, strtabBuf.length, 0, 0)
    wSec(5, shstrOff[5], 3, 0, shstrOff2, shstrtabSize, 0, 0)

    return buf
  }

  const elf = buildElf([
    { name: 'battery_voltage', addr: 0x20000000, size: 4, type: 1, bind: 1, shndx: 1 },
    { name: 'INS_gyro', addr: 0x20000010, size: 2, type: 1, bind: 0, shndx: 2 },
    { name: 'flash_table', addr: 0x08001000, size: 4, type: 1, bind: 1, shndx: 1 },
    { name: 'accel_buf', addr: 0x20000012, size: 12, type: 1, bind: 0, shndx: 2 },
    { name: 'max_angle.2', addr: 0x20000004, size: 4, type: 1, bind: 0, shndx: 1 },
    { name: 'reset_handler', addr: 0x08000100, size: 0, type: 2, bind: 1, shndx: 1 }
  ])

  const vars = parseElfVars(elf)
  check(
    'ELF: 只留 RAM 里的全局/静态变量',
    vars.length === 2 && vars.some((v) => v.name === 'battery_voltage') && vars.some((v) => v.name === 'INS_gyro'),
    vars.map((v) => v.name).join(',')
  )
  check(
    'ELF: flash 里的 const 表不收（拿不到、也改不了）',
    !vars.some((v) => v.name === 'flash_table')
  )
  check('ELF: 结构体/数组（size 12）不收，按 float 读出来是垃圾', !vars.some((v) => v.name === 'accel_buf'))
  check('ELF: 名字带点的编译器内部符号不收', !vars.some((v) => v.name.startsWith('max_angle')))
  check('ELF: 函数符号不收（它不是变量）', !vars.some((v) => v.name === 'reset_handler'))

  const gv = vars.find((v) => v.name === 'battery_voltage')
  check('ELF: 读出正确地址', gv?.addr === 0x20000000, gv ? `0x${gv.addr.toString(16)}` : 'undefined')
  check('ELF: 全局变量 isStatic=false', gv?.isStatic === false)
  check('ELF: 节名跟着 shndx 走', gv?.section === '.data', gv?.section)

  const sv = vars.find((v) => v.name === 'INS_gyro')
  check('ELF: static 变量照样收（这条路比源码扫描强的地方）', sv?.isStatic === true)
  check('ELF: 2 字节默认按 int16 解', sv?.kind === 'i16', sv?.kind)
  check('ELF: 4 字节默认按 float 解', gv?.kind === 'f', gv?.kind)

  let threw = ''
  try {
    parseElfVars(Buffer.from('this is not an elf at all', 'utf8'))
  } catch (err) {
    threw = (err as Error).message
  }
  check('ELF: 不是 ELF 文件时报错而不是返回空表', threw.length > 0, threw)

  // ---- 下发命令 ----
  const slots = [
    { name: 'gyro_z', addr: 0x20001a3c, kind: 'i16' as const },
    { name: 'battery_voltage', addr: 0x2000a7b0, kind: 'f' as const }
  ]
  const cmd = buildSlotCommands(slots)
  check(
    '命令: 先 ac 清表，槽号连续，地址带 0x',
    cmd === 'ac;am 0 0x20001A3C i16;am 1 0x2000A7B0 f',
    cmd
  )
  check('命令: hexAddr 补满 8 位', hexAddr(0x20) === '0x00000020', hexAddr(0x20))
  check('命令: rd/wr 模板带上正确的类型', buildReadCommand(slots[0]) === 'rd 0x20001A3C i16' && buildWriteCommand(slots[0], '1.5') === 'wr 0x20001A3C i16 1.5')
  check(
    '命令: 通道对应关系按槽号顺序给出',
    slotLegend(slots).join(' | ') === 'ch0  gyro_z  (i16) | ch1  battery_voltage  (f)',
    slotLegend(slots).join(' | ')
  )
  check('命令: 超过槽上限时截断，不会生成固件不认的槽号', buildSlotCommands(new Array(20).fill(slots[0])).split(';').length === ADDR_SLOT_MAX + 1)
  check('类型: kindFromSize 1/2/4 字节分别给 i8/i16/f', kindFromSize(1) === 'i8' && kindFromSize(2) === 'i16' && kindFromSize(4) === 'f')

  // ---- 存进工程的那份地址表（application/vofa/vofa_addr.json）----
  //
  // 这一小块的功能是「记住用户勾了谁」，看起来最不值钱，但它是唯一会被
  // 用户和 git 直接看到的东西 —— 地址写成十进制、槽顺序被打乱、类型被写成
  // 固件不认的字符串，都会让人以为「工具把我的表弄坏了」。
  const tbl = {
    version: 1 as const,
    packId: 'vofa' as const,
    updatedAt: 1,
    slots: [
      { name: 'gyro_z', addr: 0x20001a3c, kind: 'i16' as const },
      { name: 'battery_voltage', addr: 0x2000a7b0, kind: 'f' as const }
    ]
  }
  const tblText = serializeAddrTable(tbl)
  check(
    '存表: 地址写成 0x 而不是十进制（对着 map 文件要认得出来）',
    tblText.includes('0x20001A3C') && !tblText.includes('537406780')
  )

  const tblBack = normalizeAddrTable(JSON.parse(tblText))
  check(
    '存表: 序列化再读回，名字/地址/顺序都不变',
    !!tblBack &&
      tblBack.slots.length === 2 &&
      tblBack.slots[0].name === 'gyro_z' &&
      tblBack.slots[0].addr === 0x20001a3c &&
      tblBack.slots[1].kind === 'f',
    JSON.stringify(tblBack?.slots)
  )
  check(
    '存表: 认不出的槽只跳过它自己，不连累整张表',
    normalizeAddrTable({
      slots: [{ name: 'a', addr: 'not-an-address' }, { name: 'b', addr: 0x20000000, kind: 'u32' }]
    })?.slots.length === 1
  )
  check(
    '存表: 类型写错按 float 兜底（别把槽弄丢）',
    normalizeAddrTable({ slots: [{ name: 'a', addr: 0x20000000, kind: 'double' }] })?.slots[0].kind === 'f'
  )
  check(
    '存表: 超过槽上限时截断（固件只有 16 个槽）',
    (normalizeAddrTable({ slots: new Array(40).fill({ name: 'x', addr: 0x20000000, kind: 'f' }) })
      ?.slots.length ?? 0) === ADDR_SLOT_MAX
  )
  check(
    '存表: 不是对象就返回 null（界面按空表处理，不当成错误弹窗）',
    normalizeAddrTable('nonsense') === null && normalizeAddrTable({}) === null
  )

  // ---- 两处常量必须一致，否则界面能勾上的槽固件会拒绝 ----
  const fw = readPackFile('vofa', 'vofa_task.c') ?? ''
  check(
    `固件: VOFA_ADDR_SLOT_MAX 与界面 ADDR_SLOT_MAX 一致（${ADDR_SLOT_MAX}）`,
    new RegExp(`#define\\s+VOFA_ADDR_SLOT_MAX\\s+${ADDR_SLOT_MAX}u`).test(fw),
    (/#define\s+VOFA_ADDR_SLOT_MAX\s+\d+u/.exec(fw) ?? ['没找到'])[0]
  )
  check(
    '固件: 每个类型标记都能被 vofa_type_parse 认出来',
    MEM_KINDS.every((k) => fw.includes(`strcmp(s, "${k}")`)),
    MEM_KINDS.filter((k) => !fw.includes(`strcmp(s, "${k}")`)).join(',')
  )
  check(
    '固件: 地址越界会被挡掉（越界读直接 HardFault）',
    fw.includes('vofa_mem_ok') && fw.includes('_estack')
  )
  check(
    '固件: 帧里地址槽排在注册通道之前（上位机按这个顺序解释 ch0…）',
    fw.indexOf('for (uint8_t i = 0; i < vofa_mem_count; i++)') <
      fw.indexOf('for (uint16_t i = 0; i < vofa_channel_count; i++)')
  )
}

// ==========================================================================
// 22. .ioc 直改：波特率 / RX DMA / NVIC
// ==========================================================================
//
// 这一段全是**字节级**断言，因为出错的方式都很安静：
//   · IPParameters 漏写 BaudRate → CubeMX 直接忽略波特率，生成出来还是旧的
//   · 新加 DMA 没配 NVIC 的「生成中断函数」位 → NVIC 开着、函数没有，
//     中断一来就掉进 Default_Handler 死循环
//   · 把工程里已有的 USART_INT 入口再让 CubeMX 生成一份 → 链接期重复定义
// 这些在界面上都看不出来，只能在这一层钉住。

{
  section('22. .ioc 直改：波特率 / RX DMA / NVIC')

  check(
    '外设名: huart1→USART1，huart4→UART4（芯片里就叫 UART4），hlpuart1→LPUART1',
    peripheralOf('huart1') === 'USART1' &&
      peripheralOf('huart4') === 'UART4' &&
      peripheralOf('huart6') === 'USART6' &&
      peripheralOf('hlpuart1') === 'LPUART1' &&
      peripheralOf('nonsense') === null,
    [peripheralOf('huart1'), peripheralOf('huart4'), peripheralOf('hlpuart1')].join(',')
  )

  const iocRoot = join(sandbox, 'ioc-proj')
  const iocPut = (rel: string, body: string, crlf = false): void => {
    const p = join(iocRoot, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, crlf ? body.replace(/\n/g, '\r\n') : body, 'utf8')
  }

  const baseIoc = [
    'Mcu.Family=STM32F4',
    'Mcu.CPN=STM32F407IGH6',
    'USART1.IPParameters=VirtualMode',
    'USART1.VirtualMode=VM_ASYNC',
    'USART3.BaudRate=100000',
    'USART3.IPParameters=VirtualMode,BaudRate,Parity',
    'USART3.Parity=PARITY_EVEN',
    'USART3.VirtualMode=VM_ASYNC',
    'Dma.Request0=USART3_RX',
    'Dma.USART3_RX.0.Instance=DMA1_Stream1',
    'Dma.RequestsNb=1',
    'ProjectManager.AskForMigrate=true',
    ''
  ].join('\n')

  iocPut('demo.ioc', baseIoc, true) // CRLF：CubeMX 写出来的就是这种
  iocPut(
    'Src/usart.c',
    '#include "usart.h"\nUART_HandleTypeDef huart1;\nvoid MX_USART1_UART_Init(void)\n{\n  huart1.Init.BaudRate = 115200;\n}\n'
  )

  // ---- 波特率 ----
  const baudPlan = planUartIoc(iocRoot, {
    uart: 'huart1',
    baud: 921600,
    rxMode: 'it',
    dmaMode: 'circular',
    builtinIrq: true,
    irqPriority: 5
  })
  check('ioc: 能识别出 .ioc', baudPlan.ok && baudPlan.relPath === 'demo.ioc', baudPlan.error)
  const baudKeys = baudPlan.changes.map((c) => c.key)
  check(
    'ioc: 写 BaudRate，并把它补进 IPParameters（漏写等于没改）',
    baudKeys.includes('USART1.BaudRate') && baudKeys.includes('USART1.IPParameters'),
    baudKeys.join(',')
  )
  check(
    'ioc: IPParameters 只追加、不覆盖（USART3 的 Parity 不能被抹掉）',
    (baudPlan.after ?? '').includes('USART3.IPParameters=VirtualMode,BaudRate,Parity') &&
      (baudPlan.after ?? '').includes('USART1.IPParameters=VirtualMode,BaudRate'),
    ''
  )
  check(
    'ioc: 换行符保持 CRLF（改成 LF 的话 git diff 会变成整个文件都改了）',
    (baudPlan.after ?? '').includes('\r\n') && !/(?<!\r)\n/.test(baudPlan.after ?? ''),
    ''
  )
  check(
    'ioc: 不碰串口自己的 NVIC（工程里已经有中断入口，再生成一份会重复定义）',
    !/NVIC\.USART1_IRQn=/.test(baudPlan.after ?? ''),
    ''
  )

  // ---- 什么都不用改时，不要凭空造出一个改动（否则每次都白跑一次 CubeMX）----
  const noop = planUartIoc(iocRoot, {
    uart: 'huart1',
    baud: 115200, // .ioc 里没写 BaudRate = CubeMX 默认就是 115200
    rxMode: 'it',
    dmaMode: 'circular',
    builtinIrq: true,
    irqPriority: 5
  })
  check(
    'ioc: 波特率本来就一样时不写盘、也不碰 AskForMigrate（避免白跑 CubeMX）',
    noop.ok && noop.changes.length === 0 && noop.after === noop.before,
    noop.changes.map((c) => c.key).join(',')
  )

  // ---- 未启用的串口：必须拒绝，而不是写一堆没人认的键 ----
  const notEnabled = planUartIoc(iocRoot, {
    uart: 'huart7',
    baud: 115200,
    rxMode: 'it',
    dmaMode: 'circular',
    builtinIrq: true,
    irqPriority: 5
  })
  check(
    'ioc: 串口没在 CubeMX 里启用时明确报错（不静默写无效配置）',
    !notEnabled.ok && (notEnabled.error ?? '').includes('UART7.VirtualMode'),
    notEnabled.error
  )

  // ---- RX DMA ----
  const dmaPlan = planUartIoc(iocRoot, {
    uart: 'huart1',
    baud: 921600,
    rxMode: 'dma',
    dmaMode: 'circular',
    builtinIrq: true,
    irqPriority: 5
  })
  const dmaText = dmaPlan.after ?? ''
  check(
    'ioc: 新加 RX DMA 用最小空槽，RequestsNb 跟着加（少写 CubeMX 会忽略最后一条）',
    /Dma\.Request1=USART1_RX/.test(dmaText) && /Dma\.RequestsNb=2/.test(dmaText),
    (dmaText.match(/Dma\.RequestsNb=\d+/) ?? [''])[0]
  )
  check(
    'ioc: F407 上 USART1_RX 走 DMA2_Stream5（硬件连线决定的，不能瞎猜）',
    /Dma\.USART1_RX\.1\.Instance=DMA2_Stream5/.test(dmaText)
  )
  check(
    'ioc: DMA 默认写 CIRCULAR（固件按「偏移取增量」实现，单次模式会只收到第一条命令）',
    /Dma\.USART1_RX\.1\.Mode=DMA_CIRCULAR/.test(dmaText),
    (dmaText.match(/Dma\.USART1_RX\.1\.Mode=.*/) ?? [''])[0]
  )
  check(
    'ioc: DMA 中断的 NVIC 第 4 位必须是 true —— 否则只使能中断不生成函数，跳 Default_Handler 死循环',
    dmaText.includes(
      'NVIC.DMA2_Stream5_IRQn=true\\:5\\:0\\:true\\:false\\:true\\:true\\:false\\:true\\:true'
    ),
    (dmaText.match(/NVIC\.DMA2_Stream5_IRQn=.*/) ?? [''])[0]
  )

  // 想用单次模式也要能选（会写 NORMAL，固件那边随之在回调里重挂）
  const dmaNormal = planUartIoc(iocRoot, {
    uart: 'huart1',
    baud: 921600,
    rxMode: 'dma',
    dmaMode: 'normal',
    builtinIrq: true,
    irqPriority: 5
  })
  check(
    'ioc: 选单次模式就写 DMA_NORMAL（参数说了算，不能写死）',
    /Dma\.USART1_RX\.1\.Mode=DMA_NORMAL/.test(dmaNormal.after ?? ''),
    (dmaNormal.after ?? '').match(/Dma\.USART1_RX\.1\.Mode=.*/)?.[0]
  )

  const already = planUartIoc(iocRoot, {
    uart: 'huart3',
    baud: 115200,
    rxMode: 'dma',
    dmaMode: 'circular',
    builtinIrq: true,
    irqPriority: 5
  })
  check(
    'ioc: 串口本来就有 RX DMA 时不重复添加，但会把模式补上（原来这格是「点了没反应」）',
    !(already.after ?? '').includes('Dma.Request1=') &&
      /Dma\.USART3_RX\.0\.Mode=DMA_CIRCULAR/.test(already.after ?? ''),
    (already.notes ?? []).join(' | ')
  )

  // 已经就是循环：一个字节都不该改（否则每次安装都白跑两分钟 CubeMX）
  const circRoot = join(sandbox, 'ioc-circ')
  mkdirSync(circRoot, { recursive: true })
  writeFileSync(
    join(circRoot, 'circ.ioc'),
    [
      'Mcu.Family=STM32F4',
      'USART3.IPParameters=VirtualMode,BaudRate',
      'USART3.BaudRate=115200',
      'USART3.VirtualMode=VM_ASYNC',
      'Dma.Request0=USART3_RX',
      'Dma.USART3_RX.0.Instance=DMA1_Stream1',
      'Dma.USART3_RX.0.Mode=DMA_CIRCULAR',
      'Dma.RequestsNb=1',
      ''
    ].join('\n'),
    'utf8'
  )
  const circSame = planUartIoc(circRoot, {
    uart: 'huart3',
    baud: 115200,
    rxMode: 'dma',
    dmaMode: 'circular',
    builtinIrq: true,
    irqPriority: 5
  })
  check(
    'ioc: 已经是循环模式时不做任何改动（幂等，避免无意义地重跑 CubeMX）',
    circSame.ok && circSame.changes.length === 0 && circSame.after === circSame.before,
    circSame.changes.map((c) => c.key).join(',')
  )

  // 反过来的场景：工程里是单次，参数要循环 —— 这就是用户问的那个「能不能改」
  writeFileSync(
    join(circRoot, 'circ.ioc'),
    [
      'Mcu.Family=STM32F4',
      'USART3.IPParameters=VirtualMode,BaudRate',
      'USART3.BaudRate=115200',
      'USART3.VirtualMode=VM_ASYNC',
      'Dma.Request0=USART3_RX',
      'Dma.USART3_RX.0.Instance=DMA1_Stream1',
      'Dma.USART3_RX.0.Mode=DMA_NORMAL',
      'Dma.RequestsNb=1',
      ''
    ].join('\n'),
    'utf8'
  )
  const flip = planUartIoc(circRoot, {
    uart: 'huart3',
    baud: 115200,
    rxMode: 'dma',
    dmaMode: 'circular',
    builtinIrq: true,
    irqPriority: 5
  })
  check(
    'ioc: 工程里是 NORMAL、参数要 CIRCULAR 时只改 Mode（另加一行关弹窗的 AskForMigrate）',
    flip.changes.length === 2 &&
      flip.changes.some((c) => c.key === 'Dma.USART3_RX.0.Mode' && c.after === 'DMA_CIRCULAR') &&
      flip.changes.some((c) => c.key === 'ProjectManager.AskForMigrate') &&
      /Dma\.USART3_RX\.0\.Instance=DMA1_Stream1/.test(flip.after ?? ''),
    flip.changes.map((c) => `${c.key}=${c.after}`).join(',')
  )
  check(
    'ioc: 改模式时会说清「从哪改到哪」，不是闷头改',
    (flip.notes ?? []).some((n) => n.includes('单次') && n.includes('循环')),
    (flip.notes ?? []).join(' | ')
  )
  check(
    'ioc: 能读出 .ioc 里 RX DMA 的真实模式（源码里 NORMAL/CIRCULAR 看不出区别）',
    readRxDmaMode(circRoot, 'USART3') === 'normal' && readRxDmaMode(iocRoot, 'USART3') === null,
    `${readRxDmaMode(circRoot, 'USART3')} / ${readRxDmaMode(iocRoot, 'USART3')}`
  )

  // ---- 不知道 DMA 映射的芯片：宁可明说，也不猜一个 Stream ----
  const h7Root = join(sandbox, 'ioc-h7')
  mkdirSync(h7Root, { recursive: true })
  writeFileSync(
    join(h7Root, 'h7.ioc'),
    'Mcu.Family=STM32H7\nUSART1.IPParameters=VirtualMode\nUSART1.VirtualMode=VM_ASYNC\n',
    'utf8'
  )
  const h7 = planUartIoc(h7Root, {
    uart: 'huart1',
    baud: 115200,
    rxMode: 'dma',
    dmaMode: 'circular',
    builtinIrq: true,
    irqPriority: 5
  })
  check(
    'ioc: 没见过的芯片家族不加 DMA，只给警告（猜错 Stream 会静默不工作）',
    h7.ok && !(h7.after ?? '').includes('USART1_RX') && h7.warnings.length > 0,
    h7.warnings.join(' | ')
  )

  // ---- 事后核对：代码里的波特率到底变没变 ----
  check(
    'ioc: 没重新生成时，核对会指出代码里还是旧波特率',
    !checkBaudInCode(iocRoot, 'huart1', 921600).match &&
      checkBaudInCode(iocRoot, 'huart1', 921600).actual === 115200,
    checkBaudInCode(iocRoot, 'huart1', 921600).detail
  )
  check('ioc: 一致时核对通过', checkBaudInCode(iocRoot, 'huart1', 115200).match)

  // ---- 包声明：参数名对不上就整段静默失效，所以逐个对一遍 ----
  const vofaForIoc = loadPack('vofa')
  const setup = vofaForIoc?.iocSetup
  const paramKeys = new Set((vofaForIoc?.params ?? []).map((x) => x.key))
  const refs = setup
    ? [
        setup.uartParam,
        setup.baudParam,
        setup.rxModeParam,
        setup.dmaModeParam,
        setup.builtinIrqParam,
        setup.irqPriorityParam,
        setup.cubeMxParam
      ]
    : []
  check(
    '包声明: vofa 声明了 iocSetup，且每个参数名都真的存在',
    Boolean(setup) && refs.every((r) => !r || paramKeys.has(r)),
    refs.filter((r) => r && !paramKeys.has(r)).join(',')
  )
  check(
    '包声明: 有波特率参数（这次的核心诉求）',
    paramKeys.has('baud') && paramKeys.has('cubeMxRun'),
    [...paramKeys].join(',')
  )

  // ---- DMA 模式：.ioc 和 vofa_config.h 必须说同一句话 ----
  const dmaParam = (vofaForIoc?.params ?? []).find((p) => p.key === 'dmaMode')
  check(
    '包声明: dmaMode 有中文标签，且没选 DMA 时置灰而不是隐藏',
    dmaParam?.options?.join(',') === 'circular,normal' &&
      Boolean(dmaParam?.optionLabels?.circular) &&
      dmaParam?.enableIf?.key === 'rxMode' &&
      dmaParam?.enableIf?.equals === 'dma' &&
      // 留一行灰的才找得到；用 showIf 会让用户以为这功能不存在
      !dmaParam?.showIf,
    JSON.stringify(dmaParam?.optionLabels ?? null)
  )

  if (vofaForIoc) {
    const tplOf = (kind: 'config' | 'bind'): string =>
      vofaForIoc.generated.find((g) => g.render === kind)!.template
    const cfgFacts = inspectProject(iocRoot)
    const circCfg = renderConfig(vofaForIoc, tplOf('config'), { ...symMap.params, rxMode: 'dma', dmaMode: 'circular' }, cfgFacts)
    const normCfg = renderConfig(vofaForIoc, tplOf('config'), { ...symMap.params, rxMode: 'dma', dmaMode: 'normal' }, cfgFacts)
    check(
      'DMA 模式: 循环写 1、单次写 0（固件靠这个宏决定要不要在回调里重挂）',
      /#define VOFA_RX_DMA_CIRCULAR\s+1/.test(circCfg) &&
        /#define VOFA_RX_DMA_CIRCULAR\s+0/.test(normCfg),
      [/#define VOFA_RX_DMA_CIRCULAR\s+\d/.exec(circCfg)?.[0], /#define VOFA_RX_DMA_CIRCULAR\s+\d/.exec(normCfg)?.[0]].join(' / ')
    )
  }
}

section('结果')
console.log(
  `  共 ${checks} 项检查，失败 ${failures} 项` + (skipped > 0 ? `，跳过 ${skipped} 项` : '')
)
if (failures > 0) {
  console.log('  ✗ 自检未通过')
  process.exit(1)
}
console.log('  ✓ 全部通过')
