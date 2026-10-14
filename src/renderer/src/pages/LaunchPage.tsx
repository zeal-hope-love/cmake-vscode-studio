/**
 * 调试配置页：直接编辑 launch.json 的 configurations。
 *
 * 表单只覆盖常用字段，任何字段都能在「原始 JSON」标签里手改；
 * 这里没有「保存」按钮 —— 每次输入都即时写回 bundle（该节会被标记为
 * 「已手动修改」），真正落盘由预览 / 写入流程统一负责。
 */

import React from 'react'
import { useStudio } from '../state/store'
import { probeByKey } from '@shared/probes'
import type { LaunchConfig } from '@shared/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  PageBody,
  PageHeader,
  Select,
  Tabs,
  TextArea,
  TextInput
} from '../components/ui'
import { Icons } from '../components/icons'
import { SplitPane } from '../components/Resizable'

/** VSCode 工作区变量，生成的配置里统一用它 */
const WS = '${workspaceFolder}'

/** 「其它」是个哨兵值：选中它时用输入框自由填写 type */
const OTHER = '其它'

const TYPE_OPTIONS = ['cortex-debug', 'cppdbg', 'cppvsdbg', 'node']
const REQUEST_OPTIONS = ['launch', 'attach']
const SERVERTYPE_OPTIONS = ['openocd', 'jlink', 'stlink', 'pyocd', 'bmp', 'external']
const MIMODE_OPTIONS = ['gdb', 'lldb']
const INTERFACE_OPTIONS = ['SWD', 'JTAG']

type TemplateId = 'flash' | 'debugOnly' | 'attach' | 'native' | 'blank'

const TEMPLATES: Array<{ id: TemplateId; label: string }> = [
  { id: 'flash', label: '嵌入式：烧录并调试（停在 main）' },
  { id: 'debugOnly', label: '嵌入式：仅调试（不重新烧录）' },
  { id: 'attach', label: '嵌入式：附加到运行中的目标' },
  { id: 'native', label: '本机：gdb 调试' },
  { id: 'blank', label: '空白配置' }
]

type TabKey = 'form' | 'raw'

// --------------------------------------------------------------------------
// 读写小工具
// --------------------------------------------------------------------------

/** 把配置里的任意值读成字符串 */
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 把字符串数组读成多行文本 */
function lines(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => String(v)).join('\n') : ''
}

/** 多行文本 → 字符串数组（空行忽略） */
function splitLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 写一个字段；空值（undefined / null / 空串）表示删除该键，让 JSON 保持干净 */
function setKey<T extends Record<string, unknown>>(obj: T, key: string, value: unknown): T {
  const draft: Record<string, unknown> = { ...obj }
  if (value === undefined || value === null || value === '') delete draft[key]
  else draft[key] = value
  return draft as T
}

/** 写一个数组字段；空数组同样删除该键 */
function setList<T extends Record<string, unknown>>(obj: T, key: string, list: unknown[]): T {
  return list.length ? setKey(obj, key, list) : setKey(obj, key, undefined)
}

/** 基础下拉项；当前值不在表里时补一项，避免下拉框显示空白 */
function withCurrent(base: string[], current: string): Array<{ value: string; label: string }> {
  const options = base.map((v) => ({ value: v, label: v }))
  if (current && !base.includes(current)) options.push({ value: current, label: `其它（${current}）` })
  return options
}

// --------------------------------------------------------------------------

export default function LaunchPage(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const bundle = useStudio((s) => s.bundle)
  const options = useStudio((s) => s.options)
  const notify = useStudio((s) => s.notify)

  const configurations = bundle?.launch.configurations ?? []
  const configCount = configurations.length

  const [selected, setSelected] = React.useState(0)
  const [tab, setTab] = React.useState<TabKey>('form')
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const [templateId, setTemplateId] = React.useState<TemplateId>('flash')
  const [rawText, setRawText] = React.useState('')
  const [rawError, setRawError] = React.useState<string | null>(null)
  const [typeOther, setTypeOther] = React.useState(false)
  const [setupDraft, setSetupDraft] = React.useState('')
  const [setupError, setSetupError] = React.useState<string | null>(null)

  const activeIndex = configCount ? Math.min(selected, configCount - 1) : -1
  const config: LaunchConfig | null = activeIndex >= 0 ? configurations[activeIndex] : null

  /** 从 store 里现取一次，避免用到过期的闭包值 */
  const liveConfig = (index: number): LaunchConfig | null =>
    useStudio.getState().bundle?.launch.configurations[index] ?? null

  const syncRawFromBundle = (index: number): void => {
    const current = liveConfig(index)
    setRawText(current ? JSON.stringify(current, null, 4) : '')
    setRawError(null)
  }

  // 切换配置（或增删条目）时，重置只跟当前配置有关的本地草稿
  React.useEffect(() => {
    const current = liveConfig(activeIndex)
    setRawText(current ? JSON.stringify(current, null, 4) : '')
    setRawError(null)
    setSetupDraft(
      current && current.setupCommands !== undefined
        ? JSON.stringify(current.setupCommands, null, 4)
        : ''
    )
    setSetupError(null)
    setTypeOther(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, configCount])

  if (!bundle || !project) {
    return (
      <>
        <PageHeader title="调试配置 launch.json" />
        <PageBody>
          <EmptyState title="请先载入工程" />
        </PageBody>
      </>
    )
  }

  // ------------------------------------------------------------------------
  // 写入
  // ------------------------------------------------------------------------

  const writeConfig = (index: number, next: LaunchConfig): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live || index < 0 || index >= live.launch.configurations.length) return
    const configurations2 = live.launch.configurations.map((c, i) => (i === index ? next : c))
    state.editBundle('launch', { ...live.launch, configurations: configurations2 })
  }

  const setField = (key: string, value: unknown): void => {
    if (!config) return
    writeConfig(activeIndex, setKey(config, key, value))
  }

  const setListField = (key: string, list: unknown[]): void => {
    if (!config) return
    writeConfig(activeIndex, setList(config, key, list))
  }

  // ------------------------------------------------------------------------
  // 增删改排
  // ------------------------------------------------------------------------

  /** 按模板造一个新配置；options / project 缺失时用保守的兜底值 */
  const buildTemplate = (id: TemplateId): LaunchConfig => {
    const debugDir = options?.debugDir || 'build/Debug'
    const elfName = options?.elfName || project.elfName || 'firmware'
    const device = options?.device || project.device || ''
    const probe = probeByKey(options?.probeKey ?? 'cmsis-dap')
    const cfgFile = bundle.openocdCfg?.fileName ?? null

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
        : 'Debug: 烧录并调试（停在 main）'

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

  const addConfig = (): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const next = buildTemplate(templateId)
    const list = [...live.launch.configurations, next]
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(list.length - 1)
    setTemplateOpen(false)
    notify('ok', `已新增配置「${next.name}」`)
  }

  const duplicateConfig = (): void => {
    if (!config) return
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const copy: LaunchConfig = { ...config, name: `${text(config.name)} 副本` }
    const list = [...live.launch.configurations]
    list.splice(activeIndex + 1, 0, copy)
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(activeIndex + 1)
    notify('ok', `已复制为「${copy.name}」`)
  }

  const removeConfig = (): void => {
    if (!config) return
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const list = live.launch.configurations.filter((_, i) => i !== activeIndex)
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(Math.max(0, Math.min(activeIndex, list.length - 1)))
    notify('warn', `已删除配置「${text(config.name)}」`)
  }

  const moveConfig = (delta: number): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const list = [...live.launch.configurations]
    const target = activeIndex + delta
    if (target < 0 || target >= list.length) return
    const [item] = list.splice(activeIndex, 1)
    list.splice(target, 0, item)
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(target)
  }

  const regenerateAll = (): void => {
    const state = useStudio.getState()
    state.notify('warn', '将按当前生成参数重建全部调试配置，所有手动修改都会被覆盖')
    void state.regenerate(true)
  }

  // ------------------------------------------------------------------------
  // 编辑区
  // ------------------------------------------------------------------------

  const showCustomType = typeOther || !TYPE_OPTIONS.includes(config?.type ?? '')

  const onSetupCommandsChange = (value: string): void => {
    setSetupDraft(value)
    if (!config) return
    const trimmed = value.trim()
    if (!trimmed) {
      setSetupError(null)
      setField('setupCommands', undefined)
      return
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!Array.isArray(parsed)) {
        setSetupError('setupCommands 必须是一个 JSON 数组')
        return
      }
      setSetupError(null)
      setField('setupCommands', parsed)
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err))
    }
  }

  const applyRaw = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch (err) {
      setRawError(err instanceof Error ? err.message : String(err))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setRawError('最外层必须是一个 JSON 对象，例如 { "name": …, "type": …, "request": … }')
      return
    }
    setRawError(null)
    writeConfig(activeIndex, parsed as LaunchConfig)
    notify('ok', `已把 JSON 应用到第 ${activeIndex + 1} 个配置`)
  }

  const onlyDebug = config ? Array.isArray(config.loadFiles) : false
  const showInterface = config ? config.servertype === 'jlink' || config.interface !== undefined : false

  const form = !config ? null : (
    <>
      {/* ---- 通用字段 ---- */}
      <div className="grid grid--2">
        <Field label="名称 (name)">
          <TextInput
            value={text(config.name)}
            placeholder="例如 Debug: 烧录并调试（停在 main）"
            onChange={(e) => setField('name', e.target.value)}
          />
        </Field>

        <Field label="类型 (type)" hint="决定下面出现哪些字段">
          <Select
            value={showCustomType ? OTHER : text(config.type)}
            options={[
              ...TYPE_OPTIONS.map((v) => ({ value: v, label: v })),
              { value: OTHER, label: '其它（自定义）' }
            ]}
            onChange={(e) => {
              const value = e.target.value
              if (value === OTHER) {
                setTypeOther(true)
                return
              }
              setTypeOther(false)
              setField('type', value)
            }}
          />
          {showCustomType && (
            <TextInput
              mono
              value={text(config.type)}
              placeholder="自定义调试器类型，例如 cppvsdbg"
              onChange={(e) => setField('type', e.target.value)}
            />
          )}
        </Field>
      </div>

      <Field label="请求方式 (request)">
        <Select
          value={text(config.request)}
          options={withCurrent(REQUEST_OPTIONS, text(config.request))}
          onChange={(e) => setField('request', e.target.value)}
        />
      </Field>

      {/* ---- cortex-debug ---- */}
      {config.type === 'cortex-debug' && (
        <>
          <div className="grid grid--2">
            <Field label="servertype" hint="用哪种调试服务器">
              <Select
                value={text(config.servertype)}
                options={withCurrent(SERVERTYPE_OPTIONS, text(config.servertype))}
                onChange={(e) => setField('servertype', e.target.value)}
              />
            </Field>
            <Field label="device" hint="cortex-debug 需要的芯片型号，例如 STM32F103C8">
              <TextInput
                mono
                value={text(config.device)}
                onChange={(e) => setField('device', e.target.value)}
              />
            </Field>
            <Field label="cwd" hint="调试时的工作目录">
              <TextInput
                mono
                value={text(config.cwd)}
                onChange={(e) => setField('cwd', e.target.value)}
              />
            </Field>
            <Field label="executable" hint="要调试的 ELF 文件">
              <TextInput
                mono
                value={text(config.executable)}
                onChange={(e) => setField('executable', e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="configFiles"
            hint="每行一个 OpenOCD 配置文件路径；本工具生成的接线配置在 .vscode/ 下"
          >
            <TextArea
              rows={4}
              value={lines(config.configFiles)}
              placeholder={`${WS}/.vscode/openocd-stm32f1x-cmsis-dap.cfg`}
              onChange={(e) => setListField('configFiles', splitLines(e.target.value))}
            />
          </Field>

          <div className="grid grid--2">
            <Field label="runToEntryPoint" hint="启动后停在哪个符号，例如 main；留空表示直接运行">
              <TextInput
                mono
                value={text(config.runToEntryPoint)}
                onChange={(e) => setField('runToEntryPoint', e.target.value)}
              />
            </Field>
            <Field label="svdFile" hint="外设寄存器视图用的 .svd 文件，可留空">
              <TextInput
                mono
                value={text(config.svdFile)}
                onChange={(e) => setField('svdFile', e.target.value)}
              />
            </Field>
            <Field label="armToolchainPath" hint="arm-none-eabi-gdb 所在目录">
              <TextInput
                mono
                value={text(config.armToolchainPath)}
                onChange={(e) => setField('armToolchainPath', e.target.value)}
              />
            </Field>
            {showInterface && (
              <Field label="interface" hint="J-Link 原生调试时使用">
                <Select
                  value={text(config.interface)}
                  options={withCurrent(INTERFACE_OPTIONS, text(config.interface))}
                  onChange={(e) => setField('interface', e.target.value)}
                />
              </Field>
            )}
          </div>

          <Checkbox
            checked={onlyDebug}
            onChange={(checked) => setField('loadFiles', checked ? [] : undefined)}
            label="仅调试，不重新烧录（loadFiles: []）"
          />
        </>
      )}

      {/* ---- cppdbg ---- */}
      {config.type === 'cppdbg' && (
        <>
          <div className="grid grid--2">
            <Field label="cwd" hint="调试时的工作目录">
              <TextInput
                mono
                value={text(config.cwd)}
                onChange={(e) => setField('cwd', e.target.value)}
              />
            </Field>
            <Field label="program" hint="要调试的可执行文件">
              <TextInput
                mono
                value={text(config.program)}
                onChange={(e) => setField('program', e.target.value)}
              />
            </Field>
            <Field label="MIMode" hint="调试器后端">
              <Select
                value={text(config.MIMode)}
                options={withCurrent(MIMODE_OPTIONS, text(config.MIMode))}
                onChange={(e) => setField('MIMode', e.target.value)}
              />
            </Field>
            <Field label="miDebuggerPath" hint="gdb 可执行文件路径，留空则用 PATH 里的 gdb">
              <TextInput
                mono
                value={text(config.miDebuggerPath)}
                onChange={(e) => setField('miDebuggerPath', e.target.value)}
              />
            </Field>
          </div>

          <Field label="args" hint="每行一个传给被调试程序的参数">
            <TextArea
              rows={3}
              value={lines(config.args)}
              onChange={(e) => setListField('args', splitLines(e.target.value))}
            />
          </Field>

          <div className="flex flex-wrap mb-12">
            <Checkbox
              checked={config.stopAtEntry === true}
              onChange={(checked) => setField('stopAtEntry', checked)}
              label="stopAtEntry：启动后停在入口"
            />
            <Checkbox
              checked={config.externalConsole === true}
              onChange={(checked) => setField('externalConsole', checked)}
              label="externalConsole：用独立控制台窗口"
            />
          </div>

          <Field
            label="setupCommands"
            hint={'JSON 数组，每项形如 { "description": "…", "text": "…" }；写坏之前不会覆盖原值'}
          >
            <TextArea
              rows={5}
              value={setupDraft}
              placeholder={
                '[\n    {\n        "description": "为 gdb 启用整齐打印",\n        "text": "-enable-pretty-printing",\n        "ignoreFailures": true\n    }\n]'
              }
              onChange={(e) => onSetupCommandsChange(e.target.value)}
            />
            {setupError && <Alert kind="err">JSON 解析失败：{setupError}</Alert>}
          </Field>
        </>
      )}

      {/* ---- 其它类型 ---- */}
      {config.type !== 'cortex-debug' && config.type !== 'cppdbg' && (
        <Alert kind="info">
          类型「{config.type || '未填写'}」的字段比较多，这种类型请用「原始 JSON」标签编辑。
        </Alert>
      )}
    </>
  )

  const raw = !config ? null : (
    <>
      <Field label="configurations[i] 原始内容" hint="点「应用到该配置」才会写回 bundle">
        <TextArea
          rows={22}
          value={rawText}
          onChange={(e) => {
            setRawText(e.target.value)
            setRawError(null)
          }}
        />
      </Field>
      {rawError && <Alert kind="err">JSON 解析失败：{rawError}</Alert>}
      <div className="flex">
        <Button variant="primary" onClick={applyRaw}>
          应用到该配置
        </Button>
      </div>
    </>
  )

  return (
    <>
      <PageHeader
        title="调试配置 launch.json"
        subtitle={`${configCount} 个配置`}
        actions={
          <Button size="sm" variant="primary" onClick={regenerateAll}>
            <Icons.refresh />
            按当前参数重新生成全部配置
          </Button>
        }
      />

      <PageBody>
        {/* ---- 在 VSCode 里怎么调出来 ---- */}
        <Card title="这个配置怎么用" hint="运行和调试下拉里只有它 —— 纯烧录请用任务">
          <div className="grid grid--2">
            <div className="small" style={{ lineHeight: 1.9 }}>
              <div className="bold mb-8">调试：按 F5</div>
              <div>
                · 左侧点「运行和调试」图标（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>）， 下拉选{' '}
                <b>Debug: 烧录并调试（停在 main）</b>。
              </div>
              <div>
                · 按 <kbd>F5</kbd>：先构建 → 烧录 → 停在 <span className="mono">main</span> 等你下断点。
                <kbd>Shift</kbd>+<kbd>F5</kbd> 停止。
              </div>
              <div>
                · 它的 <span className="mono">preLaunchTask</span> 是「构建
                Debug」，编译不过就不会进调试。
              </div>
            </div>

            <div className="small" style={{ lineHeight: 1.9 }}>
              <div className="bold mb-8">只烧录、不调试：按 Ctrl+Shift+B</div>
              <div>
                · <b>「运行和调试」下拉里放不了「只烧不调」</b> —— 那里只能是调试会话。 以前试过用{' '}
                <span className="mono">noDebug</span> 冒充，实测 cortex-debug 会忽略它、 照样把 CPU halt
                住，结果是「固件烧进去了但板子不跑」。
              </div>
              <div>
                · 纯烧录走任务：<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> 跑默认生成任务 「
                <b>烧录并运行 Debug 固件</b>」—— 先构建、再烧录、烧完 reset run （OpenOCD
                跑完自己退出，全程不挂调试器）。
              </div>
              <div>
                · 想挑别的：<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> →{' '}
                <span className="mono">Tasks: Run Task</span>。
              </div>
            </div>
          </div>

          <Alert kind="info">
            ※ 两者都是<b>先构建再烧录</b>。Ninja 在源码没改动时什么都不做，这一步几乎不花时间；
            编译不过时依赖链会自动停下，不会去烧旧固件。
          </Alert>
        </Card>

        <SplitPane storageKey="launch-list" defaultWidth={300}>
          {/* ---- 左：配置列表 ---- */}
          <Card title="调试配置" hint={`${configCount} 个`}>
            {configCount === 0 ? (
              <EmptyState title="还没有调试配置">用下面的「新增 ▾」从模板创建一个。</EmptyState>
            ) : (
              <div className="list list__scroll">
                {configurations.map((c, i) => (
                  <div
                    key={`${text(c.name)}-${i}`}
                    className={i === activeIndex ? 'list__item list__item--active' : 'list__item'}
                    onClick={() => setSelected(i)}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" title={text(c.name)}>
                        {text(c.name) || '（未命名）'}
                      </div>
                    </span>
                    <Badge kind={c.request === 'attach' ? 'warn' : 'default'}>
                      {text(c.type) || '未知'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap mt-8">
              <Button size="sm" variant="primary" onClick={() => setTemplateOpen((open) => !open)}>
                新增 ▾
              </Button>
              <Button size="sm" disabled={!config} onClick={duplicateConfig}>
                复制
              </Button>
              <Button size="sm" variant="danger" disabled={!config} onClick={removeConfig}>
                删除
              </Button>
              <Button size="sm" disabled={!config || activeIndex <= 0} onClick={() => moveConfig(-1)}>
                上移
              </Button>
              <Button
                size="sm"
                disabled={!config || activeIndex >= configCount - 1}
                onClick={() => moveConfig(1)}
              >
                下移
              </Button>
            </div>

            {templateOpen && (
              <div className="mt-8">
                <Field label="从模板新增" hint="模板里的路径按当前生成参数填好，可再手动改">
                  <Select
                    value={templateId}
                    options={TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
                    onChange={(e) => setTemplateId(e.target.value as TemplateId)}
                  />
                </Field>
                <Button size="sm" variant="primary" onClick={addConfig}>
                  创建
                </Button>
              </div>
            )}
          </Card>

          {/* ---- 右：编辑区 ---- */}
          <div>
            {bundle.openocdCfg && (
              <Alert kind="accent">
                cortex-debug 的 <span className="mono">configFiles</span> 应指向{' '}
                <span className="mono">.vscode/{bundle.openocdCfg.fileName}</span> —— 本工具会把这个
                OpenOCD 接线配置一起写进工程。
              </Alert>
            )}

            {!project.isEmbedded && (
              <Alert kind="info">
                这是一个通用 CMake 工程（没识别到 .ioc / 芯片型号）：建议用 cppdbg 做本机 gdb
                调试，嵌入式那几套模板里的路径需要自己改。
              </Alert>
            )}

            {!config ? (
              <Card title="配置详情">
                <EmptyState title="没有选中的配置" />
              </Card>
            ) : (
              <Card
                title={text(config.name) || '（未命名）'}
                hint={`第 ${activeIndex + 1} / ${configCount} 个`}
              >
                <Tabs
                  value={tab}
                  onChange={(next) => {
                    // 切到原始 JSON 时重新生成文本，避免把表单里的新改动盖回去
                    if (next === 'raw') syncRawFromBundle(activeIndex)
                    setTab(next)
                  }}
                  tabs={[
                    { key: 'form', label: '表单' },
                    { key: 'raw', label: '原始 JSON' }
                  ]}
                />
                {tab === 'form' ? form : raw}
              </Card>
            )}
          </div>
        </SplitPane>
      </PageBody>
    </>
  )
}
