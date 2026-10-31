/**
 * 模板文件的统一格式（导入 / 导出）。
 *
 * ## 为什么一个文件里能装多个模板
 *
 * 用户的实际场景是「把自己调好的一整套东西备份下来 / 发给队友」。
 * 一套里既有工程配置模板（`.vscode` 那四份文件），也有模块包参数
 * （VT13 接哪个串口、VOFA 发多快）。如果强制分成两个文件导出，
 * 用户每次都要在两个地方各点一次，还得记住哪个文件是哪个。
 *
 * 所以文件格式是**一个数组**，每条自带 `kind` 区分类型，导入时按 kind 分流。
 * 别人给你一个 `我的配置.json`，直接导入，里面有什么就收什么。
 *
 * ## 为什么 kind 而不是分开 format
 *
 * 早期版本是 `format: 'cv-studio-template'` + 单个 template。
 * 现在保留对它的兼容读取（见 `parseTemplateFile`），
 * 写成新格式，老的照样能导进来。
 */

import type { ChannelBinding, ConfigTemplate, PidBinding } from './types'

// --------------------------------------------------------------------------
// 模块包模板（新增）
// --------------------------------------------------------------------------

/**
 * 模块包模板：一个模块包的一套参数 + 绑定关系。
 *
 * 为什么不跨模块包通用：参数语义完全不同 —— VT13 是「接哪个串口」，
 * VOFA 是「发多快、监看哪些通道」。硬套会让用户以为能通用，
 * 实际套上去参数全丢。所以 `packId` 是**锁死的归属**，
 * 套用时对不上就直接拒绝，而不是静默忽略。
 */
export interface PackPreset {
  id: string
  /** 归属的模块包 id，不能与别的包混用 */
  packId: string
  name: string
  note: string
  createdAt: number
  updatedAt: number

  /** 用户在「参数」卡片里选的配置 */
  params: Record<string, string | number | boolean>

  /**
   * 调参绑定 + 监看通道。
   *
   * 这两个是 vofa 特有的（VT13 没有），所以做成可选 ——
   * 存的时候有就带上，没有就不写，套用时也是有什么恢复什么。
   */
  binds?: {
    pids?: PidBinding[]
    channels?: ChannelBinding[]
    /** 是否移除旧的 vofa 文件 */
    removeLegacy?: boolean
  }
}

// --------------------------------------------------------------------------
// 文件格式
// --------------------------------------------------------------------------

export type TemplateKind = 'project' | 'pack'

/** 文件里的一条记录，用 kind 区分是哪类模板 */
export type TemplateEntry =
  | ({ kind: 'project' } & ConfigTemplate)
  | { kind: 'pack'; preset: PackPreset }

export interface TemplateFileV1 {
  format: 'cv-studio-templates'
  version: 1
  exportedAt: string
  entries: Array<
    | { kind: 'project'; template: ConfigTemplate }
    | { kind: 'pack'; preset: PackPreset }
  >
}

/** 旧格式：一个文件里只有一个工程配置模板 */
interface LegacyTemplateFile {
  format: 'cv-studio-template'
  version: number
  exportedAt?: string
  template: ConfigTemplate
}

export interface ParsedTemplateFile {
  /** 解析出多少条，按 kind 分好 */
  projectTemplates: ConfigTemplate[]
  packPresets: PackPreset[]
  /** 跳过了几条（格式不对 / 缺字段） */
  skipped: number
  /** 旧格式 / 新格式 */
  format: 'v1' | 'legacy' | 'unknown'
}

/**
 * 解析模板文件。
 *
 * 三种输入都能吃：
 *   ① 新格式（`cv-studio-templates`，entries 数组）
 *   ② 旧格式（`cv-studio-template`，单个 template）
 *   ③ 裸的一个工程配置模板对象 / 裸的 preset 对象（手写的）
 *
 * 单条解析失败只跳过那一条并计数，不让整个文件报废 ——
 * 用户从网上抄来的文件里混进一条格式不对的，不该连累其它好的。
 */
export function parseTemplateFile(raw: string): ParsedTemplateFile {
  const out: ParsedTemplateFile = {
    projectTemplates: [],
    packPresets: [],
    skipped: 0,
    format: 'unknown'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object') return out
  const obj = parsed as Record<string, unknown>

  // ① 新格式
  if (obj.format === 'cv-studio-templates' && Array.isArray(obj.entries)) {
    out.format = 'v1'
    for (const e of obj.entries as Array<Record<string, unknown>>) {
      if (!e || typeof e !== 'object') {
        out.skipped++
        continue
      }
      if (e.kind === 'project') {
        const t = normalizeProjectTemplate(e.template as Record<string, unknown> | undefined)
        if (t) out.projectTemplates.push(t)
        else out.skipped++
      } else if (e.kind === 'pack') {
        const p = normalizePackPreset(e.preset as Record<string, unknown> | undefined)
        if (p) out.packPresets.push(p)
        else out.skipped++
      } else {
        out.skipped++
      }
    }
    return out
  }

  // ② 旧格式
  if (obj.format === 'cv-studio-template' && obj.template) {
    out.format = 'legacy'
    const t = normalizeProjectTemplate(obj.template as Record<string, unknown>)
    if (t) out.projectTemplates.push(t)
    else out.skipped++
    return out
  }

  // ③ 裸对象 —— 先试工程配置模板，再试模块包模板
  const asProject = normalizeProjectTemplate(obj)
  if (asProject) {
    out.format = 'legacy'
    out.projectTemplates.push(asProject)
    return out
  }
  const asPreset = normalizePackPreset(obj)
  if (asPreset) {
    out.format = 'legacy'
    out.packPresets.push(asPreset)
    return out
  }

  out.skipped++
  return out
}

/** 校验并补全一个工程配置模板；不合格返回 null */
function normalizeProjectTemplate(t: Record<string, unknown> | undefined): ConfigTemplate | null {
  if (!t || typeof t !== 'object') return null
  if (!t.target || !t.options) return null
  return {
    ...(t as unknown as ConfigTemplate),
    // 导入时一律给新 id，不覆盖本地同名模板
    id: '',
    name: String(t.name ?? '导入的模板'),
    note: String(t.note ?? ''),
    builtin: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/** 校验并补全一个模块包模板；不合格返回 null */
function normalizePackPreset(p: Record<string, unknown> | undefined): PackPreset | null {
  if (!p || typeof p !== 'object') return null
  if (!p.packId || typeof p.packId !== 'string') return null
  if (!p.params || typeof p.params !== 'object') return null
  return {
    id: '',
    packId: p.packId,
    name: String(p.name ?? '导入的模板'),
    note: String(p.note ?? ''),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    params: p.params as Record<string, string | number | boolean>,
    binds: p.binds as PackPreset['binds']
  }
}

/** 组装导出文件内容 */
export function buildTemplateFile(
  projectTemplates: ConfigTemplate[],
  packPresets: PackPreset[]
): TemplateFileV1 {
  return {
    format: 'cv-studio-templates',
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: [
      ...projectTemplates.map((t) => ({ kind: 'project' as const, template: t })),
      ...packPresets.map((p) => ({ kind: 'pack' as const, preset: p }))
    ]
  }
}

/**
 * 给人看（和给 AI 看）的格式说明。
 *
 * 「复制格式说明」按钮就是把这个字符串塞进剪贴板 —— 用户可以直接
 * 贴给 AI，让它照着写一个模板文件。所以这段文字要能独立读懂，
 * 不能依赖界面上的其它说明。
 */
export const TEMPLATE_FORMAT_DOC = `# CV Studio 模板文件格式（.cvstudio.json）

一个文件可以装**多条**模板，混装也行 —— 导入时按每条的 kind 自动分流。

## 完整示例

{
  "format": "cv-studio-templates",
  "version": 1,
  "exportedAt": "2026-10-31T12:00:00.000Z",
  "entries": [
    {
      "kind": "project",
      "template": {
        "name": "标准步兵",
        "note": "F407 + CMSIS-DAP",
        "target": { "editor": "vscode", "buildSystem": "cmake", "probe": "cmsis-dap" },
        "options": { "device": "STM32F407IGH6", "probeServertype": "openocd" },
        "files": {
          "launch": "{ ... }",
          "tasks": "{ ... }",
          "settings": "{ ... }",
          "cCppProperties": "{ ... }"
        }
      }
    },
    {
      "kind": "pack",
      "preset": {
        "packId": "remote-vt13",
        "name": "标准步兵-VT13",
        "note": "USART1 921600",
        "params": { "usart": "USART1", "demoMode": false }
      }
    }
  ]
}

## 字段说明

### 外层
- format    固定 "cv-studio-templates"
- version   固定 1
- entries   模板数组，可以只有一条，也可以混装两类

### kind = "project"（工程配置模板）
- template.target   必填。面向什么：editor（编辑器）/ buildSystem（构建系统）/ probe（探针）
- template.options  必填。生成参数。固件名、芯片、构建目录这类从工程推导的
                    字段可以留空，套用时会按目标工程重算
- template.files    可选。四份 .vscode 文件的内容；不写就按 options 重新生成
- template.name     必填。模板名
- template.note     可选。备注
- 不需要写 id / createdAt / updatedAt —— 导入时自动生成

### kind = "pack"（模块包模板）
- preset.packId  必填。**必须是已安装的模块包 id**（例如 remote-vt13、vofa）。
                  套用时对不上会被拒绝 —— 不同模块的参数语义不通用
- preset.name    必填。模板名
- preset.note    可选
- preset.params  必填。参数键值对；没写的键用模块包定义的默认值
- preset.binds   可选。调参绑定，形如：
                 { "pids": [{"name":"chassis_kp","addr":"0x20000000"}],
                   "channels": [{"name":"chassis_speed","mirrorFrom":"chassis.left_speed"}],
                   "removeLegacy": false }

## 兼容性
- 旧版单模板格式（format: "cv-studio-template" + template）仍然可以导入
- 裸的模板对象（没有外层 format）也能导入，会按字段自动判断类型
- 单条格式不对只会跳过那一条，不影响其它
`