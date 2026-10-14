/**
 * 工作区设置页：把 .vscode/settings.json 里的一堆键值对变成能看懂、能直接改的表格。
 *
 * settings.json 的键是开放集合（cortex-debug / cmake / C_Cpp / files 各自一堆），
 * 穷举所有键没有意义，所以这里的做法是：
 *   1. 生成器产出的键照常展示，值按类型给出对应的输入控件；
 *   2. 常用键给快捷入口 + 贴合本工程的默认值建议；
 *   3. 兜底留一个「原始 JSON」区域，任何结构都能整体改。
 * 所有写回都走 store 的 editSettings，会被标记为「已手动修改」。
 */

import React from 'react'
import { useStudio } from '../state/store'
import type { GenOptions, SettingsFile, ToolPaths } from '@shared/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Modal,
  PageBody,
  PageHeader,
  Select,
  TextArea,
  TextInput
} from '../components/ui'
import { NoProject } from '../components/NoProject'
import { Icons } from '../components/icons'

/** VSCode 的工程根变量，写进配置里统一用它 */
const WS = '${workspaceFolder}'

type ValueKind = 'string' | 'number' | 'boolean' | 'json'

/** 新增键时可选的值类型（与表格里展示的类型名保持一致） */
const KIND_OPTIONS: Array<{ value: ValueKind; label: string }> = [
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'json', label: 'JSON（数组 / 对象）' }
]

/** Windows 反斜杠 → 正斜杠：写进 VSCode 配置的路径统一用正斜杠 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 值的类型名，直接展示给用户看 */
function valueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'string':
      return 'string'
    case 'object':
      return 'object'
    default:
      return typeof value
  }
}

/** 只有数组 / 对象 / null 才需要开弹窗编辑（标量在表格里直接改） */
function needsJsonEditor(value: unknown): boolean {
  return value === null || typeof value === 'object'
}

// --------------------------------------------------------------------------
// 常用键的默认值建议
// --------------------------------------------------------------------------

interface QuickContext {
  options: GenOptions | null
  tools: ToolPaths | null
}

interface QuickKey {
  key: string
  label: string
  kind: ValueKind
  /** 按当前工程的生成参数算出建议值 */
  suggest: (ctx: QuickContext) => unknown
}

/** 建议值统一转成输入框里的文本 */
function suggestText(value: unknown, kind: ValueKind): string {
  if (value === undefined || value === null) return ''
  if (kind === 'json') return JSON.stringify(value, null, 4)
  return String(value)
}

const QUICK_KEYS: QuickKey[] = [
  {
    key: 'cortex-debug.openocdPath.windows',
    label: 'cortex-debug.openocdPath.windows —— OpenOCD 路径',
    kind: 'string',
    suggest: (c) => toPosix(c.tools?.items.openocd?.path ?? '')
  },
  {
    key: 'cortex-debug.armToolchainPath.windows',
    label: 'cortex-debug.armToolchainPath.windows —— Arm 工具链目录',
    kind: 'string',
    suggest: (c) => toPosix(c.tools?.toolchainDir ?? '')
  },
  {
    key: 'cmake.generator',
    label: 'cmake.generator —— CMake 生成器',
    kind: 'string',
    suggest: (c) => c.options?.generator ?? 'Ninja'
  },
  {
    key: 'cmake.buildDirectory',
    label: 'cmake.buildDirectory —— 构建目录模板',
    kind: 'string',
    suggest: () => WS + '/build/${buildType}'
  },
  {
    key: 'cmake.configureOnOpen',
    label: 'cmake.configureOnOpen —— 打开工程自动配置',
    kind: 'boolean',
    suggest: () => false
  },
  {
    key: 'C_Cpp.default.compileCommands',
    label: 'C_Cpp.default.compileCommands —— IntelliSense 编译数据库',
    kind: 'string',
    suggest: (c) => (c.options ? `${WS}/${c.options.debugDir}/compile_commands.json` : '')
  },
  {
    key: 'clangd.arguments',
    label: 'clangd.arguments —— clangd 启动参数',
    kind: 'json',
    suggest: (c) => (c.options ? [`--compile-commands-dir=${WS}/${toPosix(c.options.debugDir)}`] : [])
  },
  {
    key: 'files.associations',
    label: 'files.associations —— 文件类型关联',
    kind: 'json',
    suggest: () => ({ '*.h': 'c' })
  },
  {
    key: 'files.exclude',
    label: 'files.exclude —— 资源管理器隐藏项',
    kind: 'json',
    suggest: () => ({ '**/.git': true, '**/.svn': true, '**/.DS_Store': true })
  },
  {
    key: 'cmake.sourceDirectory',
    label: 'cmake.sourceDirectory —— CMake 源码目录',
    kind: 'string',
    suggest: () => WS
  }
]

// --------------------------------------------------------------------------

export default function SettingsPage(): React.JSX.Element {
  const bundle = useStudio((s) => s.bundle)
  const project = useStudio((s) => s.project)
  const tools = useStudio((s) => s.tools)
  const options = useStudio((s) => s.options)

  const settings: SettingsFile = bundle?.settings ?? {}
  const settingsJson = React.useMemo(() => JSON.stringify(settings, null, 4), [settings])
  const settingKeys = Object.keys(settings)

  // ---- 原始 JSON 区域 ----
  const [rawOpen, setRawOpen] = React.useState(false)
  const [rawText, setRawText] = React.useState(settingsJson)
  const [rawError, setRawError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setRawText(settingsJson)
    setRawError(null)
  }, [settingsJson])

  // ---- 数组 / 对象的 JSON 编辑弹窗 ----
  const [editingKey, setEditingKey] = React.useState<string | null>(null)
  const [modalText, setModalText] = React.useState('')
  const [modalError, setModalError] = React.useState<string | null>(null)

  // ---- 数字输入框的草稿：允许先清空再重打，失焦 / 回车才写回 ----
  const [numberDraft, setNumberDraft] = React.useState<Record<string, string>>({})

  // ---- 新增键 ----
  const [quickKey, setQuickKey] = React.useState('')
  const [newKey, setNewKey] = React.useState('')
  const [newKind, setNewKind] = React.useState<ValueKind>('string')
  const [newValue, setNewValue] = React.useState('')

  if (!bundle) {
    return (
      <>
        <PageHeader title="设置 settings.json" subtitle="还没有选择工程" />
        <PageBody>
          <NoProject reason="设置项里的 OpenOCD 路径、cmake 配置都由工程检测结果填出来。" />
        </PageBody>
      </>
    )
  }

  const notify = (kind: 'ok' | 'warn' | 'err', text: string): void => {
    useStudio.getState().notify(kind, text)
  }

  /** 写回 settings（会自动把该节标记为「已手动修改」） */
  const edit = (next: SettingsFile): void => {
    useStudio.getState().editSettings(next)
  }

  const fileState = project?.vscodeFiles['settings.json'] ?? null

  // ------------------------------------------------------------------------
  // 顶部提示：这个文件现在是新建、坏的、还是会被整体覆盖
  // ------------------------------------------------------------------------

  const fileAlert =
    fileState && fileState.exists === false ? (
      <Alert kind="info">该文件还不存在，写入时会新建，不会有内容被覆盖</Alert>
    ) : fileState && fileState.valid === false ? (
      <Alert kind="err">现有文件无法解析：{fileState.error ?? '未知错误'}，写入后会被整体覆盖</Alert>
    ) : fileState ? (
      <Alert kind="warn">已存在的 settings.json 会被整体覆盖（本工具按『直接覆盖』策略写入）</Alert>
    ) : null

  // ------------------------------------------------------------------------
  // 写操作
  // ------------------------------------------------------------------------

  /** 一键把探测到的 OpenOCD / Arm 工具链路径填进 cortex-debug 的 4 个键 */
  const fillToolPaths = (): void => {
    const openocd = tools?.items.openocd?.path ?? ''
    const toolchain = tools?.toolchainDir ?? ''
    const next: SettingsFile = { ...settings }
    const missing: string[] = []

    if (openocd) {
      const p = toPosix(openocd)
      next['cortex-debug.openocdPath.windows'] = p
      next['cortex-debug.openocdPath'] = p
    } else {
      missing.push('OpenOCD（openocd.exe）')
    }

    if (toolchain) {
      const p = toPosix(toolchain)
      next['cortex-debug.armToolchainPath.windows'] = p
      next['cortex-debug.armToolchainPath'] = p
    } else {
      missing.push('Arm 工具链目录')
    }

    if (!openocd && !toolchain) {
      notify('warn', `没有探测到可用工具：${missing.join('、')}。请到「工具链」页手动指定或重新探测。`)
      return
    }

    edit(next)
    if (missing.length) {
      notify('warn', `已填入探测到的路径，但没找到：${missing.join('、')}`)
    } else {
      notify('ok', '已填入探测到的 OpenOCD 与 Arm 工具链路径')
    }
  }

  const removeKey = (key: string): void => {
    const next: SettingsFile = { ...settings }
    delete next[key]
    edit(next)
    notify('ok', `已删除设置「${key}」`)
  }

  /** 数字输入：失焦 / 回车时提交，非法值还原 */
  const commitNumber = (key: string): void => {
    const draft = numberDraft[key]
    if (draft === undefined) return
    const clearDraft = (): void =>
      setNumberDraft((d) => {
        const copy = { ...d }
        delete copy[key]
        return copy
      })

    const n = Number(draft)
    if (draft.trim() === '' || Number.isNaN(n)) {
      notify('warn', `「${key}」不是合法数字，已还原原值`)
      clearDraft()
      return
    }
    edit({ ...settings, [key]: n })
    clearDraft()
  }

  const openJsonEditor = (key: string): void => {
    setEditingKey(key)
    setModalText(JSON.stringify(settings[key], null, 4))
    setModalError(null)
  }

  const closeJsonEditor = (): void => {
    setEditingKey(null)
    setModalError(null)
  }

  const applyJsonEditor = (): void => {
    if (editingKey === null) return
    try {
      const parsed: unknown = JSON.parse(modalText)
      edit({ ...settings, [editingKey]: parsed })
      notify('ok', `已更新设置「${editingKey}」`)
      closeJsonEditor()
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err))
    }
  }

  const applyRaw = (): void => {
    try {
      const parsed: unknown = JSON.parse(rawText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('顶层必须是一个 JSON 对象')
      }
      edit(parsed as SettingsFile)
      setRawError(null)
      notify('ok', '已用原始 JSON 整体替换 settings.json')
    } catch (err) {
      setRawError(err instanceof Error ? err.message : String(err))
    }
  }

  const addKey = (): void => {
    const key = newKey.trim()
    if (!key) {
      notify('warn', '请先填写键名')
      return
    }
    if (key in settings) {
      notify('warn', `键「${key}」已存在，请直接在上面的表格里改它的值`)
      return
    }

    let value: unknown
    if (newKind === 'number') {
      const n = Number(newValue.trim())
      if (newValue.trim() === '' || Number.isNaN(n)) {
        notify('warn', '数字类型的值不合法')
        return
      }
      value = n
    } else if (newKind === 'boolean') {
      value = newValue === 'true'
    } else if (newKind === 'json') {
      try {
        value = JSON.parse(newValue)
      } catch (err) {
        notify('err', `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
        return
      }
    } else {
      value = newValue
    }

    edit({ ...settings, [key]: value })
    notify('ok', `已添加设置「${key}」`)
    setNewKey('')
    setNewValue('')
    setQuickKey('')
  }

  /** 选中常用键：把键名、类型、建议值一次性填进表单 */
  const pickQuickKey = (key: string): void => {
    setQuickKey(key)
    if (key === '__custom__' || key === '') return
    const preset = QUICK_KEYS.find((q) => q.key === key)
    if (!preset) return
    setNewKey(preset.key)
    setNewKind(preset.kind)
    setNewValue(suggestText(preset.suggest({ options, tools }), preset.kind))
  }

  // ------------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------------

  /** 表格里的「值」单元格：按类型给控件 */
  const renderValue = (key: string, value: unknown): React.ReactNode => {
    if (typeof value === 'boolean') {
      return (
        <Checkbox
          checked={value}
          label={value ? 'true' : 'false'}
          onChange={(checked) => edit({ ...settings, [key]: checked })}
        />
      )
    }

    if (typeof value === 'number') {
      return (
        <div style={{ maxWidth: 220 }}>
          <TextInput
            type="number"
            mono
            value={numberDraft[key] ?? String(value)}
            onChange={(e) => setNumberDraft((d) => ({ ...d, [key]: e.target.value }))}
            onBlur={() => commitNumber(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNumber(key)
            }}
          />
        </div>
      )
    }

    if (typeof value === 'string') {
      return (
        <TextInput mono value={value} onChange={(e) => edit({ ...settings, [key]: e.target.value })} />
      )
    }

    // 数组 / 对象 / null：显示摘要，点「编辑」开弹窗改 JSON
    const summary = value === null ? 'null' : JSON.stringify(value)
    return (
      <span className="mono truncate" title={summary}>
        {summary}
      </span>
    )
  }

  const rows = settingKeys.map((key) => {
    const value = settings[key]
    return {
      key,
      cells: [
        <span key="k" className="mono bold">
          {key}
        </span>,
        <Badge key="t">{valueKind(value)}</Badge>,
        <div key="v" style={{ minWidth: 180 }}>
          {renderValue(key, value)}
        </div>,
        <div key="a" className="flex">
          {needsJsonEditor(value) && (
            <Button size="sm" variant="ghost" onClick={() => openJsonEditor(key)}>
              编辑
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={() => removeKey(key)}>
            删除
          </Button>
        </div>
      ]
    }
  })

  const quickOptions = [
    { value: '', label: '— 选择常用键 —' },
    ...QUICK_KEYS.map((q) => ({ value: q.key, label: q.label })),
    { value: '__custom__', label: '自定义键' }
  ]

  return (
    <>
      <PageHeader
        title="设置 settings.json"
        subtitle={`${settingKeys.length} 项设置`}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void useStudio.getState().regenerate(true)}
            >
              <Icons.refresh />
              按当前参数重新生成全部配置
            </Button>
            <Button size="sm" onClick={fillToolPaths}>
              <Icons.tools />
              一键填入探测到的工具路径
            </Button>
          </>
        }
      />

      <PageBody>
        {fileAlert}

        {/* ---- 键值对表格 ---- */}
        <Card title="设置项" hint="值按类型直接编辑；数组与对象点「编辑」用 JSON 改" flush>
          <DataTable
            columns={[
              { key: 'key', title: '键', width: '34%' },
              { key: 'kind', title: '值类型', width: 90 },
              { key: 'value', title: '值' },
              { key: 'ops', title: '操作', width: 140 }
            ]}
            rows={rows}
            empty={
              <EmptyState title="还没有任何设置项">
                可以用下面的「新增设置项」添加，或者在「原始 JSON」里整体粘贴一份。
              </EmptyState>
            }
          />
        </Card>

        {/* ---- 新增键 ---- */}
        <Card title="新增设置项" hint="常用键一键带出建议值，键名与值都还能改">
          <div className="row mb-12">
            <div className="grow">
              <Field label="常用键">
                <Select
                  value={quickKey}
                  options={quickOptions}
                  onChange={(e) => pickQuickKey(e.target.value)}
                />
              </Field>
            </div>
            <div className="grow">
              <Field label="键名" hint="点「添加」前确认键名没有拼错">
                <TextInput
                  mono
                  value={newKey}
                  placeholder="例如 cmake.generator"
                  onChange={(e) => {
                    setNewKey(e.target.value)
                    setQuickKey('__custom__')
                  }}
                />
              </Field>
            </div>
          </div>

          <div className="row">
            <div style={{ width: 170 }}>
              <Field label="值类型">
                <Select
                  value={newKind}
                  options={KIND_OPTIONS}
                  onChange={(e) => setNewKind(e.target.value as ValueKind)}
                />
              </Field>
            </div>

            <div className="grow">
              {newKind === 'boolean' ? (
                <Field label="值">
                  <Select
                    value={newValue === 'true' ? 'true' : 'false'}
                    options={[
                      { value: 'true', label: 'true' },
                      { value: 'false', label: 'false' }
                    ]}
                    onChange={(e) => setNewValue(e.target.value)}
                  />
                </Field>
              ) : newKind === 'json' ? (
                <Field label="值（JSON）" hint="数组或对象，必须能被 JSON.parse 解析">
                  <TextArea
                    rows={4}
                    value={newValue}
                    placeholder='例如 ["--compile-commands-dir=${workspaceFolder}/build/Debug"]'
                    onChange={(e) => setNewValue(e.target.value)}
                  />
                </Field>
              ) : (
                <Field label="值">
                  <TextInput
                    mono
                    type={newKind === 'number' ? 'number' : 'text'}
                    value={newValue}
                    placeholder={newKind === 'number' ? '例如 1000' : '例如 Ninja'}
                    onChange={(e) => setNewValue(e.target.value)}
                  />
                </Field>
              )}
            </div>

            <Button variant="primary" onClick={addKey} style={{ marginBottom: 12 }}>
              添加
            </Button>
          </div>
        </Card>

        {/* ---- 原始 JSON 兜底 ---- */}
        <Card
          title="原始 JSON"
          hint="万能退路：任何结构都能在这里整体改"
          actions={
            <Button size="sm" variant="ghost" onClick={() => setRawOpen((v) => !v)}>
              {rawOpen ? '收起' : '展开'}
            </Button>
          }
        >
          {rawOpen ? (
            <>
              {rawError && <Alert kind="err">JSON 解析失败：{rawError}（没有写回）</Alert>}
              <Field label="settings.json 全文" hint="点「应用」会整体替换当前设置，其它键会被丢弃">
                <TextArea
                  rows={18}
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  style={{ minHeight: 260 }}
                />
              </Field>
              <div className="flex">
                <Button variant="primary" onClick={applyRaw}>
                  应用
                </Button>
                <Button onClick={() => setRawText(settingsJson)}>还原</Button>
                <div className="spacer" />
                <span className="faint small">当前共 {settingKeys.length} 个键</span>
              </div>
            </>
          ) : (
            <span className="faint small">
              展开后可以直接编辑整份 settings.json 文本，适合批量粘贴别人的配置。
            </span>
          )}
        </Card>
      </PageBody>

      {/* ---- 数组 / 对象编辑弹窗 ---- */}
      {editingKey !== null && (
        <Modal
          title={`编辑「${editingKey}」`}
          width={720}
          onClose={closeJsonEditor}
          footer={
            <>
              <Button onClick={closeJsonEditor}>取消</Button>
              <Button variant="primary" onClick={applyJsonEditor}>
                确认
              </Button>
            </>
          }
        >
          {modalError && <Alert kind="err">JSON 解析失败：{modalError}（没有写回）</Alert>}
          <Field label="值（JSON）" hint="确认时按 JSON.parse 解析，失败不会写回">
            <TextArea
              rows={14}
              value={modalText}
              onChange={(e) => setModalText(e.target.value)}
              style={{ minHeight: 220 }}
            />
          </Field>
        </Modal>
      )}
    </>
  )
}
