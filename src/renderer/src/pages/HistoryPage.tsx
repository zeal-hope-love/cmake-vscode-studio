/**
 * 历史记录。
 *
 * 每次真正动了东西（检测工程 / 写入 / 清除 / 还原 / 套用模板 / 批量 / 烧录）都留一条。
 * 重点是每条后面的**直达操作**：不用自己回忆「刚才那个工程在哪」，
 * 点一下就重新配置 / 预览差异 / 还原到那次写入前 / 打开那个模板。
 */

import React from 'react'
import { useStudio } from '../state/store'
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageBody,
  PageHeader,
  PathText,
  Select
} from '../components/ui'
import { Icons } from '../components/icons'
import type { HistoryAction, HistoryEntry, HistoryKind } from '@shared/types'

const KIND_META: Record<
  HistoryKind,
  { label: string; kind: 'ok' | 'warn' | 'err' | 'accent' | 'default' }
> = {
  'project-load': { label: '检测工程', kind: 'default' },
  write: { label: '写入配置', kind: 'ok' },
  clear: { label: '清除配置', kind: 'warn' },
  restore: { label: '还原', kind: 'accent' },
  'template-save': { label: '保存模板', kind: 'default' },
  'template-delete': { label: '删除模板', kind: 'warn' },
  'template-apply': { label: '套用模板', kind: 'accent' },
  batch: { label: '批量', kind: 'default' },
  run: { label: '构建 / 烧录', kind: 'default' }
}

export default function HistoryPage(): React.JSX.Element {
  const history = useStudio((s) => s.history)
  const refreshHistory = useStudio((s) => s.refreshHistory)
  const removeHistoryEntry = useStudio((s) => s.removeHistoryEntry)
  const clearHistory = useStudio((s) => s.clearHistory)
  const loadProject = useStudio((s) => s.loadProject)
  const openPreview = useStudio((s) => s.openPreview)
  const restoreSnapshot = useStudio((s) => s.restoreSnapshot)
  const openTemplateInEditor = useStudio((s) => s.openTemplateInEditor)
  const projectRoot = useStudio((s) => s.projectRoot)
  const setPage = useStudio((s) => s.setPage)
  const busy = useStudio((s) => s.busy)
  const notify = useStudio((s) => s.notify)

  const [filter, setFilter] = React.useState<'all' | HistoryKind>('all')
  const [confirmClear, setConfirmClear] = React.useState(false)

  React.useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  const rows = filter === 'all' ? history : history.filter((h) => h.kind === filter)

  /**
   * 执行一条直达操作。
   *
   * 关键点：如果这条记录属于**另一个工程**，先把那个工程载进来再动作 ——
   * 否则「还原到那次写入前」会拿着当前工程的上下文去还原别的工程的快照。
   */
  const runAction = async (entry: HistoryEntry, action: HistoryAction): Promise<void> => {
    const target = action.projectRoot ?? entry.projectRoot
    const needSwitch = Boolean(target) && target!.toLowerCase() !== projectRoot.toLowerCase()

    try {
      switch (action.kind) {
        case 'open-in-vscode':
          if (target) await window.api.openInVSCode(target)
          return
        case 'open-in-explorer':
          if (target) await window.api.openInExplorer(target)
          return
        case 'open-template':
          setPage('templates')
          if (action.templateId) openTemplateInEditor(action.templateId)
          return
        default:
          break
      }

      // 下面几个都需要「那个工程已经载入」
      if (needSwitch) {
        if (!target) return
        await loadProject(target)
      }

      switch (action.kind) {
        case 'reconfigure':
          if (target) await loadProject(target)
          setPage('project')
          break
        case 'preview':
          await openPreview()
          break
        case 'restore-snapshot':
          if (action.snapshotId) await restoreSnapshot(action.snapshotId)
          break
        default:
          break
      }
    } catch (err) {
      notify('err', `执行失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <>
      <PageHeader
        title="历史记录"
        subtitle={`${history.length} 条记录 · 每条都能直接再来一次`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => void refreshHistory()}>
              <Icons.refresh />
              刷新
            </Button>
            {confirmClear ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setConfirmClear(false)
                    void clearHistory()
                  }}
                >
                  确认清空？
                </Button>
                <Button size="sm" onClick={() => setConfirmClear(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={!history.length}
                onClick={() => setConfirmClear(true)}
              >
                清空记录
              </Button>
            )}
          </>
        }
      />

      <PageBody>
        <Alert kind="info">
          记录存在应用自己的数据目录里（不在你的工程里），最多保留 500 条。 存储位置：
          <span className="mono">%APPDATA%\CMake-VSCode-Configurator\history.json</span>
        </Alert>

        <Card
          title="操作记录"
          hint={`显示 ${rows.length} / ${history.length} 条`}
          actions={
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value as 'all' | HistoryKind)}
              options={[
                { value: 'all', label: '全部类型' },
                ...Object.entries(KIND_META).map(([key, meta]) => ({
                  value: key,
                  label: meta.label
                }))
              ]}
            />
          }
          flush
        >
          {rows.length === 0 ? (
            <div className="card__body">
              <EmptyState title="还没有记录">
                检测工程、写入配置、套用模板…… 做过的操作都会出现在这里，
                并且带着可以直接点的「再来一次」按钮。
              </EmptyState>
            </div>
          ) : (
            <DataTable
              columns={[
                { key: 'time', title: '时间', width: 165 },
                { key: 'kind', title: '类型', width: 100 },
                { key: 'what', title: '做了什么' },
                { key: 'ops', title: '直达操作', width: 480 }
              ]}
              rows={rows.map((h) => ({
                key: h.id,
                cells: [
                  <span key="t" className="small muted">
                    {new Date(h.at).toLocaleString()}
                  </span>,
                  <Badge key="k" kind={KIND_META[h.kind]?.kind ?? 'default'}>
                    {KIND_META[h.kind]?.label ?? h.kind}
                  </Badge>,
                  <div key="w">
                    <div className={h.ok ? '' : 'accent'}>
                      {h.title}
                      {!h.ok && (
                        <>
                          {' '}
                          <Badge kind="err">失败</Badge>
                        </>
                      )}
                    </div>
                    <div className="faint small">{h.detail}</div>
                    {h.projectRoot && (
                      <div className="small" style={{ marginTop: 2 }}>
                        <PathText value={h.projectRoot} />
                      </div>
                    )}
                  </div>,
                  <div key="ops" className="flex flex-wrap">
                    {h.actions.map((a, i) => (
                      <Button
                        key={i}
                        size="sm"
                        variant={a.kind === 'restore-snapshot' ? 'danger' : 'default'}
                        disabled={busy}
                        onClick={() => void runAction(h, a)}
                      >
                        {a.label}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      title="从列表里删掉这条记录"
                      onClick={() => void removeHistoryEntry(h.id)}
                    >
                      移除
                    </Button>
                  </div>
                ]
              }))}
            />
          )}
        </Card>
      </PageBody>
    </>
  )
}
