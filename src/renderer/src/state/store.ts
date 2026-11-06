/**
 * 全局状态仓库（zustand）—— **门面**。
 *
 * 数据流是单向的：
 *   载入工程 → project / tools / options / bundle
 *   改生成参数 → options →（无手动改动时）自动重新生成 bundle
 *   页面里的手工编辑 → 直接改 bundle，并标记该节为「已手动修改」
 *   写入 → bundle 摊平成文件 → 预览 → 落盘
 *
 * ## 为什么拆
 *
 * 原来是 1184 行的一个文件：51 个 action 全挤在 create({...}) 里，
 * 分节注释还和内容错位了（`writeNow` 落在「新手向导」段里）。
 * 现在按域切到 `slices/*.ts`，**state 的初始值和字段清单仍在这一处**，
 * 想知道「有哪些状态」还是只看这个文件。
 *
 * | 文件 | 职责 |
 * | --- | --- |
 * | `storeTypes.ts` | 状态形状 + set/get 类型（slice 只从这里拿类型） |
 * | `slices/core.ts` | 启动、切页、主题、提示、日志 |
 * | `slices/project.ts` | 选工程、探测、参数、手改 bundle |
 * | `slices/write.ts` | 预览 / 写入 / 快照还原 |
 * | `slices/onboarding.ts` | 新手向导、界面宽度、两个清理动作 |
 * | `slices/run.ts` | 跑外部命令 |
 * | `slices/templates.ts` | 模板 |
 * | `slices/packs.ts` | 模块包清单 |
 * | `slices/history.ts` | 写入历史 |
 * | `helpers.ts` | 纯函数（bundle → 文件、主题、canonicalJson…） |
 *
 * 对外接口没变：别处仍然是 `from './state/store'` 拿 `useStudio` 和那些类型。
 */

import { create } from 'zustand'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { StudioState } from './storeTypes'
import { coreSlice } from './slices/core'
import { projectSlice } from './slices/project'
import { writeSlice } from './slices/write'
import { onboardingSlice } from './slices/onboarding'
import { runSlice } from './slices/run'
import { templatesSlice } from './slices/templates'
import { packsSlice } from './slices/packs'
import { historySlice } from './slices/history'
import { canonicalJson } from './helpers'

export type {
  BundleSection,
  LogLine,
  PageKey,
  StudioGet,
  StudioSet,
  StudioState,
  Toast
} from './storeTypes'
export {
  applyThemeToDom,
  bundleToPayloads,
  canonicalJson,
  plannedFileText,
  themeLabel
} from './helpers'

export const useStudio = create<StudioState>()((set, get) => ({
  // ---- 状态初始值（字段清单见 storeTypes.ts 的 StudioState）----
  settings: DEFAULT_SETTINGS,
  appInfo: null,
  activeTemplate: null,
  /**
   * 套用的模板自带了「四份文件内容」时，渲染好的结果放这儿。
   * 写入时它覆盖掉按参数生成的那几份 —— 见 openPreview / writeNow。
   */
  activeTemplateFiles: null,
  history: [],
  pendingTemplateId: null,
  pickerOpen: true,
  /** 正在跑的命令标题，用于历史记录 */
  runTitle: '',
  projectRoot: '',
  project: null,
  tools: null,
  options: null,
  bundle: null,
  candidates: [],
  templates: [],
  packs: [],
  activePackId: null,

  activePage: 'project',
  ready: false,
  busy: false,
  busyText: '',
  errorText: null,
  toasts: [],
  logLines: [],
  activeRunId: null,

  manualSections: [],
  optionsDirty: false,

  planned: [],
  previewOpen: false,

  lastWriteResult: null,
  writeProgress: [],
  snapshots: [],

  helpOpen: false,
  updateFocusSeq: 0,
  writtenProjects: [],

  // ---- 各域的动作 ----
  ...coreSlice(set, get),
  ...projectSlice(set, get),
  ...writeSlice(set, get),
  ...onboardingSlice(set, get),
  ...runSlice(set, get),
  ...templatesSlice(set, get),
  ...packsSlice(set, get),
  ...historySlice(set, get)
}))

// --------------------------------------------------------------------------
// 与 store 绑定的派生 hook
// --------------------------------------------------------------------------

/**
 * 当前工程是否已经写入过配置。
 *
 * 判据是**内容一致**而不是「配置名在不在」：只比名字的话，一个指向错误 ELF
 * （比如工程改名前的残留）的旧 launch.json 会被误判成「已完成」，反而误导人。
 *
 * 按工程分别判断也是必须的 —— 写完 A 再切到 B 时，三步引导条必须跟着重置。
 */
export function useProjectWritten(): boolean {
  return useStudio((s) => {
    if (!s.project || !s.bundle) return false
    if (s.writtenProjects.includes(s.project.root.toLowerCase())) return true

    const onDisk = s.project.vscodeFiles['launch.json']?.data
    if (!onDisk) return false
    return canonicalJson(onDisk) === canonicalJson(s.bundle.launch)
  })
}
