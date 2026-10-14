/**
 * IntelliSense 页：可视化编辑 .vscode/c_cpp_properties.json。
 *
 * 一份配置里真正影响跳转准确度的就三样：compileCommands、includePath、defines，
 * 其余（标准、intelliSenseMode）给常见值下拉。左侧是配置列表（可以有多组，
 * 例如 STM32 与本机两套），右侧是表单 / 原始 JSON 两个视角。
 */

import React from 'react'
import { useStudio } from '../state/store'
import type { CppConfiguration } from '@shared/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  PageBody,
  PageHeader,
  Select,
  Tabs,
  TextArea,
  TextInput
} from '../components/ui'
import { NoProject } from '../components/NoProject'
import { Icons } from '../components/icons'
import { SplitPane } from '../components/Resizable'

/** VSCode 的工程根变量 */
const WS = '${workspaceFolder}'

/** Windows 反斜杠 → 正斜杠 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 绝对路径 → 相对工程根的正斜杠路径；本来就不在工程内则原样返回（只转正斜杠） */
function projectRelative(root: string, target: string): string {
  const norm = (p: string): string => toPosix(p).replace(/\/+$/, '')
  const r = norm(root)
  const t = norm(target)
  if (r && t.toLowerCase().startsWith(r.toLowerCase() + '/')) return t.slice(r.length + 1)
  return t
}

/** include 路径：盘符开头的绝对路径原样保留，其余按工程内相对路径补 ${workspaceFolder} */
function includeEntry(dir: string): string {
  const p = toPosix(dir)
  return /^[A-Za-z]:/.test(p) ? p : `${WS}/${p}`
}

/** 空串 / 空数组就删掉这个键，让生成出来的 JSON 保持干净 */
function setOrDelete(config: CppConfiguration, key: string, value: unknown): void {
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  if (empty) delete config[key]
  else config[key] = value
}

/** 多行文本 → 字符串数组（写回 bundle 前清洗掉空行与首尾空格） */
function linesToArray(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * 多行列表字段（includePath / defines / forcedInclude）。
 *
 * 写回时要清洗空行，但输入框必须原样保留用户正在敲的文本 —— 否则在末尾按回车
 * 会被立刻吃掉，永远加不了新行。所以这里用一份本地草稿：草稿只在「值被外部改掉」
 * （切换配置、重新生成）时丢弃，自己敲出来的改动不会丢。
 */
function LinesField(props: {
  label: string
  hint?: string
  rows: number
  placeholder?: string
  value: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const canonical = props.value.join('\n')
  const [draft, setDraft] = React.useState<string | null>(null)
  const selfRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (selfRef.current === canonical) {
      selfRef.current = null
      return
    }
    setDraft(null)
  }, [canonical])

  return (
    <Field label={props.label} hint={props.hint}>
      <TextArea
        rows={props.rows}
        placeholder={props.placeholder}
        value={draft ?? canonical}
        onChange={(e) => {
          const text = e.target.value
          const next = linesToArray(text)
          selfRef.current = next.join('\n')
          setDraft(text)
          props.onChange(next)
        }}
      />
    </Field>
  )
}

/** 下拉选项：一个「未设置」+ 常见值 + 当前的非标准值（避免选择框显示成空白） */
function choiceOptions(
  values: string[],
  current: string | undefined,
  emptyLabel = '未设置'
): Array<{ value: string; label: string }> {
  const list = [{ value: '', label: emptyLabel }]
  for (const v of values) list.push({ value: v, label: v })
  if (current && !values.includes(current)) list.push({ value: current, label: `${current}（当前值）` })
  return list
}

const C_STANDARDS = ['c11', 'c17', 'c99', 'c89', 'gnu11', 'gnu17']
const CPP_STANDARDS = ['c++17', 'c++20', 'c++23', 'c++14', 'gnu++17']
const INTELLISENSE_MODES = [
  'windows-gcc-arm',
  'windows-gcc-x64',
  'windows-clang-x64',
  'linux-gcc-arm',
  'linux-gcc-x64',
  'macos-clang-arm64'
]

export default function CppPage(): React.JSX.Element {
  const bundle = useStudio((s) => s.bundle)
  const project = useStudio((s) => s.project)

  const configurations = bundle?.cpp.configurations ?? []
  const [selected, setSelected] = React.useState(0)
  const [tab, setTab] = React.useState<'form' | 'json'>('form')

  // ---- 原始 JSON ----
  const [jsonText, setJsonText] = React.useState('')
  const [jsonError, setJsonError] = React.useState<string | null>(null)

  // ---- browse（可选对象）----
  const [browseOpen, setBrowseOpen] = React.useState(false)
  const [browseText, setBrowseText] = React.useState('')
  const [browseError, setBrowseError] = React.useState<string | null>(null)

  const config: CppConfiguration | null = configurations[selected] ?? null

  const configJson = React.useMemo(() => JSON.stringify(config ?? {}, null, 4), [config])
  const browseJson = React.useMemo(
    () => JSON.stringify((config?.browse as unknown) ?? {}, null, 4),
    [config]
  )

  // 换选中项或改了配置，原始 JSON 文本跟着重置
  React.useEffect(() => {
    setJsonText(configJson)
    setJsonError(null)
  }, [configJson])

  React.useEffect(() => {
    setBrowseText(browseJson)
    setBrowseError(null)
  }, [browseJson])

  // 删掉配置后把下标夹回合法范围
  React.useEffect(() => {
    if (configurations.length && selected >= configurations.length) {
      setSelected(configurations.length - 1)
    } else if (!configurations.length && selected !== 0) {
      setSelected(0)
    }
  }, [configurations.length, selected])

  if (!bundle) {
    return (
      <>
        <PageHeader title="IntelliSense c_cpp_properties.json" subtitle="还没有选择工程" />
        <PageBody>
          <NoProject reason="头文件路径和宏定义要从工程的 CMakeLists 里解析出来。" />
        </PageBody>
      </>
    )
  }

  const notify = (kind: 'ok' | 'warn' | 'err', text: string): void => {
    useStudio.getState().notify(kind, text)
  }

  /** 用新的 configurations 数组写回 bundle（会被标记为「已手动修改」） */
  const writeConfigs = (configs: CppConfiguration[]): void => {
    const b = useStudio.getState().bundle
    if (!b) return
    useStudio.getState().editBundle('cpp', { ...b.cpp, configurations: configs })
  }

  /** 在「当前选中的配置」上做一次改动 */
  const applyToSelected = (mutate: (config: CppConfiguration) => void): void => {
    const b = useStudio.getState().bundle
    if (!b || selected < 0 || selected >= b.cpp.configurations.length) return
    const configs = b.cpp.configurations.map((c, i) => {
      if (i !== selected) return c
      const next: CppConfiguration = { ...c }
      mutate(next)
      return next
    })
    writeConfigs(configs)
  }

  // ------------------------------------------------------------------------
  // 列表操作
  // ------------------------------------------------------------------------

  const addConfig = (): void => {
    const b = useStudio.getState().bundle
    if (!b) return
    const configs = [...b.cpp.configurations, { name: `配置 ${b.cpp.configurations.length + 1}` }]
    writeConfigs(configs)
    setSelected(configs.length - 1)
    setTab('form')
    notify('ok', '已新增一组配置')
  }

  const duplicateConfig = (): void => {
    if (!config) return
    const b = useStudio.getState().bundle
    if (!b) return
    const copy: CppConfiguration = { ...config, name: `${config.name || '配置'} 副本` }
    const configs = [...b.cpp.configurations]
    configs.splice(selected + 1, 0, copy)
    writeConfigs(configs)
    setSelected(selected + 1)
    setTab('form')
    notify('ok', `已复制出「${copy.name}」`)
  }

  const deleteConfig = (): void => {
    if (!config) return
    const b = useStudio.getState().bundle
    if (!b) return
    const configs = b.cpp.configurations.filter((_, i) => i !== selected)
    writeConfigs(configs)
    setSelected(Math.max(0, Math.min(selected, configs.length - 1)))
    notify('ok', `已删除配置「${config.name || '未命名'}」`)
  }

  const moveConfig = (delta: number): void => {
    const b = useStudio.getState().bundle
    if (!b) return
    const target = selected + delta
    if (target < 0 || target >= b.cpp.configurations.length) return
    const configs = [...b.cpp.configurations]
    const [item] = configs.splice(selected, 1)
    configs.splice(target, 0, item)
    writeConfigs(configs)
    setSelected(target)
  }

  // ------------------------------------------------------------------------
  // 用工程检测结果重新填充
  // ------------------------------------------------------------------------

  const refillFromProject = (): void => {
    const state = useStudio.getState()
    const b = state.bundle
    const p = state.project
    if (!b || !p) {
      state.notify('warn', '还没有选择工程')
      return
    }
    const o = state.options

    // 没有配置就先建一个，再往里填
    const configs = [...b.cpp.configurations]
    if (!configs.length) configs.push({ name: '' })
    const index = selected >= 0 && selected < configs.length ? selected : 0
    const current = configs[index]

    // compile_commands：某个构建目录里已经生成了就优先用它
    const builtCompileCommands =
      p.buildDirs.find((dir) => (dir.compileCommands ?? '').trim() !== '')?.compileCommands ?? ''
    const compileCommands = builtCompileCommands
      ? `${WS}/${projectRelative(p.root, builtCompileCommands)}`
      : `${WS}/${o?.debugDir ?? 'build/Debug'}/compile_commands.json`

    const next: CppConfiguration = { ...current }
    next.name = p.isEmbedded ? 'STM32' : 'CMake'
    next.compileCommands = compileCommands
    next.includePath = [`${WS}/**`, ...p.includeDirs.map(includeEntry)]
    next.defines = p.defines
    next.cStandard = o?.cStandard ?? current.cStandard ?? 'c11'
    next.cppStandard = o?.cppStandard ?? current.cppStandard ?? 'c++17'
    next.intelliSenseMode = p.isEmbedded ? 'windows-gcc-arm' : 'windows-gcc-x64'
    configs[index] = next

    writeConfigs(configs)
    setSelected(index)
    setTab('form')
    state.notify('ok', `已用工程检测结果重新填充「${next.name}」`)
  }

  // ------------------------------------------------------------------------
  // 原始 JSON / browse
  // ------------------------------------------------------------------------

  const applyJson = (): void => {
    if (!config) return
    try {
      const parsed: unknown = JSON.parse(jsonText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('一组配置必须是一个 JSON 对象')
      }
      const raw = parsed as Record<string, unknown>
      const next: CppConfiguration = { ...config }
      for (const [k, v] of Object.entries(raw)) next[k] = v
      if (typeof raw.name !== 'string' || !raw.name) next.name = config.name || '配置'

      const b = useStudio.getState().bundle
      if (!b) return
      writeConfigs(b.cpp.configurations.map((c, i) => (i === selected ? next : c)))
      setJsonError(null)
      notify('ok', '已应用原始 JSON')
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err))
    }
  }

  const applyBrowse = (): void => {
    try {
      const parsed: unknown = JSON.parse(browseText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('browse 必须是一个 JSON 对象')
      }
      applyToSelected((c) => setOrDelete(c, 'browse', parsed))
      setBrowseError(null)
      setBrowseOpen(false)
      notify('ok', '已更新 browse')
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err))
    }
  }

  // ------------------------------------------------------------------------

  const listItems = configurations.map((c, i) => (
    <div
      key={i}
      className={i === selected ? 'list__item list__item--active' : 'list__item'}
      onClick={() => {
        setSelected(i)
        setTab('form')
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <div className="mono truncate" title={c.name || '（未命名）'}>
          {c.name || '（未命名）'}
        </div>
        <div className="faint small">
          includePath {c.includePath?.length ?? 0} 项 · defines {c.defines?.length ?? 0} 项
        </div>
      </span>
      {c.compileCommands ? (
        <Badge kind="ok" title={c.compileCommands}>
          编译数据库
        </Badge>
      ) : (
        <Badge kind="warn">无 compileCommands</Badge>
      )}
    </div>
  ))

  const formTab = config ? (
    <>
      <Field label="配置名" hint="显示在 VSCode 状态栏与命令面板里，例如 STM32 / CMake">
        <TextInput
          value={config.name ?? ''}
          placeholder="STM32"
          onChange={(e) => applyToSelected((c) => (c.name = e.target.value))}
        />
      </Field>

      <Field
        label="compileCommands"
        hint={`编译数据库路径，指向 ${WS}/build/Debug/compile_commands.json，IntelliSense 靠它做精确跳转`}
      >
        <TextInput
          mono
          value={config.compileCommands ?? ''}
          placeholder={`${WS}/build/Debug/compile_commands.json`}
          onChange={(e) => applyToSelected((c) => setOrDelete(c, 'compileCommands', e.target.value))}
        />
      </Field>

      <LinesField
        label="includePath"
        hint={`每行一个路径，支持 ${WS}/** 这类变量；留空则删掉这个键`}
        rows={10}
        placeholder={`${WS}/**\nCore/Inc\nDrivers/STM32F1xx_HAL_Driver/Inc`}
        value={config.includePath ?? []}
        onChange={(next) => applyToSelected((c) => setOrDelete(c, 'includePath', next))}
      />

      <LinesField
        label="defines"
        hint="每行一个宏，不带 -D 前缀；留空则删掉这个键"
        rows={6}
        placeholder={'USE_HAL_DRIVER\nSTM32F103xB'}
        value={config.defines ?? []}
        onChange={(next) => applyToSelected((c) => setOrDelete(c, 'defines', next))}
      />

      <LinesField
        label="forcedInclude"
        hint="每行一个必须强制包含的头文件（例如 stm32f1xx.h）；一般留空"
        rows={4}
        placeholder="Core/Inc/stm32f1xx.h"
        value={config.forcedInclude ?? []}
        onChange={(next) => applyToSelected((c) => setOrDelete(c, 'forcedInclude', next))}
      />

      <div className="grid grid--2">
        <Field label="cStandard" hint="C 语言标准">
          <Select
            value={config.cStandard ?? ''}
            options={choiceOptions(C_STANDARDS, config.cStandard)}
            onChange={(e) => applyToSelected((c) => setOrDelete(c, 'cStandard', e.target.value))}
          />
        </Field>

        <Field label="cppStandard" hint="C++ 语言标准">
          <Select
            value={config.cppStandard ?? ''}
            options={choiceOptions(CPP_STANDARDS, config.cppStandard)}
            onChange={(e) => applyToSelected((c) => setOrDelete(c, 'cppStandard', e.target.value))}
          />
        </Field>
      </div>

      <Field
        label="intelliSenseMode"
        hint="嵌入式 Arm 工程用 windows-gcc-arm；本机 GCC 用 windows-gcc-x64"
      >
        <Select
          value={config.intelliSenseMode ?? ''}
          options={choiceOptions(INTELLISENSE_MODES, config.intelliSenseMode)}
          onChange={(e) => applyToSelected((c) => setOrDelete(c, 'intelliSenseMode', e.target.value))}
        />
      </Field>

      {/* ---- browse：可选对象，需要时再展开 ---- */}
      <div className="divider" />
      <div className="flex mb-8">
        <span className="small muted">browse（可选，控制「转到定义」的索引范围）</span>
        <div className="spacer" />
        <Button size="sm" variant="ghost" onClick={() => setBrowseOpen((v) => !v)}>
          {browseOpen ? '收起' : '展开'}
        </Button>
        {config.browse !== undefined && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              applyToSelected((c) => setOrDelete(c, 'browse', undefined))
              setBrowseOpen(false)
              notify('ok', '已删除 browse')
            }}
          >
            删除 browse
          </Button>
        )}
      </div>

      {browseOpen && (
        <>
          {browseError && <Alert kind="err">JSON 解析失败：{browseError}（没有写回）</Alert>}
          <Field label="browse（JSON 对象）" hint="通常用来限制 path / limitSymbolsToIncludedHeaders">
            <TextArea rows={6} value={browseText} onChange={(e) => setBrowseText(e.target.value)} />
          </Field>
          <div className="flex mb-12">
            <Button size="sm" variant="primary" onClick={applyBrowse}>
              应用 browse
            </Button>
            <Button size="sm" onClick={() => setBrowseText(browseJson)}>
              还原
            </Button>
          </div>
        </>
      )}
    </>
  ) : (
    <EmptyState title="没有选中任何配置">
      点左侧的「新增」，或者在「原始 JSON」里直接粘一份 c_cpp_properties.json 的 configurations。
    </EmptyState>
  )

  const jsonTab = config ? (
    <>
      {jsonError && <Alert kind="err">JSON 解析失败：{jsonError}（没有写回）</Alert>}
      <Field
        label={`「${config.name || '未命名'}」这一组配置`}
        hint="只包含当前这一组；确认时按 JSON.parse 解析，失败不会写回。切换配置会重置文本。"
      >
        <TextArea
          rows={20}
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          style={{ minHeight: 300 }}
        />
      </Field>
      <div className="flex">
        <Button variant="primary" onClick={applyJson}>
          应用
        </Button>
        <Button onClick={() => setJsonText(configJson)}>还原</Button>
        <div className="spacer" />
        <span className="faint small">共 {Object.keys(config).length} 个键</span>
      </div>
    </>
  ) : (
    <EmptyState title="没有选中任何配置">先新增或选中一组配置。</EmptyState>
  )

  return (
    <>
      <PageHeader
        title="IntelliSense c_cpp_properties.json"
        subtitle={`${configurations.length} 组配置`}
        actions={
          <>
            <Button size="sm" onClick={refillFromProject}>
              <Icons.cpp />
              用工程检测结果重新填充
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void useStudio.getState().regenerate(true)}
            >
              <Icons.refresh />
              按当前参数重新生成全部配置
            </Button>
          </>
        }
      />

      <PageBody>
        {project && !project.hasCompileCommands && (
          <Alert kind="warn">
            工程还没有生成 compile_commands.json，IntelliSense
            的精确跳转要等构建一次之后才生效。可以在「构建与烧录」页点一次配置+构建。
          </Alert>
        )}

        <SplitPane storageKey="cpp-list" defaultWidth={300}>
          {/* ---- 左：配置列表 ---- */}
          <Card title="配置列表" hint={`${configurations.length} 组`}>
            {configurations.length ? (
              <div className="list list__scroll">{listItems}</div>
            ) : (
              <div className="faint small mb-12">还没有任何配置，点下面的「新增」建一组。</div>
            )}

            <div className="flex flex-wrap mt-12">
              <Button size="sm" onClick={addConfig}>
                新增
              </Button>
              <Button size="sm" disabled={!config} onClick={duplicateConfig}>
                复制
              </Button>
              <Button size="sm" variant="danger" disabled={!config} onClick={deleteConfig}>
                删除
              </Button>
              <Button size="sm" disabled={!config || selected <= 0} onClick={() => moveConfig(-1)}>
                上移
              </Button>
              <Button
                size="sm"
                disabled={!config || selected >= configurations.length - 1}
                onClick={() => moveConfig(1)}
              >
                下移
              </Button>
            </div>
          </Card>

          {/* ---- 右：编辑区 ---- */}
          <Card
            flush
            title={config ? `编辑「${config.name || '未命名'}」` : '编辑配置'}
            hint="改动即时写回 bundle，写入前可在预览里核对"
          >
            <div className="card__body">
              <Tabs
                value={tab}
                onChange={(v) => setTab(v)}
                tabs={[
                  { key: 'form', label: '表单' },
                  { key: 'json', label: '原始 JSON' }
                ]}
              />
              {tab === 'form' ? formTab : jsonTab}
            </div>
          </Card>
        </SplitPane>
      </PageBody>
    </>
  )
}
