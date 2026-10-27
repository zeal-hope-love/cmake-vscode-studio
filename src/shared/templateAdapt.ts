/**
 * 模板套用的参数适配。
 *
 * 模板里存的是「上一个工程」的完整 GenOptions，其中一部分是**用户的选择**
 * （探针、目标配置、构建类型、C/C++ 标准…），另一部分则是**从那个工程推导出来的**
 * （固件名、芯片、构建目录、工具路径…）。
 *
 * 套用到新工程时必须只沿用前者，后者一律按目标工程重新推导 ——
 * 否则给 A 工程存的模板会把 B 工程的固件名覆盖成 A 的。
 *
 * 单工程套用和多工程批量都走这一个函数，避免两处逻辑漂移。
 */

import type { GenOptions } from './types'

/**
 * 从模板沿用、与目标工程无关的参数。
 *
 * 模板的 options 允许是「部分覆盖」（内置模板就只写几个字段），
 * 所以这里所有字段都要能接受 undefined。
 */
export function adaptTemplateOptions(template: Partial<GenOptions>, base: GenOptions): GenOptions {
  return {
    // ---- 目标工程推导（以 base 为准）----
    elfName: base.elfName,
    device: base.device,
    openocdExe: base.openocdExe,
    cmakeExe: base.cmakeExe,
    ninjaExe: base.ninjaExe,
    toolchainDir: base.toolchainDir,
    hasBuildPresets: base.hasBuildPresets,
    configurePreset: base.configurePreset,
    compileCommands: base.compileCommands,
    includeDirs: base.includeDirs.length ? base.includeDirs : (template.includeDirs ?? []),
    defines: base.defines.length ? base.defines : (template.defines ?? []),

    // ---- 用户选择（以模板为准，空值回退到 base）----
    probeKey: template.probeKey || base.probeKey,
    interfaceCfg: template.interfaceCfg || base.interfaceCfg,
    resetConfig:
      template.resetConfig !== undefined && template.resetConfig !== null
        ? template.resetConfig
        : base.resetConfig,
    targetCfg: template.targetCfg || base.targetCfg,
    adapterSpeed: template.adapterSpeed || base.adapterSpeed,
    debugDir: template.debugDir || base.debugDir,
    releaseDir: template.releaseDir || base.releaseDir,
    debugPreset: template.debugPreset || base.debugPreset,
    releasePreset: template.releasePreset || base.releasePreset,
    svdFile: template.svdFile || '',
    cStandard: template.cStandard || base.cStandard,
    cppStandard: template.cppStandard || base.cppStandard,
    generator: template.generator || base.generator,
    // Live Watch：模板里写了就用模板的，没写就跟随目标工程（也就是用户设置）
    liveWatch: template.liveWatch ?? base.liveWatch,
    liveWatchSamplesPerSecond: template.liveWatchSamplesPerSecond ?? base.liveWatchSamplesPerSecond,
    liveWatchRefreshRate: template.liveWatchRefreshRate ?? base.liveWatchRefreshRate
  }
}
