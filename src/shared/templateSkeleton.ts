/**
 * 模板骨架生成器。
 *
 * 「图形化新建模板」时，用户只选三件事（编辑器 / 构建系统 / 调试探针）和几个参数，
 * 这里据此生成四份文件的**初始内容**。生成的内容里，所有工程专属的值都是
 * `${elfName}` 这类占位符（见 templateRender.ts），所以模板天生可以套用到别的工程。
 *
 * 生成之后用户可以逐份直接编辑 —— 这里给的只是「一个能用的起点」。
 */

import type { GenOptions, TemplateFileKey, TemplateTarget } from './types'
import { probeByKey } from './probes'

const INDENT = 4

function toJson(value: unknown): string {
  return JSON.stringify(value, null, INDENT) + '\n'
}

export interface SkeletonInput {
  target: TemplateTarget
  options: Partial<GenOptions>
}

/** 生成四份文件的骨架（.vscode/ 下的文件名 → 文本内容） */
export function buildTemplateSkeleton(input: SkeletonInput): Record<TemplateFileKey, string> {
  const { target, options } = input
  const probe = probeByKey(target.probe)
  const servertype = probe.servertype || 'openocd'
  const useOpenocd = servertype === 'openocd'
  const usePreset = target.buildSystem === 'preset'

  const debugDir = '${debugDir}'
  const elf = `\${workspaceFolder}/${debugDir}/\${elfName}.elf`

  const buildArgs = usePreset
    ? ['--build', '--preset', '${debugPreset}']
    : ['--build', `\${workspaceFolder}/${debugDir}`]

  // ---- launch.json ----
  const common = {
    type: 'cortex-debug',
    request: 'launch',
    servertype,
    cwd: '${workspaceFolder}',
    executable: elf,
    device: '${device}',
    svdFile: '${svdFile}',
    runToEntryPoint: 'main'
  }

  // configFiles 只有 OpenOCD 需要；其它 servertype 由 cortex-debug 自己拉起调试器
  const configFiles = useOpenocd ? { configFiles: [`.vscode/\${openocdCfg}`] } : {}

  const launch = {
    version: '0.2.0',
    configurations: [
      {
        name: '调试（${probeLabel}）',
        ...common,
        ...configFiles,
        preLaunchTask: '构建（Debug）'
      },
      {
        name: '烧录并运行',
        ...common,
        ...configFiles,
        preLaunchTask: '构建（Release）+ 烧录'
      }
    ]
  }

  // ---- tasks.json ----
  const tasks: Record<string, unknown>[] = [
    {
      label: '配置（Debug）',
      type: 'shell',
      command: 'cmake',
      args: usePreset
        ? ['--preset', '${debugPreset}']
        : ['-S', '.', '-B', `\${workspaceFolder}/${debugDir}`, '-DCMAKE_BUILD_TYPE=Debug'],
      options: { cwd: '${workspaceFolder}' },
      problemMatcher: []
    },
    {
      label: '构建（Debug）',
      type: 'shell',
      command: 'cmake',
      args: buildArgs,
      options: { cwd: '${workspaceFolder}' },
      problemMatcher: ['$gcc'],
      group: { kind: 'build', isDefault: true }
    }
  ]

  if (useOpenocd) {
    tasks.push(
      {
        label: '烧录（OpenOCD）',
        type: 'shell',
        command: 'openocd',
        args: [
          '-f',
          '${interfaceCfg}',
          '-f',
          '${targetCfg}',
          '-c',
          'adapter speed ${adapterSpeed}',
          '-c',
          'program ${workspaceFolder}/${debugDir}/${elfName}.elf verify reset exit'
        ],
        options: { cwd: '${workspaceFolder}' },
        problemMatcher: []
      },
      {
        label: '构建（Release）+ 烧录',
        type: 'shell',
        command: 'cmake',
        args: usePreset
          ? ['--build', '--preset', '${releasePreset}']
          : ['--build', '${workspaceFolder}/${releaseDir}'],
        options: { cwd: '${workspaceFolder}' },
        dependsOn: ['烧录（OpenOCD）'],
        problemMatcher: ['$gcc']
      }
    )
  }

  // ---- settings.json ----
  const settings: Record<string, unknown> = {
    'cmake.configureOnOpen': false,
    'cmake.buildDirectory': '${workspaceFolder}/build/${buildType}',
    'C_Cpp.default.compileCommands': `\${workspaceFolder}/${debugDir}/compile_commands.json`,
    'clangd.arguments': [`--compile-commands-dir=\${workspaceFolder}/${debugDir}`],
    'files.associations': { '*.h': 'c' },
    'files.exclude': { '**/.git': true, '**/.svn': true, '**/.DS_Store': true }
  }

  // ---- c_cpp_properties.json ----
  const cpp = {
    version: 4,
    configurations: [
      {
        name: 'STM32',
        compileCommands: `\${workspaceFolder}/${debugDir}/compile_commands.json`,
        includePath: ['${workspaceFolder}/**'],
        defines: [],
        cStandard: options.cStandard ?? 'c11',
        cppStandard: options.cppStandard ?? 'c17',
        intelliSenseMode: 'windows-gcc-arm'
      }
    ]
  }

  return {
    'launch.json': toJson(launch),
    'tasks.json': toJson({ version: '2.0.0', tasks }),
    'settings.json': toJson(settings),
    'c_cpp_properties.json': toJson(cpp)
  }
}

/** 描述这套模板面向什么，用在列表和详情页的标题上 */
export function describeTarget(target: TemplateTarget): string {
  const build = target.buildSystem === 'preset' ? 'CMake Presets' : 'CMake 构建目录'
  return `VSCode · ${build} · ${probeByKey(target.probe).label}`
}
