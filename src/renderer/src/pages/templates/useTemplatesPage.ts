/**
 * 模板页的**状态与动作**。
 *
 * 原来这些东西和 540 行 JSX 挤在同一个函数里，改一个动作要往下翻半屏，
 * 看渲染又要往上翻回来。现在逻辑在这里，`TemplatesPage.tsx` 只剩 JSX。
 *
 * 返回值用**同名**字段，页面那边一句解构就接上，渲染代码不用改。
 */

import React from 'react'
import { useStudio } from '../../state/store'
import { buildTemplateSkeleton } from '@shared/templateSkeleton'
import type { PackPreset } from '@shared/templateFormat'
import type { BatchResult, ConfigTemplate } from '@shared/types'
import { emptyTemplate } from '../TemplateEditor'

export function useTemplatesPage() {
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

  return {
    templates,
    project,
    packs,
    saveTemplate,
    duplicateTemplate,
    notify,
    editing,
    setEditing,
    name,
    setName,
    note,
    setNote,
    saving,
    refreshing,
    viewing,
    setViewing,
    confirmId,
    deletingId,
    applyingId,
    importing,
    exportingId,
    tab,
    setTab,
    presets,
    setPresets,
    activePack,
    currentTabCount,
    formatDoc,
    setFormatDoc,
    rootDraft,
    setRootDraft,
    rootList,
    setRootList,
    templateId,
    setTemplateId,
    backup,
    setBackup,
    setBackupTouched,
    scanning,
    running,
    result,
    refreshPresets,
    onRefresh,
    onCreate,
    onApply,
    onDelete,
    onExport,
    onExportAll,
    onShowFormatDoc,
    onImport,
    copyJson,
    addRoot,
    addFromCandidates,
    runBatch,
    openNew
  }
}
