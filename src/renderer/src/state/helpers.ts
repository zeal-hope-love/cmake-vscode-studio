/**
 * 从 store 里拆出来的**纯函数**：不持有状态，只做映射。
 *
 * 放在 store.ts 里时它们和 51 个 action 混在一起，谁也看不出这文件
 * 到底「有状态」还是「只是几个工具函数」。
 */

import type { AppSettings, ConfigBundle, PlannedFile } from '@shared/types'

// --------------------------------------------------------------------------
// bundle → 待写文件
// --------------------------------------------------------------------------

export function bundleToPayloads(bundle: ConfigBundle): Array<{
  name: string
  relativePath: string
  content: string
}> {
  const stringify = (value: unknown): string => JSON.stringify(value, null, 4) + '\n'

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

/**
 * 模板自带的文件内容覆盖掉「按参数生成」的那几份。
 *
 * 只覆盖模板真的提供了内容的那几个文件，其余（比如 openocd-*.cfg）仍按目标工程生成。
 */
export function mergeTemplateFiles(
  generated: Array<{ name: string; relativePath: string; content: string }>,
  overrides: Record<string, string> | null
): Array<{ name: string; relativePath: string; content: string }> {
  if (!overrides) return generated
  const merged = generated.map((f) =>
    overrides[f.relativePath] !== undefined ? { ...f, content: overrides[f.relativePath] } : f
  )
  // 模板里有、但按参数生成时没有的文件也补上
  for (const [relativePath, content] of Object.entries(overrides)) {
    if (!merged.some((f) => f.relativePath === relativePath)) {
      merged.push({ name: relativePath.replace(/^\.vscode\//, ''), relativePath, content })
    }
  }
  return merged
}

/**
 * 把主题落到 DOM 上。
 *
 * 主进程会设 `nativeTheme.themeSource`，所以选「跟随系统」时
 * `prefers-color-scheme` 已经等于系统当前的值，这里直接读就行。
 */
export function applyThemeToDom(theme: AppSettings['theme']): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme
  document.documentElement.dataset.theme = resolved
}

/** 当前主题实际显示成什么（「关于」和状态栏里展示用） */
export function themeLabel(theme: AppSettings['theme']): string {
  if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    return `跟随系统（当前${dark ? '深色' : '浅色'}）`
  }
  return theme === 'dark' ? '深色' : '浅色'
}

export function plannedFileText(file: PlannedFile): string {
  return file.content
}

/**
 * 与键顺序无关的 JSON 序列化。
 *
 * 用来判断「磁盘上的文件」和「将要生成的内容」是否一致 ——
 * 直接 JSON.stringify 会受属性顺序影响（重新解析过的对象顺序和生成时不一定相同）。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
