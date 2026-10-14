/**
 * 模板编辑器。
 *
 * 按模板的三层结构来排：
 *   ① 面向什么 —— 编辑器 / 构建系统 / 调试探针（图形化选，不用写 JSON）
 *   ② 生成参数 —— 适配器速度、target 配置、C/C++ 标准
 *   ③ 四份文件 —— launch / tasks / settings / c_cpp_properties，逐份直接编辑
 *
 * 第三层的每一份都可以「重新生成骨架」，骨架里的工程相关值全是 `${elfName}`
 * 这类占位符，所以模板套到别的工程时会被自动填成那边的值。
 */

import React from 'react'
import {
  TEMPLATE_FILE_KEYS,
  type ConfigTemplate,
  type GenOptions,
  type ProbeKey,
  type TemplateFileKey
} from '@shared/types'
import { PROBE_OPTIONS, probeByKey } from '@shared/probes'
import { targetCfgOptions } from '@shared/chipTargets'
import { TEMPLATE_VARIABLES } from '@shared/templateRender'
import { buildTemplateSkeleton } from '@shared/templateSkeleton'
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  PageBody,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  TextArea,
  TextInput
} from '../components/ui'
import { Icons } from '../components/icons'

/** 这些空模板交给调用方（新建时用骨架填） */
export function emptyTemplate(): ConfigTemplate {
  const now = Date.now()
  return {
    id: '',
    name: '',
    note: '',
    createdAt: now,
    updatedAt: now,
    target: { editor: 'vscode', buildSystem: 'preset', probe: 'cmsis-dap' },
    options: { probeKey: 'cmsis-dap', adapterSpeed: 1000, targetCfg: '' },
    files: {}
  }
}

/** 宽松的 JSON 校验：允许注释和尾逗号（VSCode 的配置文件本来就允许） */
function checkJson(text: string): string | null {
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
  if (!cleaned.trim()) return null
  try {
    JSON.parse(cleaned)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function TemplateEditor(props: {
  initial: ConfigTemplate
  isNew: boolean
  onClose: () => void
  onSave: (template: ConfigTemplate) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<ConfigTemplate>(props.initial)
  const [fileTab, setFileTab] = React.useState<TemplateFileKey>('launch.json')
  const [saving, setSaving] = React.useState(false)

  const patch = (next: Partial<ConfigTemplate>): void => setDraft((d) => ({ ...d, ...next }))
  const patchTarget = (next: Partial<ConfigTemplate['target']>): void =>
    setDraft((d) => ({
      ...d,
      target: { ...d.target, ...next },
      options: { ...d.options, probeKey: next.probe ?? d.options.probeKey }
    }))
  const patchOptions = (next: Partial<GenOptions>): void =>
    setDraft((d) => ({ ...d, options: { ...d.options, ...next } }))

  const currentText = draft.files?.[fileTab] ?? ''
  const jsonError = currentText.trim() ? checkJson(currentText) : null
  const anyError = TEMPLATE_FILE_KEYS.some((k) => {
    const text = draft.files?.[k]
    return Boolean(text && text.trim() && checkJson(text))
  })

  const regenerateSkeleton = (): void => {
    const skeleton = buildTemplateSkeleton({ target: draft.target, options: draft.options })
    patch({ files: { ...draft.files, [fileTab]: skeleton[fileTab] } })
  }

  const regenerateAll = (): void => {
    patch({ files: buildTemplateSkeleton({ target: draft.target, options: draft.options }) })
  }

  const save = async (): Promise<void> => {
    if (!draft.name.trim()) return
    setSaving(true)
    try {
      await props.onSave({ ...draft, name: draft.name.trim() })
    } finally {
      setSaving(false)
    }
  }

  const probe = probeByKey(draft.target.probe)

  return (
    <>
      <PageHeader
        title={props.isNew ? '新建模板' : `编辑模板：${draft.name || '未命名'}`}
        subtitle="不依赖任何工程 —— 内容里的工程相关值用 ${占位符} 表示，套用时自动填"
        actions={
          <>
            <Button size="sm" onClick={props.onClose}>
              返回列表
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={saving || !draft.name.trim() || anyError}
              title={anyError ? '有 JSON 语法错误，先修好' : '保存模板'}
              onClick={() => void save()}
            >
              {saving ? <Spinner /> : <Icons.write />}
              保存模板
            </Button>
          </>
        }
      />

      <PageBody>
        {/* ---- ① 面向什么 ---- */}
        <Card title="① 这套配置面向什么" hint="图形化选择，不用手写">
          <div className="grid grid--3">
            <Field label="目标编辑器" hint="目前只支持 VSCode">
              <Select
                value={draft.target.editor}
                onChange={(e) => patchTarget({ editor: e.target.value as 'vscode' })}
                options={[{ value: 'vscode', label: 'Visual Studio Code' }]}
              />
            </Field>

            <Field label="构建系统怎么接" hint="决定任务里用 preset 还是构建目录">
              <Select
                value={draft.target.buildSystem}
                onChange={(e) => patchTarget({ buildSystem: e.target.value as 'preset' | 'dir' })}
                options={[
                  { value: 'preset', label: 'CMakePresets.json（--preset Debug）' },
                  { value: 'dir', label: '直接指定构建目录（build/Debug）' }
                ]}
              />
            </Field>

            <Field label="调试探针" hint="决定 interface/target 配置与烧录命令">
              <Select
                value={draft.target.probe}
                onChange={(e) => patchTarget({ probe: e.target.value as ProbeKey })}
                options={PROBE_OPTIONS.map((p) => ({ value: p.key, label: p.label }))}
              />
            </Field>
          </div>

          <Alert kind="info">
            当前组合：<b>{probe.label}</b> ，接线配置走{' '}
            <span className="mono">{probe.interfaceCfg || '（由目标工程推导）'}</span>。
            {draft.target.buildSystem === 'preset'
              ? ' 任务会用 cmake --build --preset。'
              : ' 任务会用 cmake --build <构建目录>。'}
          </Alert>
        </Card>

        {/* ---- 基本信息 ---- */}
        <Card title="基本信息">
          <div className="row mb-12">
            <div className="grow">
              <Field label="模板名称">
                <TextInput
                  value={draft.name}
                  placeholder="例如 STM32F407 + DAP-Link 标准模板"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
            </div>
            <div className="grow">
              <Field label="备注（可选）">
                <TextInput
                  value={draft.note}
                  placeholder="给未来的自己留句话"
                  onChange={(e) => patch({ note: e.target.value })}
                />
              </Field>
            </div>
          </div>
        </Card>

        {/* ---- ② 生成参数 ---- */}
        <Card title="② 生成参数" hint="只填「你的选择」；固件名、芯片、目录按目标工程推导">
          <div className="grid grid--3">
            <Field label="适配器速度（kHz）">
              <TextInput
                value={String(draft.options.adapterSpeed ?? '')}
                placeholder="1000"
                onChange={(e) => patchOptions({ adapterSpeed: Number(e.target.value) || 0 })}
              />
            </Field>

            <Field label="OpenOCD target 配置" hint="留空 = 按芯片自动选">
              <Select
                value={draft.options.targetCfg ?? ''}
                onChange={(e) => patchOptions({ targetCfg: e.target.value })}
                options={[{ value: '', label: '（按芯片自动选择）' }, ...targetCfgOptions()]}
              />
            </Field>

            <Field label="C 标准">
              <Select
                value={draft.options.cStandard ?? ''}
                onChange={(e) => patchOptions({ cStandard: e.target.value })}
                options={[
                  { value: '', label: '（按目标工程）' },
                  { value: 'c99', label: 'c99' },
                  { value: 'c11', label: 'c11' },
                  { value: 'c17', label: 'c17' }
                ]}
              />
            </Field>

            <Field label="C++ 标准">
              <Select
                value={draft.options.cppStandard ?? ''}
                onChange={(e) => patchOptions({ cppStandard: e.target.value })}
                options={[
                  { value: '', label: '（按目标工程）' },
                  { value: 'c++14', label: 'c++14' },
                  { value: 'c++17', label: 'c++17' },
                  { value: 'c++20', label: 'c++20' }
                ]}
              />
            </Field>

            <Field label="调试构建目录" hint="留空 = 按目标工程">
              <TextInput
                mono
                value={draft.options.debugDir ?? ''}
                placeholder="build/Debug"
                onChange={(e) => patchOptions({ debugDir: e.target.value })}
              />
            </Field>

            <Field label="发布构建目录" hint="留空 = 按目标工程">
              <TextInput
                mono
                value={draft.options.releaseDir ?? ''}
                placeholder="build/Release"
                onChange={(e) => patchOptions({ releaseDir: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        {/* ---- ③ 四份文件 ---- */}
        <Card
          title="③ 四份文件的内容"
          hint="直接编辑；工程相关的值用 ${占位符}，套用时按目标工程替换"
          actions={
            <Button size="sm" onClick={regenerateAll} title="四份全部按上面的选择重新生成">
              <Icons.refresh />
              全部重新生成
            </Button>
          }
          flush
        >
          <div style={{ padding: '10px 14px 0' }}>
            <Tabs
              value={fileTab}
              onChange={(key) => setFileTab(key as TemplateFileKey)}
              tabs={TEMPLATE_FILE_KEYS.map((k) => {
                const text = draft.files?.[k]
                const bad = Boolean(text && text.trim() && checkJson(text))
                return { key: k, label: bad ? `${k} ⚠` : k }
              })}
            />

            <div className="flex mb-8">
              <span className="faint small">
                正在编辑 <span className="mono">.vscode/{fileTab}</span>
              </span>
              <div className="spacer" />
              <Button size="sm" variant="ghost" onClick={regenerateSkeleton}>
                只重新生成这一份
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => patch({ files: { ...draft.files, [fileTab]: '' } })}
                title="清空这份，表示「按参数自动生成」"
              >
                清空（改用自动生成）
              </Button>
            </div>

            {jsonError && (
              <Alert kind="err">
                JSON 语法有问题，保存被挡住了：
                <div className="mono small mt-8">{jsonError}</div>
              </Alert>
            )}

            <TextArea
              className="input--mono"
              rows={20}
              value={currentText}
              placeholder="留空 = 这一份按生成参数自动生成"
              onChange={(e) => patch({ files: { ...draft.files, [fileTab]: e.target.value } })}
            />
          </div>
        </Card>

        {/* ---- 占位符速查 ---- */}
        <Card title="可用的占位符" hint="点一下复制">
          <div className="flex flex-wrap">
            {TEMPLATE_VARIABLES.map((v) => (
              <button
                key={v.token}
                type="button"
                className="btn btn--sm"
                title={v.desc}
                onClick={() => void navigator.clipboard.writeText(v.token)}
              >
                <span className="mono">{v.token}</span>
              </button>
            ))}
          </div>
          <div className="faint small mt-8">
            <Badge kind="accent">提示</Badge> 其它 <span className="mono">{'${...}'}</span> 会原样保留
            —— 例如 VSCode 自己的 <span className="mono">{'${workspaceFolder}'}</span> 和 CMake Tools 的{' '}
            <span className="mono">{'${buildType}'}</span>，不会被误替换。
          </div>
        </Card>
      </PageBody>
    </>
  )
}
