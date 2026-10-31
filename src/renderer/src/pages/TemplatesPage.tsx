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
import type { PackPreset } from '@shared/templateFormat'
import type { BatchResult, ConfigTemplate } from '@shared/types'
import { TemplateEditor, emptyTemplate } from './TemplateEditor'

export default function TemplatesPage(): React.JSX.Element {
  const templates = useStudio((s) => s.templates)
  const project = useStudio((s) => s.project)
  const settings = useStudio((s) => s.settings)
  const candidates = useStudio((s) => s.candidates)
  const refreshTemplates = useStudio((s) => s.refreshTemplates)
  /** 已安装的模块包 —— 用来生成「每个包一个 tab」 */
  const packs = useStudio((s) => s.packs)
  const refreshPacks = useStudio((s) => s.refreshPacks)
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
  // 导入 / 导出：都是走系统文件对话框，可能停留几秒，所以要有个进行中状态
  const [importing, setImporting] = React.useState(false)
  const [exportingId, setExportingId] = React.useState<string | null>(null)

  /**
   * 当前在看哪个来源的模板。
   *
   * `'project'` = 工程配置（`.vscode` 那四份文件）；
   * 其它值是**模块包 id**（`remote-vt13` / `vofa`…），各自一个 tab。
   *
   * 为什么按包拆 tab 而不是「工程配置 / 模块包」两栏：后者的列表里
   * 遥控和 VOFA 的模板混在一起，还得看每行的小字才知道归属。装了几个包
   * 就有几个 tab，点哪个只看哪个，一眼就明白。
   */
  const [tab, setTab] = React.useState<string>('project')

  /** 模块包模板 */
  const [presets, setPresets] = React.useState<PackPreset[]>([])

  /** 当前 tab 对应的包（`'project'` 时为 null）；导出和标题都要用，所以提前算 */
  const activePack = React.useMemo(() => packs.find((p) => p.id === tab) ?? null, [packs, tab])

  /** 当前 tab 里的模板数量（工程配置 tab 时是模板数，否则是这个包的预设数） */
  const currentTabCount = React.useMemo(
    () => (tab === 'project' ? templates.length : presets.filter((p) => p.packId === tab).length),
    [tab, templates.length, presets]
  )

  /** 格式说明弹窗内容；非 null 时显示 */
  const [formatDoc, setFormatDoc] = React.useState<string | null>(null)

  // ---- 批量 ----
  const [rootDraft, setRootDraft] = React.useState('')
  const [rootList, setRootList] = React.useState<string[]>([])
  const [templateId, setTemplateId] = React.useState('')
  const [backup, setBackup] = React.useState(settings.backupBeforeWrite)
  const [backupTouched, setBackupTouched] = React.useState(false)
  const [scanning, setScanning] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState<BatchResult | null>(null)

  /** 重新拉一遍模块包模板 */
  const refreshPresets = React.useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.listPackPresets()
      setPresets(list)
    } catch {
      /* 读失败就当空列表 —— 这一栏不是关键路径 */
    }
  }, [])

  // 进页面时拉一次模板与工程候选（这两个都不依赖当前工程）
  React.useEffect(() => {
    void refreshTemplates()
    void refreshCandidates()
    void refreshPresets()
    // tab 是包生成的，包列表得先到位
    if (packs.length === 0) void refreshPacks()
  }, [refreshTemplates, refreshCandidates, refreshPresets, refreshPacks, packs.length])

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

  /**
   * 导出单个模板到 .cvtpl.json。
   * 用户取消对话框时返回 null，不提示（取消不是错误）。
   */
  const onExport = async (t: ConfigTemplate): Promise<void> => {
    setExportingId(t.id)
    try {
      const path = await window.api.exportTemplate({
        projectTemplates: [t],
        defaultName: t.name
      })
      if (path) notify('ok', `已导出到 ${path}`)
    } catch (err) {
      notify('err', `导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExportingId(null)
    }
  }

  /**
   * 导出当前 tab 里的全部模板。
   *
   * 按 tab 导出而不是「一次导出所有」：用户最常需要的是
   * 「把 VT13 这套发给队友」，不该顺带把整个工程配置也塞进去。
   */
  const onExportAll = async (): Promise<void> => {
    try {
      /*
       * 导出**当前 tab** 里的模板。
       *
       * 在「工程质量」tab 就导工程模板，在「遥控模块 VT13」tab 就导这个包的模板 ——
       * 想整套备份的话切到工程配置导一次、再各自导一次也不麻烦；
       * 但按 tab 导出能避免「我只想给队友 VT13 的模板，结果把整个配置也带出去了」。
       */
      const isProjectTab = tab === 'project'
      const path = await window.api.exportTemplate({
        projectTemplates: isProjectTab ? templates : [],
        packPresets: isProjectTab ? [] : presets.filter((p) => p.packId === tab),
        defaultName: isProjectTab ? 'CV Studio 工程配置模板' : `${activePack?.name ?? tab} 模板`
      })
      if (path) {
        const n = isProjectTab ? templates.length : presets.filter((p) => p.packId === tab).length
        notify('ok', `已导出 ${n} 个模板到 ${path}`)
      }
    } catch (err) {
      notify('err', `导出失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 打开模板文件格式说明。
   *
   * 这个面板的主要用途是**给 AI 看** —— 用户可以让 AI 照着格式写一个模板，
   * 所以除了展示，还提供「复制」按钮直接把整段说明塞进剪贴板。
   */
  const onShowFormatDoc = async (): Promise<void> => {
    try {
      const doc = await window.api.getTemplateFormatDoc()
      setFormatDoc(doc)
    } catch (err) {
      notify('err', `读取格式说明失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 导入模板：可以一次选多个 .json，每个文件里也可以有多条。
   * 文件里的模块包模板会自动归到「模块包模板」那栏，不用用户操心。
   */
  const onImport = async (): Promise<void> => {
    setImporting(true)
    try {
      const res = await window.api.importTemplates()
      if (!res) return // 用户取消
      await refreshTemplates()

      const parts: string[] = []
      if (res.importedProject > 0) parts.push(`工程配置模板 ${res.importedProject} 个`)
      if (res.importedPack > 0) parts.push(`模块包模板 ${res.importedPack} 个`)

      if (parts.length > 0) {
        notify('ok', `已导入：${parts.join('，')}`)
      }
      if (res.skipped > 0 || res.missingPacks.length > 0) {
        const extra: string[] = []
        if (res.skipped > 0) extra.push(`${res.skipped} 条格式不对已跳过`)
        if (res.missingPacks.length > 0) extra.push(`缺少模块包：${res.missingPacks.join('、')}`)
        notify('warn', extra.join('；'))
      }
    } catch (err) {
      notify('err', `导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
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

  /**
   * 每个已安装模块包一个 tab。
   *
   * 名称用包自己的显示名（「遥控模块 VT13」「VOFA+ 在线调参」），
   * 计数只算这个包的模板。
   */
  const packTabs = packs.map((p) => ({
    id: p.id,
    name: p.name,
    count: presets.filter((x) => x.packId === p.id).length
  }))

  /** 当前 tab 下的模块包模板 */
  const visiblePresets = tab === 'project' ? [] : presets.filter((x) => x.packId === tab)

  return (
    <>
      <PageHeader
        title="模板"
        subtitle={`${templates.length} 个工程配置 · ${presets.length} 个模块包模板 · 不需要先选工程`}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={refreshing}
              onClick={() => {
                void onRefresh()
                void refreshPresets()
              }}
              title="重新读一遍模板列表"
            >
              {refreshing ? <Spinner /> : <Icons.refresh />}
              刷新
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={importing}
              onClick={() => void onImport()}
              title="从 .json 导入 —— 一个文件里可以同时有工程配置模板和模块包模板"
            >
              {importing ? <Spinner /> : <Icons.folder />}
              导入
            </Button>
            {/* 全部导出：两类模板写进同一个文件，方便整套备份/发给队友 */}
            <Button
              size="sm"
              variant="ghost"
              disabled={currentTabCount === 0}
              onClick={() => void onExportAll()}
              title={`导出「${tab === 'project' ? '工程配置' : (activePack?.name ?? tab)}」里的全部模板`}
            >
              <Icons.write />
              导出本页
            </Button>
            <Button size="sm" variant="primary" onClick={openNew}>
              <Icons.write />
              新建模板
            </Button>
          </>
        }
      />

      <PageBody>
        {/* ---- 分类切换 ----
            按「来源」分：工程配置一份，然后**每个模块包各一份**。
            不做成「工程配置 / 模块包」两栏 —— 那样遥控和 VOFA 的模板
            挤在一个列表里，还得看每行的小字才知道是哪个包的。 */}
        <div className="segmented">
          <button
            type="button"
            className={`segmented__item${tab === 'project' ? ' segmented__item--active' : ''}`}
            onClick={() => setTab('project')}
          >
            工程配置
            <span className="segmented__count">{templates.length}</span>
          </button>
          {packTabs.map((pt) => (
            <button
              key={pt.id}
              type="button"
              className={`segmented__item${tab === pt.id ? ' segmented__item--active' : ''}`}
              onClick={() => setTab(pt.id)}
            >
              {pt.name}
              <span className="segmented__count">{pt.count}</span>
            </button>
          ))}
        </div>

        {tab !== 'project' ? (
          <Card
            title={activePack ? `${activePack.name} 的模板` : '模块包模板'}
            hint={activePack?.summary}
            actions={
              <Button size="sm" variant="ghost" onClick={() => void onShowFormatDoc()}>
                <Icons.info />
                格式说明
              </Button>
            }
          >
            {visiblePresets.length === 0 ? (
              <Alert kind="info">
                这个模块还没有模板。到左侧「扩展」里打开它，
                在「执行选项」里把当前这套参数存下来，之后就能在这里管理和导出。
              </Alert>
            ) : (
              <div className="list">
                {visiblePresets.map((p) => (
                  <div key={p.id} className="list__row" style={{ alignItems: 'center' }}>
                    <div className="grow">
                      <div className="small">
                        {p.name}
                        {/* 内置模板带个标签，让人知道这个是跟着包来的 */}
                        {p.builtin && (
                          <span
                            className="mono faint"
                            style={{
                              marginLeft: 8,
                              fontSize: 11,
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                              padding: '0 5px'
                            }}
                          >
                            内置
                          </span>
                        )}
                        <span className="faint"> · </span>
                        <span className="mono faint">{p.packId}</span>
                      </div>
                      {p.note && <div className="faint small">{p.note}</div>}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void window.api
                          .exportTemplate({
                            packPresets: [p],
                            defaultName: p.name
                          })
                          .then((path) => {
                            if (path) notify('ok', `已导出到 ${path}`)
                          })
                      }
                    >
                      导出
                    </Button>
                    {p.builtin ? (
                      <Button size="sm" variant="ghost" disabled title="内置模板跟着模块包走，不能删除">
                        不可删除
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          void window.api.deletePackPreset(p.id).then((list) => {
                            setPresets(list)
                            notify('ok', `已删除模板「${p.name}」`)
                          })
                        }}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : null}

        {/* 下面这些是「工程配置模板」的内容 */}
        {tab === 'project' && (
          <>
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
                    title={
                      project
                        ? '用这个模板的参数重新检测当前工程'
                        : '还没有选择工程，先去「配置调试文件」选一个'
                    }
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
                  {/* 导成 .cvtpl.json，可以发给别人或存起来 */}
                  <Button
                    size="sm"
                    disabled={exportingId === t.id}
                    onClick={() => void onExport(t)}
                    title="导出成 .json 文件，可以分享或备份"
                  >
                    {exportingId === t.id ? <Spinner /> : null}
                    导出
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
          </>
        )}
      </PageBody>

      {/* ---- 格式说明 ---- */}
      {formatDoc && (
        <Modal
          title="模板文件格式"
          width={820}
          onClose={() => setFormatDoc(null)}
          footer={
            <>
              <span className="small faint" style={{ marginRight: 'auto' }}>
                可以直接复制给 AI，让它照着这个格式写模板
              </span>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(formatDoc)
                    .then(() => notify('ok', '格式说明已复制'))
                    .catch(() => notify('err', '复制失败，请手动选中文本复制'))
                }}
              >
                复制
              </Button>
              <Button size="sm" variant="primary" onClick={() => setFormatDoc(null)}>
                知道了
              </Button>
            </>
          }
        >
          <pre
            className="mono small"
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              maxHeight: '60vh',
              overflow: 'auto',
              lineHeight: 1.6
            }}
          >
            {formatDoc}
          </pre>
        </Modal>
      )}

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
