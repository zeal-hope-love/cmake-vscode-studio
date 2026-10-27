/**
 * 工具与路径页。
 *
 * 三块内容：
 *   1. 工具探测结果 —— 不依赖具体工程，随时可以重新探测；
 *   2. 调试探针与目标 —— 探针/target/device/adapterSpeed，直接决定 launch.json
 *      与 openocd-*.cfg 的内容；
 *   3. 生成参数（路径与命名）—— elfName / 构建目录 / preset / 各种可执行文件。
 *
 * 2、3 是「针对某个工程的生成参数」，所以只有载入工程后才显示；1 没有这个限制。
 */

import React from 'react'
import { useStudio } from '../state/store'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Kv,
  Modal,
  PageBody,
  PageHeader,
  PathText,
  Select,
  Spinner,
  TextInput
} from '../components/ui'
import { NoProject } from '../components/NoProject'
import { Icons } from '../components/icons'
import { PROBE_OPTIONS, probeByKey } from '@shared/probes'
import {
  guessChipFamily,
  mapOpenocdTarget,
  openocdCfgFileName,
  targetCfgOptions
} from '@shared/chipTargets'
import type { GenOptions } from '@shared/types'

/**
 * 工具 key → 中文名。
 *
 * 主进程的 services/toolDetector.ts 里有一份同样的 TOOL_LABELS，但它 import 了
 * node:fs，渲染进程不能直接引用，所以这里自己维护一份（改 key 时两边要同步）。
 */
const TOOL_LABELS: Record<string, string> = {
  openocd: 'OpenOCD',
  arm_gcc: 'arm-none-eabi-gcc',
  arm_gdb: 'arm-none-eabi-gdb',
  cmake: 'CMake',
  ninja: 'Ninja',
  make: 'Make',
  gdb: 'gdb（本机）',
  clangd: 'clangd',
  jlink: 'J-Link 命令行',
  stlink: 'ST-Link 工具'
}

/** 表格里的展示顺序：越靠前越常用 */
const TOOL_ORDER = [
  'openocd',
  'arm_gcc',
  'arm_gdb',
  'cmake',
  'ninja',
  'make',
  'gdb',
  'clangd',
  'jlink',
  'stlink'
]

/** 生成参数里所有「字符串型」字段的 key，用来循环渲染输入框 */
type StringOptionKey =
  | 'elfName'
  | 'debugDir'
  | 'releaseDir'
  | 'debugPreset'
  | 'releasePreset'
  | 'compileCommands'
  | 'generator'
  | 'svdFile'
  | 'cStandard'
  | 'cppStandard'
  | 'cmakeExe'
  | 'openocdExe'
  | 'toolchainDir'

interface TextOptionField {
  key: StringOptionKey
  label: string
  hint: string
}

/** 字段说明里写清「它影响哪个文件」 */
const TEXT_FIELDS: TextOptionField[] = [
  {
    key: 'elfName',
    label: '固件（ELF）名',
    hint: 'launch.json 的 executable、烧录任务的目标文件名'
  },
  {
    key: 'debugDir',
    label: 'Debug 构建目录',
    hint: '调试配置的 executable 路径（相对工程根）'
  },
  {
    key: 'releaseDir',
    label: 'Release 构建目录',
    hint: 'Release 构建/烧录任务读写的目录'
  },
  {
    key: 'debugPreset',
    label: 'Debug preset 名',
    hint: 'tasks.json 里配置与构建 Debug 用的 CMake preset'
  },
  {
    key: 'releasePreset',
    label: 'Release preset 名',
    hint: 'tasks.json 里构建 Release 用的 CMake preset'
  },
  {
    key: 'compileCommands',
    label: 'compile_commands 路径',
    hint: 'c_cpp_properties.json 与 clangd 的编译数据库位置'
  },
  {
    key: 'generator',
    label: 'CMake 生成器',
    hint: '没有 presets 时 cmake -G 的取值，例如 Ninja'
  },
  {
    key: 'svdFile',
    label: 'SVD 文件',
    hint: 'cortex-debug 的外设寄存器视图，留空则不写该字段'
  },
  {
    key: 'cStandard',
    label: 'C 标准',
    hint: 'c_cpp_properties.json 的 cStandard'
  },
  {
    key: 'cppStandard',
    label: 'C++ 标准',
    hint: 'c_cpp_properties.json 的 cppStandard'
  },
  {
    key: 'cmakeExe',
    label: 'cmake 可执行文件',
    hint: 'tasks.json 里各构建任务执行的 cmake'
  },
  {
    key: 'openocdExe',
    label: 'openocd 可执行文件',
    hint: 'settings.json 的 cortex-debug.openocdPath 与烧录任务命令'
  },
  {
    key: 'toolchainDir',
    label: '工具链目录',
    hint: 'cortex-debug 的 armToolchainPath（找 arm-none-eabi-gdb）'
  }
]

export default function ToolsPage(): React.JSX.Element {
  const tools = useStudio((s) => s.tools)
  const options = useStudio((s) => s.options)
  const bundle = useStudio((s) => s.bundle)
  const project = useStudio((s) => s.project)
  const settings = useStudio((s) => s.settings)
  const busy = useStudio((s) => s.busy)
  const refreshTools = useStudio((s) => s.refreshTools)
  const patchOptions = useStudio((s) => s.patchOptions)
  const loadProject = useStudio((s) => s.loadProject)
  const notify = useStudio((s) => s.notify)

  const [probingVersions, setProbingVersions] = React.useState(false)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  /** 打开编辑器时的预填值：保存时只处理被真正改过的条目 */
  const [baseline, setBaseline] = React.useState<Record<string, string>>({})
  const [savingPaths, setSavingPaths] = React.useState(false)
  /** 本次会话里刚保存过的手动路径；用于修正 store.settings 尚未刷新的问题 */
  const [manualTools, setManualTools] = React.useState<Record<string, string> | null>(null)

  const items = tools?.items ?? {}
  const toolKeys = React.useMemo(() => {
    const extra = Object.keys(items).filter((k) => !TOOL_ORDER.includes(k))
    return [...TOOL_ORDER, ...extra]
  }, [items])

  /**
   * 这一页不依赖工程 —— 没探测过就自动探一次，进来直接能看到本机装了什么。
   * 用 ref 兜底：万一探测失败（tools 仍是 null、busy 又变回 false），
   * 不加这个就会无限重试。
   */
  const autoProbed = React.useRef(false)
  React.useEffect(() => {
    if (tools || busy || autoProbed.current) return
    autoProbed.current = true
    void refreshTools(false)
  }, [tools, busy, refreshTools])

  const foundCount = toolKeys.filter((k) => items[k]?.found).length
  const knownManual = manualTools ?? settings.tools

  // ------------------------------------------------------------------------
  // 动作
  // ------------------------------------------------------------------------

  const probeAllVersions = (): void => {
    setProbingVersions(true)
    // 探测版本会为每个工具起一次子进程，比较慢，按钮上给 loading 态
    void refreshTools(true).finally(() => setProbingVersions(false))
  }

  const openEditor = (): void => {
    const next: Record<string, string> = {}
    for (const key of toolKeys) next[key] = knownManual[key] ?? items[key]?.path ?? ''
    setDrafts(next)
    setBaseline(next)
    setEditorOpen(true)
  }

  const browseTool = async (key: string): Promise<void> => {
    const picked = await window.api.pickFile()
    if (picked) setDrafts((d) => ({ ...d, [key]: picked }))
  }

  const saveManualPaths = async (): Promise<void> => {
    setSavingPaths(true)
    try {
      // 只写「被改过」的条目；留空 = 删掉这条手动指定，回到自动探测
      const next: Record<string, string> = { ...knownManual }
      for (const key of toolKeys) {
        const value = (drafts[key] ?? '').trim()
        if (value === (baseline[key] ?? '').trim()) continue
        if (value) next[key] = value
        else delete next[key]
      }
      await window.api.saveSettings({ tools: next })
      setManualTools(next)
      await refreshTools(false)
      setEditorOpen(false)
    } catch (err) {
      notify('err', `保存工具路径失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSavingPaths(false)
    }
  }

  /** 批量修改字符串型生成参数（union key 直接写索引签名，避免 as 断言） */
  const patchText = (key: StringOptionKey, value: string): void => {
    const patch: Partial<GenOptions> = {}
    patch[key] = value
    patchOptions(patch)
  }

  const onProbeChange = (key: string): void => {
    if (!options) return
    const probe = probeByKey(key)
    const prev = probeByKey(options.probeKey)
    const target = options.targetCfg

    // 接线配置文件名由「target + 探针」共同决定，探针一换文件名就会变
    const prevFile = prev.needsOpenocdCfg && target ? openocdCfgFileName(target, prev.key) : null
    const nextFile = probe.needsOpenocdCfg && target ? openocdCfgFileName(target, probe.key) : null

    patchOptions({
      probeKey: probe.key,
      interfaceCfg: probe.interfaceCfg,
      resetConfig: probe.resetConfig
    })
    void window.api.saveSettings({ probeKey: probe.key })

    let text = `已切换到 ${probe.label}，配置已按新探针重新生成`
    if (!probe.needsOpenocdCfg) {
      text = `已切换到 ${probe.label}：该探针由 cortex-debug 直接驱动，不再生成 ${
        prevFile ?? 'openocd-*.cfg'
      }，配置已重新生成`
    } else if (prevFile && nextFile && prevFile !== nextFile) {
      text = `已切换到 ${probe.label}：接线配置文件名从 ${prevFile} 变为 ${nextFile}，配置已重新生成`
    }
    notify('ok', text)
  }

  const resetToAuto = async (): Promise<void> => {
    if (!project) return
    // 不带 overrides 就是「按工程重新推断」的默认参数
    await loadProject(project.root)
  }

  // ------------------------------------------------------------------------
  // 派生数据
  // ------------------------------------------------------------------------

  const targetOptions = React.useMemo(() => {
    const list: Array<{ value: string; label: string }> = [
      { value: '', label: '（不设置 target 配置）' },
      ...targetCfgOptions()
    ]
    const current = options?.targetCfg ?? ''
    if (current && !list.some((o) => o.value === current)) {
      list.unshift({ value: current, label: `${current}（当前值）` })
    }
    return list
  }, [options?.targetCfg])

  const suggestedTarget = mapOpenocdTarget(project?.device)

  // ------------------------------------------------------------------------
  // 头部
  // ------------------------------------------------------------------------

  const header = (
    <PageHeader
      title="工具与路径"
      subtitle={
        tools ? `${foundCount} / ${toolKeys.length} 个工具已找到` : '还没有探测结果，点「重新探测」开始'
      }
      actions={
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void refreshTools(false)}>
          {busy ? <Spinner /> : <Icons.refresh />}
          重新探测
        </Button>
      }
    />
  )

  if (!tools) {
    return (
      <>
        {header}
        <PageBody>
          <Card>
            <EmptyState title={busy ? '正在探测本机工具…' : '还没有探测结果'}>
              这一页不需要选工程。点右上角「重新探测」再看看本机都装了什么。
            </EmptyState>
          </Card>
        </PageBody>
      </>
    )
  }

  // ------------------------------------------------------------------------
  // 卡片 1：工具探测结果
  // ------------------------------------------------------------------------

  const toolsCard = (
    <Card
      title="工具探测结果"
      hint="查找顺序：手动指定 → 环境变量 → 系统 PATH → 常见安装位置"
      actions={
        <>
          <Button size="sm" disabled={busy} onClick={() => void refreshTools(false)}>
            <Icons.refresh />
            重新探测
          </Button>
          <Button size="sm" disabled={busy || probingVersions} onClick={probeAllVersions}>
            {probingVersions ? <Spinner /> : null}
            探测版本
          </Button>
          <Button size="sm" onClick={openEditor}>
            手动指定路径…
          </Button>
        </>
      }
      flush
    >
      <DataTable
        columns={[
          { key: 'tool', title: '工具', width: 168 },
          { key: 'path', title: '路径' },
          { key: 'source', title: '来源', width: 108 },
          { key: 'version', title: '版本' },
          { key: 'state', title: '状态', width: 88 }
        ]}
        rows={toolKeys.map((key) => {
          const item = items[key]
          const found = Boolean(item?.found)
          return {
            key,
            cells: [
              <span key="t" className="mono bold">
                {TOOL_LABELS[key] ?? key}
              </span>,
              <PathText key="p" value={item?.path} max={78} />,
              <span key="s" className="faint small">
                {item?.source || '—'}
              </span>,
              item?.version ? (
                <span key="v" className="mono small">
                  {item.version}
                </span>
              ) : (
                <span key="v" className="faint">
                  —
                </span>
              ),
              found ? (
                <Badge key="st" kind="ok">
                  已找到
                </Badge>
              ) : (
                <Badge key="st" kind="warn">
                  未找到
                </Badge>
              )
            ]
          }
        })}
        empty={<EmptyState title="没有探测到任何工具条目" />}
      />

      <div style={{ padding: '12px 14px 0' }}>
        <div className="small muted mb-8">
          工具链环境变量
          <span className="faint">
            （优先级高于系统 PATH，STM32CubeCLT / CubeIDE / OpenOCD 装在哪就认哪）
          </span>
        </div>

        {tools.envRoots.length === 0 ? (
          <div className="faint small mb-12">
            没有检测到 STM32CLT_PATH / OPENOCD_HOME / SEGGER_PATH 之类的环境变量， 已回退到系统 PATH
            和常见安装位置查找。
          </div>
        ) : (
          <>
            <div className="flex flex-wrap mb-8">
              {tools.envRoots.map((root) => (
                <span
                  key={root.name}
                  className="flex"
                  style={{ gap: 6 }}
                  title={`${root.label}：${root.value}`}
                >
                  <Badge kind={root.exists ? 'ok' : 'warn'}>
                    {root.name}
                    {root.exists ? '' : '（路径不存在）'}
                  </Badge>
                  <PathText value={root.value} max={44} />
                </span>
              ))}
            </div>
            {tools.svdDir && (
              <div className="small mb-12">
                <span className="muted">SVD 外设寄存器描述目录：</span>
                <PathText value={tools.svdDir} max={60} />
                <span className="faint"> —— 能对上芯片型号时会自动填进调试配置的 svdFile</span>
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ padding: '12px 14px 14px' }}>
        <div className="small muted mb-8">OpenOCD scripts 目录</div>
        {tools.openocdScripts ? (
          <div className="flex flex-wrap">
            <Badge kind="ok">已定位</Badge>
            <PathText value={tools.openocdScripts} max={72} />
            <span className="faint small">{tools.openocdScriptsNote}</span>
          </div>
        ) : (
          <Alert kind="warn">
            <div className="bold mb-8">没有定位到 OpenOCD 的 scripts 目录</div>
            <div className="small">{tools.openocdScriptsNote}</div>
            <div className="faint small mt-8">
              没有它，生成的 openocd-*.cfg 里的
              <span className="mono"> source [find target/...]</span> 会找不到文件。可以在上面
              「手动指定路径…」里填上正确的 openocd.exe，再重新探测。
            </div>
          </Alert>
        )}
      </div>
    </Card>
  )

  // ------------------------------------------------------------------------
  // 卡片 2、3：探针 / 生成参数（需要先载入工程）
  // ------------------------------------------------------------------------

  const needProjectCard = (title: string, text: string): React.JSX.Element => (
    <Card title={title}>
      <NoProject reason={text} />
    </Card>
  )

  const probeCard = options ? (
    <Card title="调试探针与目标" hint="改这里会立刻重新生成 launch.json / tasks.json / openocd-*.cfg">
      <div className="grid grid--2">
        <div>
          <Field label="调试探针" hint="决定 launch.json 的 servertype，以及是否需要 OpenOCD 接线配置">
            <Select
              value={options.probeKey}
              options={PROBE_OPTIONS.map((p) => ({ value: p.key, label: p.label }))}
              onChange={(e) => onProbeChange(e.target.value)}
            />
          </Field>

          <Field label="OpenOCD target 配置" hint="接线配置里 source 的 target/*.cfg；选错会连不上芯片">
            <Select
              value={options.targetCfg}
              options={targetOptions}
              onChange={(e) => patchOptions({ targetCfg: e.target.value })}
            />
          </Field>

          {suggestedTarget && suggestedTarget !== options.targetCfg && (
            <div className="flex mb-12">
              <span className="small muted">
                芯片 <span className="mono accent">{project?.device}</span> 通常用{' '}
                <span className="mono accent">{suggestedTarget}</span>
              </span>
              <Button size="sm" onClick={() => patchOptions({ targetCfg: suggestedTarget })}>
                用建议值
              </Button>
            </div>
          )}

          <Field
            label="自定义 target 配置"
            hint="直接填文件名，例如 stm32f4x.cfg（可与上面的下拉互相对照）"
          >
            <TextInput
              mono
              value={options.targetCfg}
              placeholder="stm32f1x.cfg"
              onChange={(e) => patchOptions({ targetCfg: e.target.value })}
            />
          </Field>
        </div>

        <div>
          <Field
            label="cortex-debug device"
            hint="写进 launch.json 的 device 字段；留空则用工程里识别到的芯片型号"
          >
            <TextInput
              mono
              value={options.device}
              placeholder={project?.device ?? '例如 STM32F103C8'}
              onChange={(e) => patchOptions({ device: e.target.value })}
            />
          </Field>

          <Field
            label="适配器速度（kHz）"
            hint="写进 openocd-*.cfg 的 adapter speed；J-Link 原生探针用作 -speed"
          >
            <TextInput
              type="number"
              value={String(options.adapterSpeed)}
              onChange={(e) => patchOptions({ adapterSpeed: Number(e.target.value) || 0 })}
              onBlur={(e) =>
                void window.api.saveSettings({ adapterSpeed: Number(e.target.value) || 0 })
              }
            />
          </Field>

          {/*
            Live Watch —— 不停机看全局变量（类似 Keil 的 Live Watch）。
            cortex-debug 1.12 起提供，只对 openocd / stlink / jlink 生效，PyOCD 不支持；
            官方标注「实验性」，且只测过 SWD。
          */}
          <Field
            label="Live Watch（不停机看全局变量）"
            hint="写进 launch.json 的 liveWatch，以及 settings.json 的 cortex-debug.liveWatchRefreshRate"
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '8px 10px',
                border: '1px solid var(--border)',
                borderRadius: 6
              }}
            >
              <Checkbox
                checked={Boolean(options.liveWatch)}
                onChange={(on) => {
                  patchOptions({ liveWatch: on })
                  void window.api.saveSettings({ liveWatch: on })
                }}
                label={
                  options.liveWatch
                    ? '已启用 —— F5 起来后在 Live Watch 面板里「Add to Live Watch」加变量'
                    : '未启用'
                }
              />

              {options.liveWatch && (
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <div style={{ width: 150 }}>
                    <Field label="采样率（次/秒）" hint="0~20，默认 4">
                      <TextInput
                        type="number"
                        min={0}
                        max={20}
                        value={String(options.liveWatchSamplesPerSecond)}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(20, Number(e.target.value) || 0))
                          patchOptions({ liveWatchSamplesPerSecond: v })
                          void window.api.saveSettings({ liveWatchSamplesPerSecond: v })
                        }}
                      />
                    </Field>
                  </div>
                  <div style={{ width: 170 }}>
                    <Field label="面板刷新（毫秒）" hint="默认 300，别低于 250">
                      <TextInput
                        type="number"
                        min={100}
                        max={5000}
                        value={String(options.liveWatchRefreshRate)}
                        onChange={(e) => {
                          const v = Math.max(100, Math.min(5000, Number(e.target.value) || 300))
                          patchOptions({ liveWatchRefreshRate: v })
                          void window.api.saveSettings({ liveWatchRefreshRate: v })
                        }}
                      />
                    </Field>
                  </div>
                </div>
              )}

              <div className="faint small" style={{ lineHeight: 1.7 }}>
                {!['openocd', 'stlink', 'jlink'].includes(probeByKey(options.probeKey).servertype)
                  ? `当前探针（${probeByKey(options.probeKey).label}）用的是 ${probeByKey(options.probeKey).servertype}，cortex-debug 的 Live Watch 不支持它 —— 打开也不会生效。`
                  : '注意：只能看**全局变量和静态变量**（cortex-debug 靠 nm/objdump 读符号表，栈上的局部变量看不到，会显示 not available）。'}
                <br />
                采样率和面板刷新是两回事：采样快但刷新慢，看起来就是「值跳着变」，这是正常的。
              </div>
            </div>
          </Field>

          <Kv
            items={[
              [
                '接线配置文件名',
                bundle?.openocdCfg ? (
                  <span className="mono accent">{bundle.openocdCfg.fileName}</span>
                ) : (
                  <span className="faint">（该探针不需要 OpenOCD 接线配置）</span>
                )
              ],
              [
                'interface 配置',
                options.interfaceCfg ? (
                  <span className="mono">{options.interfaceCfg}</span>
                ) : (
                  <span className="faint">—</span>
                )
              ],
              [
                'reset_config',
                options.resetConfig ? (
                  <span className="mono">{options.resetConfig}</span>
                ) : (
                  <span className="faint">—</span>
                )
              ],
              null,
              ['识别到的芯片', project?.device ?? <span className="faint">未识别</span>],
              ['CubeMX .ioc', <PathText key="ioc" value={project?.ioc?.file} max={56} />],
              [
                '芯片系列',
                guessChipFamily(project?.device) ?? <span className="faint">未能从型号推断</span>
              ]
            ]}
          />
        </div>
      </div>
    </Card>
  ) : (
    needProjectCard(
      '调试探针与目标',
      '探针、target、device 都是针对具体工程的生成参数，载入工程后才能调整。'
    )
  )

  const genCard = options ? (
    <Card
      title="生成参数（路径与命名）"
      hint="改动会立即重新生成配置内容"
      actions={
        <Button size="sm" disabled={busy || !project} onClick={() => void resetToAuto()}>
          <Icons.refresh />
          恢复自动推断
        </Button>
      }
    >
      <div className="grid grid--2">
        {TEXT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <TextInput mono value={options[f.key]} onChange={(e) => patchText(f.key, e.target.value)} />
          </Field>
        ))}
      </div>

      <div className="divider" />

      <Checkbox
        checked={options.hasBuildPresets}
        onChange={(v) => patchOptions({ hasBuildPresets: v })}
        label="工程里有 build presets"
      />
      <div className="faint small mt-8">
        勾选时 tasks.json 的构建任务用
        <span className="mono"> cmake --build --preset 名字</span>；不勾选则退化成
        <span className="mono"> cmake --build 构建目录</span>。
      </div>
    </Card>
  ) : (
    needProjectCard(
      '生成参数（路径与命名）',
      '这些路径与命名都是从工程里推断出来的，载入工程后才会出现，可以在这里微调。'
    )
  )

  // ------------------------------------------------------------------------

  return (
    <>
      {header}

      <PageBody>
        {toolsCard}
        {probeCard}
        {genCard}
      </PageBody>

      {editorOpen && (
        <Modal
          title="手动指定工具路径"
          width={760}
          onClose={() => setEditorOpen(false)}
          footer={
            <>
              <span className="faint small">留空 = 取消该条手动指定；没改过的条目保持自动探测</span>
              <div className="spacer" />
              <Button onClick={() => setEditorOpen(false)}>取消</Button>
              <Button variant="primary" disabled={savingPaths} onClick={() => void saveManualPaths()}>
                {savingPaths ? <Spinner /> : null}
                保存并重新探测
              </Button>
            </>
          }
        >
          <div className="small muted mb-12">
            手动指定的路径优先级最高（探测来源会显示为「上次保存」）。这里已经预填了当前探测到的路径，
            只有被你改动过的条目才会写进设置，其余继续走自动探测。
          </div>

          {toolKeys.map((key) => (
            <Field key={key} label={TOOL_LABELS[key] ?? key}>
              <div className="row">
                <div className="grow">
                  <TextInput
                    mono
                    value={drafts[key] ?? ''}
                    placeholder={items[key]?.path ?? '留空则用自动探测'}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  />
                </div>
                <Button size="sm" onClick={() => void browseTool(key)}>
                  <Icons.folder />
                  浏览…
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDrafts((d) => ({ ...d, [key]: '' }))}
                >
                  清空
                </Button>
              </div>
            </Field>
          ))}
        </Modal>
      )}
    </>
  )
}
