/**
 * **按模板造一条 launch 配置**。
 *
 * 纯函数：给同一个 ctx，永远造出同一份配置。原来的写法是组件内的闭包，
 * 依赖 `options` / `project` / `bundle` 三个外部变量，所以只能整页跑起来才看得到效果。
 *
 * 字段必须和主进程 `generators.ts` 的 `stGdbServerConfig` **同步**：
 * 两处生成的是同一种配置，不一致的话「按当前参数重新生成全部配置」
 * 会把用户手工加的这条悄悄换成另一份内容。
 */

import { probeByKey } from '@shared/probes'
import { debugTargetConfigName } from '@shared/debugTargets'
import { guessDeviceCore } from '@shared/chipTargets'
import { buildTaskLabel } from '@shared/labels'
import type { DebugTargetKey, GenOptions, LaunchConfig, ProjectInfo } from '@shared/types'
import { WS, setKey, type TemplateId } from './meta'

  /** 按模板造一个新配置；options / project 缺失时用保守的兜底值 */
  /** 造配置要用的三样东西；其余一律从这里取，不从组件闭包里摸 */
export interface LaunchBuildCtx {
  options: GenOptions | null
  project: ProjectInfo
  /** 本工具会写哪个 openocd-*.cfg；null = 不写，配置里就不引用 */
  openocdCfg: string | null
}

export function buildTemplate(id: TemplateId, ctx: LaunchBuildCtx): LaunchConfig {
  const { options, project, openocdCfg } = ctx
    const debugDir = options?.debugDir || 'build/Debug'
    const elfName = options?.elfName || project.elfName || 'firmware'
    const device = options?.device || project.device || ''
    const probe = probeByKey(options?.probeKey ?? 'cmsis-dap')
    const cfgFile = openocdCfg

    if (id === 'blank') {
      return { name: '新配置', type: 'cppdbg', request: 'launch' }
    }

    if (id === 'native') {
      const base: LaunchConfig = {
        name: 'C/C++: 调试 Debug',
        type: 'cppdbg',
        request: 'launch',
        cwd: WS,
        program: `${WS}/${debugDir}/${elfName}.exe`,
        args: [],
        stopAtEntry: false,
        externalConsole: false,
        MIMode: 'gdb'
      }
      const gdb = options?.toolchainDir
        ? `${options.toolchainDir.replace(/\\/g, '/')}/arm-none-eabi-gdb.exe`
        : ''
      return gdb ? setKey(base, 'miDebuggerPath', gdb) : base
    }

    const isAttach = id === 'attach'
    const name = isAttach
      ? 'Debug: 附加到运行中的目标'
      : id === 'debugOnly'
        ? 'Debug: 仅调试（不重新烧录）'
        : debugTargetConfigName('probe', probe.label)

    let cfg: LaunchConfig = {
      name,
      type: 'cortex-debug',
      request: isAttach ? 'attach' : 'launch',
      servertype: probe.servertype,
      cwd: WS,
      executable: `${WS}/${debugDir}/${elfName}.elf`
    }
    if (device) cfg = setKey(cfg, 'device', device)
    // 只有当本工具真的会写 openocd-*.cfg 时才引用它
    if (cfgFile) cfg = setKey(cfg, 'configFiles', [`${WS}/.vscode/${cfgFile}`])
    if (id === 'debugOnly') cfg = setKey(cfg, 'loadFiles', [])
    if (!isAttach) cfg = setKey(cfg, 'runToEntryPoint', 'main')
    return cfg
  }

  /** J-Link 速度枚举（kHz），写别的值 schema 会判红 */
  const JLINK_SPEEDS = [
    '1', '5', '10', '20', '30', '50', '100', '200', '300', '400', '500', '600', '750', '900',
    '1000', '1333', '1600', '2000', '2667', '3200', '4000', '4800', '5333', '6000', '8000',
    '9600', '12000'
  ]
  /** ST-Link 速度枚举（kHz） */
  const STLINK_SPEEDS = ['Auto', '140', '1000', '8000', '21000', '24000']

  /**
   * 生成一条 ST 官方扩展的调试配置（stlinkgdbtarget / jlinkgdbtarget）。
   *
   * 字段必须和主进程 generators.ts 的 stGdbServerConfig **同步**：
   * 两处生成的是同一种配置，不一致的话「按当前参数重新生成全部配置」
   * 会把用户手工加的这条悄悄换成另一份内容。
   */
  export function buildStConfig(target: 'stlink-gdbserver' | 'jlink-gdbserver', ctx: LaunchBuildCtx): LaunchConfig {
  const { options, project } = ctx
    const isStlink = target === 'stlink-gdbserver'
    const debugDir = options?.debugDir || 'build/Debug'
    const elfName = options?.elfName || project.elfName || 'firmware'
    const device = options?.device || project.device || ''
    const core = guessDeviceCore(device)
    const elf = `${WS}/${debugDir}/${elfName}.elf`

    const gdb = options?.toolchainDir
      ? `${options.toolchainDir.replace(/\\/g, '/')}/arm-none-eabi-gdb.exe`
      : ''

    const svdRaw = options?.svdFile?.trim() ?? ''
    const svd = svdRaw
      ? /^[A-Za-z]:/.test(svdRaw)
        ? svdRaw.replace(/\\/g, '/')
        : `${WS}/${svdRaw.replace(/\\/g, '/')}`
      : ''

    const cfg: LaunchConfig = {
      name: debugTargetConfigName(target),
      type: isStlink ? 'stlinkgdbtarget' : 'jlinkgdbtarget',
      request: 'launch',
      origin: 'snippet',
      cwd: WS,
      // 适配器强校验：缺 deviceName / deviceCore 直接抛错，缺 imagesAndSymbols 也报
      imagesAndSymbols: [
        { imageFileName: elf, imageOffset: '', symbolFileName: elf, symbolOffset: '' }
      ],
      runEntry: 'main',
      // 空串 = 不执行 ST 扩展自带的构建命令，构建交给下面的 preLaunchTask
      preBuild: '',
      preLaunchTask: buildTaskLabel('debug'),
      serverInterface: 'SWD'
    }
    if (device) cfg.deviceName = device
    if (core) cfg.deviceCore = core
    if (gdb) cfg.gdb = gdb
    if (svd) cfg.svdPath = svd

    const speed = String(options?.adapterSpeed ?? 1000)
    if (isStlink) {
      if (STLINK_SPEEDS.includes(speed)) cfg.serverInterfaceFrequency = speed
    } else if (JLINK_SPEEDS.includes(speed)) {
      cfg.serverSpeed = speed
    }

    // 注意：ST 扩展的 samplesPerSecond 是**字符串**，cortex-debug 那边是数字
    if (options?.liveWatch !== false) {
      const sps = Math.max(0, Math.min(20, Math.round(options?.liveWatchSamplesPerSecond ?? 4)))
      cfg.liveWatch = { enabled: true, samplesPerSecond: String(sps) }
    }
    return cfg
  }

  /** 一个调试器目标 → 一条 launch 配置 */
  export function buildTargetConfig(target: DebugTargetKey, ctx: LaunchBuildCtx): LaunchConfig {
  return target === 'probe' ? buildTemplate('flash', ctx) : buildStConfig(target, ctx)
}
