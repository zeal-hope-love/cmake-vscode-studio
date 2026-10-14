/**
 * 应用设置（主题、工具路径、最近工程、默认探针等）的读写。
 */

import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { readStoreFile, userDataPath, writeStoreFile } from './store'

let cache: AppSettings | null = null

function settingsFile(): string {
  return userDataPath('settings.json')
}

export function getSettings(): AppSettings {
  if (cache) return cache
  const stored = readStoreFile<Partial<AppSettings>>(settingsFile(), {})
  cache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    tools: { ...DEFAULT_SETTINGS.tools, ...(stored.tools ?? {}) },
    recentProjects: Array.isArray(stored.recentProjects) ? stored.recentProjects : []
  }
  return cache
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    tools: { ...current.tools, ...(patch.tools ?? {}) }
  }
  cache = next
  writeStoreFile(settingsFile(), next)
  return next
}

/** 把工程加进「最近使用」列表（去重、最多 20 条、最新的排最前） */
export function rememberProject(projectRoot: string): AppSettings {
  const current = getSettings()
  const key = projectRoot.toLowerCase()
  const rest = current.recentProjects.filter((p) => p.toLowerCase() !== key)
  return saveSettings({
    recentProjects: [projectRoot, ...rest].slice(0, 20),
    lastProject: projectRoot
  })
}
