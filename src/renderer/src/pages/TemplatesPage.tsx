/**
 * 模板与配置页。
 *
 * 三块内容：
 *   1. 模板列表 —— 套用 / 编辑 / 复制 / 看 JSON / 删除
 *   2. 从当前工程存一份（需要工程）
 *   3. 多工程批量应用
 *
 * 点「编辑」或「新建模板」时，整页交给 TemplateEditor —— 那是一个三层结构的编辑器
 * （面向什么 / 生成参数 / 四份文件内容），不依赖任何工程。
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
  Modal,
  PageBody,
  PageHeader,
  PathText,
  Select,
  Spinner,
  TextArea,
  TextInput
} from '../components/ui'
import { Icons } from '../components/icons'
import { buildTemplateSkeleton, describeTarget } from '@shared/templateSkeleton'
import type { BatchResult, ConfigTemplate } from '@shared/types'
import { TemplateEditor, emptyTemplate } from './TemplateEditor'

export default function TemplatesPage(): React.JSX.Element {
  const templates = useStudio((s) => s.templates)
  const project = useStudio((s) => s.project)
  const settings = useStudio((s) => s.settings)
  const candidates = useStudio((s) => s.candidates)
  const refreshTemplates = useStudio((s) => s.refreshTemplates)
  const refreshCandidates = useStudio((s) => s.refreshCandidates)
  const saveCurrentAsTemplate = useStudio((s) => s.saveCurrentAsTemplate)
  const saveTemplate = useStudio((s) => s.saveTemplate)
  const deleteTemplate = useStudio((s) => s.deleteTemplate)
  const duplicateTemplate = useStudio((s) => s.duplicateTemplate)
  const applyTemplateToCurrent = useStudio((s) => s.applyTemplateToCurrent)
  const notify = useStudio((s) => s.notify)
  const pendingTemplateId = useStudio((s) => s.pendingTemplateId)
  const consumePendingTemplate = useStudio((s) => s.consumePendingTemplate)

  /** 正在编辑的模板；非 null 时整页切成编辑器 */
  const [editing, setEditing] = React.useState<{ template: ConfigTemplate; isNew: boolean } | null>(
    null
  )

  // ---- 从当前工程存一份 ----
  const [name, setName] = React.useState('')
  const [note, setNote] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  // ---- 列表 ----
  const [refreshing, setRefreshing] = React.useState(false)
  const [viewing, setViewing] = React.useState<ConfigTemplate | null>(null)
  const [confirmId, setConfirmId] = React.useState<string | null>(null)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const [applyingId, setApplyingId] = React.useState<string | null>(null)

  // ---- 批量 ----
  const [rootDraft, setRootDraft] = React.useState('')
  const [rootList, setRootList] = React.useState<string[]>([])
  const [templateId, setTemplateId] = React.useState('')
  const [backup, setBackup] = React.useState(settings.backupBeforeWrite)
  const [backupTouched, setBackupTouched] = React.useState(false)
  const [scanning, setScanning] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState<BatchResult | null>(null)

  // 进页面时拉一次模板与工程候选（这两个都不依赖当前工程）
  React.useEffect(() => {
    void refreshTemplates()
    void refreshCandidates()
  }, [refreshTemplates, refreshCandidates])

  // 工程名变了就重置建议的模板名（用户手动输入的名字不会被覆盖）
  React.useEffect(() => {
    setName(project ? `${project.name} 模板` : '')
  }, [project])

  // 设置里的默认值晚于首次渲染时才到位，所以在这里补一次
  React.useEffect(() => {
    if (!backupTouched) setBackup(settings.backupBeforeWrite)
  }, [settings.backupBeforeWrite, backupTouched])

  // 模板列表变化后，保证批量用的那个选择仍然有效
  React.useEffect(() => {
    setTemplateId((cur) =>
      cur && templates.some((t) => t.id === cur) ? cur : (templates[0]?.id ?? '')
    )
  }, [templates])

  /**
   * 历史记录页点「打开这个模板」会先设好 pendingTemplateId 再切页过来，
   * 这里把它消费掉、直接进编辑器。
   */
  React.useEffect(() => {
    if (!pendingTemplateId) return
    const target = templates.find((t) => t.id === pendingTemplateId)
    if (target) {
      setEditing({
        template: target.builtin
          ? { ...target, id: '', name: `${target.name} 副本`, builtin: false }
          : target,
        isNew: Boolean(target.builtin)
      })
    }
    consumePendingTemplate()
  }, [pendingTemplateId, templates, consumePendingTemplate])

  // ------------------------------------------------------------------------
  // 动作
  // ------------------------------------------------------------------------

  const onRefresh = (): void => {
    setRefreshing(true)
    void refreshTemplates().finally(() => setRefreshing(false))
  }

  const onCreate = async (): Promise<void> => {
    const tplName = name.trim()
    if (!tplName) {
      notify('warn', '请先填模板名称')
      return
    }
    setSaving(true)
    try {
      await saveCurrentAsTemplate(tplName, note.trim())
    } finally {
      setSaving(false)
    }
  }

  const onApply = async (t: ConfigTemplate): Promise<void> => {
    setApplyingId(t.id)
    try {
      await applyTemplateToCurrent(t)
    } finally {
      setApplyingId(null)
    }
  }

  const onDelete = async (t: ConfigTemplate): Promise<void> => {
    // 第一次点击只是进入「确认」状态，再点一次才真删
    if (confirmId !== t.id) {
      setConfirmId(t.id)
      return
    }
    setDeletingId(t.id)
    try {
      await deleteTemplate(t.id)
      notify('ok', `已删除模板「${t.name}」`)
    } catch (err) {
      notify('err', `删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeletingId(null)
      setConfirmId(null)
    }
  }

  const copyJson = async (): Promise<void> => {
    if (!viewing) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(viewing, null, 4))
      notify('ok', '模板 JSON 已复制到剪贴板')
    } catch {
      notify('err', '复制失败，请手动选中文本复制')
    }
  }

  /** 加入待处理列表：去空格、去掉结尾斜杠、忽略大小写去重 */
  const addRoot = (value: string): void => {
    const v = value.trim().replace(/[\\/]+$/, '')
    if (!v) return
    setRootList((list) => (list.some((x) => x.toLowerCase() === v.toLowerCase()) ? list : [...list, v]))
    setRootDraft('')
  }

  const addFromCandidates = (): void => {
    setScanning(true)
    void refreshCandidates().finally(() => setScanning(false))
    const roots = candidates.map((c) => c.root ?? c.folder).filter(Boolean)
    setRootList((list) => {
      const next = [...list]
      for (const r of roots) {
        if (!next.some((x) => x.toLowerCase() === r.toLowerCase())) next.push(r)
      }
      return next
    })
  }

  const runBatch = async (): Promise<void> => {
    if (!templateId || !rootList.length) return
    setRunning(true)
    setResult(null)
    try {
      const res = await window.api.applyTemplateToProjects({
        projectRoots: rootList,
        templateId,
        backup
      })
      setResult(res)
      const okCount = res.items.filter((i) => i.ok).length
      notify(
        okCount === res.items.length ? 'ok' : 'warn',
        `批量完成：成功 ${okCount} / ${res.items.length}`
      )
    } catch (err) {
      notify('err', `批量应用失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const openNew = (): void => {
    const base = emptyTemplate()
    setEditing({
      template: {
        ...base,
        files: buildTemplateSkeleton({ target: base.target, options: base.options })
      },
      isNew: true
    })
  }

  // ------------------------------------------------------------------------
  // 编辑器整页接管
  // ------------------------------------------------------------------------

  if (editing) {
    return (
      <TemplateEditor
        initial={editing.template}
        isNew={editing.isNew}
        onClose={() => setEditing(null)}
        onSave={async (template) => {
          await saveTemplate(template)
          setEditing(null)
          notify('ok', `模板「${template.name}」已保存`)
        }}
      />
    )
  }

  return (
    <>
      <PageHeader
        title="模板与配置"
        subtitle={`${templates.length} 个模板 · 不需要先选工程也能新建和编辑`}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={refreshing}
              onClick={onRefresh}
              title="重新读一遍模板列表"
            >
              {refreshing ? <Spinner /> : <Icons.refresh />}
              刷新
            </Button>
            <Button size="sm" variant="primary" onClick={openNew}>
              <Icons.write />
              新建模板
            </Button>
          </>
        }
      />

      <PageBody>
        {/* ---- 从当前工程存一份（需要工程） ---- */}
        <Card
          title="从当前工程存一份"
          hint={project ? `来源工程：${project.name}` : '可以跳过这一块，直接「新建模板」'}
        >
          {!project && (
            <Alert kind="info">
              这里是把<b>正在配置的工程</b>整套存下来。想不依赖工程直接攒一套配置，就点右上角
              「新建模板」—— 那里可以图形化选编辑器 / 构建系统 / 调试探针，并逐份编辑文件内容。
            </Alert>
          )}
          <div className="row mb-12">
            <div className="grow">
              <Field label="模板名称">
                <TextInput
                  value={name}
                  placeholder="例如 STM32F103 标准模板"
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </div>
            <div className="grow">
              <Field label="备注（可选）">
                <TextInput
                  value={note}
                  placeholder="例如 用于所有 F1 系列的板子"
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            </div>
            <Button
              variant="primary"
              disabled={!project || !name.trim() || saving}
              onClick={() => void onCreate()}
            >
              {saving ? <Spinner /> : null}
              保存为模板
            </Button>
          </div>

          <Alert kind="info">
            模板会连同〔生成参数 + launch / tasks / settings / c_cpp_properties 的内容〕一起保存；
            套用到别的工程时，与具体工程绑定的字段（固件名、芯片、构建目录、工具路径）会按目标工程重新推导。
          </Alert>
        </Card>

        {/* ---- 模板列表 ---- */}
        <Card title="模板列表" hint={`共 ${templates.length} 个`} flush>
          <DataTable
            columns={[
              { key: 'name', title: '名称', width: 240 },
              { key: 'target', title: '面向', width: 250 },
              { key: 'files', title: '文件内容', width: 100 },
              { key: 'time', title: '更新时间', width: 150 },
              { key: 'ops', title: '操作', width: 430 }
            ]}
            rows={templates.map((t) => ({
              key: t.id,
              cells: [
                <span key="n" className="bold">
                  {t.name}
                  {t.builtin && (
                    <>
                      {' '}
                      <Badge kind="accent">内置</Badge>
                    </>
                  )}
                </span>,
                <span key="tg" className="small">
                  {describeTarget(t.target)}
                </span>,
                t.files && Object.values(t.files).some((x) => x && x.trim()) ? (
                  <Badge key="f" kind="ok">
                    自定义
                  </Badge>
                ) : (
                  <span key="f" className="faint small">
                    按参数生成
                  </span>
                ),
                <span key="t" className="small muted">
                  {t.builtin ? '随应用提供' : new Date(t.updatedAt).toLocaleString()}
                </span>,
                <div key="ops" className="flex">
                  <Button
                    size="sm"
                    disabled={!project || applyingId === t.id}
                    onClick={() => void onApply(t)}
                    title={project ? '用这个模板的参数重新检测当前工程' : '请先载入工程'}
                  >
                    {applyingId === t.id ? <Spinner /> : null}
                    套用
                  </Button>
                  <Button
                    size="sm"
                    title={t.builtin ? '内置模板不可改，会以副本形式打开' : '编辑这个模板'}
                    onClick={() =>
                      setEditing({
                        template: t.builtin
                          ? { ...t, id: '', name: `${t.name} 副本`, builtin: false }
                          : t,
                        isNew: Boolean(t.builtin)
                      })
                    }
                  >
                    {t.builtin ? '复制并编辑' : '编辑'}
                  </Button>
                  <Button size="sm" onClick={() => void duplicateTemplate(t)} title="复制一份">
                    复制
                  </Button>
                  <Button size="sm" onClick={() => setViewing(t)}>
                    <Icons.eye />
                    JSON
                  </Button>
                  {t.builtin ? (
                    <Button size="sm" variant="ghost" disabled title="内置模板不能删除">
                      不可删除
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={confirmId === t.id ? 'danger' : 'ghost'}
                      disabled={deletingId === t.id}
                      onClick={() => void onDelete(t)}
                    >
                      {deletingId === t.id ? <Spinner /> : null}
                      {confirmId === t.id ? '确认删除？' : '删除'}
                    </Button>
                  )}
                </div>
              ]
            }))}
            empty={
              <EmptyState title="还没有模板">
                点右上角「新建模板」—— 不需要选工程，选好编辑器 / 构建系统 / 调试探针就能生成一套。
              </EmptyState>
            }
          />
        </Card>

        {/* ---- 批量 ---- */}
        <Card title="多工程批量应用" hint={`待处理 ${rootList.length} 个工程`}>
          <Alert kind="warn">
            批量应用会直接覆盖目标工程 <span className="mono">.vscode</span> 下的同名文件 （launch.json
            / tasks.json / settings.json / c_cpp_properties.json / openocd-*.cfg），
            不会弹预览、也不会跳过你手改过的文件。建议勾选下面的「写入前备份」。
          </Alert>

          <Field label="工程路径">
            <div className="row">
              <div className="grow">
                <TextInput
                  mono
                  value={rootDraft}
                  placeholder="例如 D:\\work\\my-firmware"
                  onChange={(e) => setRootDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addRoot(rootDraft)
                  }}
                />
              </div>
              <Button onClick={() => addRoot(rootDraft)}>添加</Button>
              <Button onClick={() => addRoot(project?.root ?? '')} disabled={!project}>
                用当前工程
              </Button>
              <Button onClick={() => setRootList([])} disabled={!rootList.length}>
                清空
              </Button>
            </div>
          </Field>

          <div className="flex mb-8">
            <span className="faint small">从检测到的工程添加（VSCode 正在打开 / 最近打开的）</span>
            <div className="spacer" />
            <Button size="sm" variant="ghost" onClick={addFromCandidates} disabled={scanning}>
              {scanning ? <Spinner /> : <Icons.refresh />}
              全部加入
            </Button>
          </div>

          {rootList.length > 0 && (
            <div className="list mb-12">
              {rootList.map((r) => (
                <div key={r} className="list__item">
                  <PathText value={r} />
                  <div className="spacer" />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRootList((l) => l.filter((x) => x !== r))}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="row mb-12">
            <div className="grow">
              <Field label="用哪个模板">
                <Select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  options={templates.map((t) => ({
                    value: t.id,
                    label: t.builtin ? `${t.name}（内置）` : t.name
                  }))}
                />
              </Field>
            </div>
            <Button
              variant="primary"
              disabled={running || !templateId || !rootList.length}
              onClick={() => void runBatch()}
            >
              {running ? <Spinner /> : null}
              批量套用
            </Button>
          </div>

          <Checkbox
            checked={backup}
            onChange={(v) => {
              setBackupTouched(true)
              setBackup(v)
            }}
            label="写入前备份（会存快照，之后可以还原）"
          />

          {result && (
            <div className="mt-12">
              <DataTable
                columns={[
                  { key: 'p', title: '工程' },
                  { key: 'ok', title: '结果', width: 90 },
                  { key: 'msg', title: '说明' }
                ]}
                rows={result.items.map((it) => ({
                  key: it.projectRoot,
                  cells: [
                    <PathText key="p" value={it.projectRoot} />,
                    it.ok ? (
                      <Badge key="ok" kind="ok">
                        成功
                      </Badge>
                    ) : (
                      <Badge key="ok" kind="err">
                        失败
                      </Badge>
                    ),
                    <span key="m" className="small">
                      {it.message}
                    </span>
                  ]
                }))}
              />
            </div>
          )}
        </Card>
      </PageBody>

      {/* ---- 看 JSON ---- */}
      {viewing && (
        <Modal
          title={`模板 JSON：${viewing.name}`}
          width={900}
          onClose={() => setViewing(null)}
          footer={
            <>
              <Button onClick={() => setViewing(null)}>关闭</Button>
              <Button variant="primary" onClick={() => void copyJson()}>
                复制 JSON
              </Button>
            </>
          }
        >
          <TextArea
            className="input--mono"
            rows={22}
            readOnly
            value={JSON.stringify(viewing, null, 4)}
          />
        </Modal>
      )}
    </>
  )
}
