/**
 * 检查与清理页。
 *
 * 把「比较杂的事」集中到一页，别让工程总览页变成杂物间：
 *   · 检测过程中发现的问题与提示
 *   · 清除本工具写入的 .vscode 配置（回到「从没配置过」的样子）
 *   · 写入快照与还原
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
  Modal,
  PageBody,
  PageHeader,
  Spinner
} from '../components/ui'
import { NoProject } from '../components/NoProject'
import { DiffView } from '../components/DiffView'
import { Icons } from '../components/icons'
import type { ProjectIssueFix, RenamePlan } from '@shared/types'

export default function InspectPage(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const projectRoot = useStudio((s) => s.projectRoot)
  const busy = useStudio((s) => s.busy)
  const snapshots = useStudio((s) => s.snapshots)
  const refreshSnapshots = useStudio((s) => s.refreshSnapshots)
  const restoreSnapshot = useStudio((s) => s.restoreSnapshot)
  const clearVscodeConfig = useStudio((s) => s.clearVscodeConfig)
  const cleanArtifacts = useStudio((s) => s.cleanArtifacts)
  const setPage = useStudio((s) => s.setPage)
  const refreshProject = useStudio((s) => s.refreshProject)
  const notify = useStudio((s) => s.notify)
  const refreshHistory = useStudio((s) => s.refreshHistory)

  const [confirming, setConfirming] = React.useState(false)
  /** 待确认的「一键修复」，比如清理陈旧产物 */
  const [confirmFix, setConfirmFix] = React.useState<ProjectIssueFix | null>(null)
  /** 改名计划（只算不写，界面看 diff 用） */
  const [renamePlan, setRenamePlan] = React.useState<RenamePlan | null>(null)
  const [renameBusy, setRenameBusy] = React.useState(false)
  const [renameIdx, setRenameIdx] = React.useState(0)

  React.useEffect(() => {
    void refreshSnapshots()
  }, [refreshSnapshots, projectRoot])

  if (!project) {
    return (
      <>
        <PageHeader title="检查与清理" subtitle="还没有选择工程" />
        <PageBody>
          <NoProject reason="陈旧产物、快照备份这些都是针对具体工程的。" />
        </PageBody>
      </>
    )
  }

  // 本工具管理的文件现在还在不在
  /**
   * 打开改名流程：先向主进程要「改动计划」（只算不写），界面展示 diff，
   * 确认后才 apply。改名会改变构建产物名，属于不可逆操作，所以多这一步。
   */
  const openRename = async (newName: string): Promise<void> => {
    setRenameBusy(true)
    try {
      const plan = await window.api.projectRenamePlan(projectRoot, newName, true)
      setRenamePlan(plan)
      setRenameIdx(0)
    } finally {
      setRenameBusy(false)
    }
  }

  const applyRename = async (): Promise<void> => {
    if (!renamePlan) return
    setRenameBusy(true)
    try {
      const r = await window.api.projectRenameApply(renamePlan)
      if (!r.ok) {
        notify('err', r.errors.join('；') || '改名失败')
        return
      }
      notify(
        'ok',
        `已改名成 ${renamePlan.newName}（${r.written.length} 个文件）。建议清理 build 后重新构建。`
      )
      setRenamePlan(null)
      await refreshHistory()
      await refreshProject()
    } catch (err) {
      notify('err', `改名失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRenameBusy(false)
    }
  }

  /**
   * 「本工具写入的」要按**内容特征**认，不能看文件在不在。
   * STM32Cube / CMake Tools 扩展也会往 .vscode 里写同名文件，
   * 只看存在性的话，点「清除配置」会把别人的配置删掉。
   */
  const present = project.toolWrittenFiles
  const foreign = project.foreignVscodeFiles
  const cfgFiles = project.openocdCfgFiles.length

  return (
    <>
      <PageHeader
        title="检查与清理"
        subtitle={`${project.name} · 检测到 ${project.issues.length} 条需要注意的问题`}
        actions={
          <Button size="sm" variant="ghost" onClick={() => void refreshSnapshots()}>
            <Icons.refresh />
            刷新
          </Button>
        }
      />

      <PageBody>
        {/* ---- 需要注意的问题 ---- */}
        <Card
          title="需要注意的问题"
          hint={project.issues.length ? `${project.issues.length} 条` : '没有'}
          flush
        >
          {project.issues.length === 0 ? (
            <div className="card__body">
              <Alert kind="ok">检测下来没有发现问题，可以直接写入配置。</Alert>
            </div>
          ) : (
            <div className="card__body">
              {project.issues.map((issue, i) => (
                <Alert key={i} kind="warn">
                  <div className="flex" style={{ alignItems: 'flex-start', gap: 10 }}>
                    <span style={{ flex: 1 }}>
                      {issue.message}
                      {issue.fix && (
                        <div className="faint small" style={{ marginTop: 4 }}>
                          {issue.fix.kind === 'rename-project' ? '会改成：' : '会删掉：'}
                          <span className="mono">{issue.fix.hint}</span>
                        </div>
                      )}
                    </span>
                    {issue.fix && issue.fix.kind === 'rename-project' && (
                      <Button
                        size="sm"
                        disabled={busy}
                        title={
                          '把 CMakeLists.txt 里的工程名改成文件夹名，构建产物就会跟着改名。' +
                          '点开先看 diff，确认后才写。写之前自动存快照，可还原。'
                        }
                        onClick={() => void openRename(issue.fix!.targetName!)}
                      >
                        改名
                      </Button>
                    )}
                    {issue.fix && issue.fix.kind === 'remove-build-artifacts' && (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        title="删除这些陈旧产物。主进程会逐个校验路径与后缀，删不掉的会明确告诉你原因。"
                        onClick={() => setConfirmFix(issue.fix!)}
                      >
                        {busy ? <Spinner /> : null}
                        {issue.fix.label}
                      </Button>
                    )}
                  </div>
                </Alert>
              ))}
            </div>
          )}
        </Card>

        {/* ---- 检测提示 ---- */}
        {project.notes.length > 0 && (
          <Card title="检测提示" hint="不是问题，只是说明一下工具做了什么判断" flush>
            <div className="card__body">
              {project.notes.map((n, i) => (
                <div
                  key={i}
                  className="small"
                  style={{ padding: '6px 0', borderBottom: '1px dashed var(--border)' }}
                >
                  · {n}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ---- 清除配置 ---- */}
        <Card title="清除配置" hint="把工程变回「从没被配置过」的样子">
          <div className="mb-12 small muted" style={{ lineHeight: 1.8 }}>
            删除本工具写入的这些文件：
            <span className="mono"> .vscode/launch.json</span>、<span className="mono">tasks.json</span>
            、<span className="mono">settings.json</span>、
            <span className="mono">c_cpp_properties.json</span>、
            <span className="mono">openocd-*.cfg</span>。
            <br />
            <span className="faint">
              只会删这几个本工具负责的文件，你在 .vscode 里自己放的其它文件不受影响。
              删除前同样会存一份快照，所以这一步也能撤销。
            </span>
          </div>

          <div className="flex mb-12">
            {present.length === 0 && cfgFiles === 0 ? (
              <Badge kind="ok">当前工程没有本工具写入的配置</Badge>
            ) : (
              <Badge kind="warn">当前存在 {present.length + cfgFiles} 个本工具写入的配置文件</Badge>
            )}
          </div>

          {/*
            告诉用户「这几个文件存在，但不是我写的，我不会动」。
            不写清楚的话，用户会以为清除时漏了文件或者不敢点。
          */}
          {foreign.length > 0 && (
            <Alert kind="info">
              <div className="bold mb-8">
                另有 {foreign.length} 个配置文件存在，但<b>不是本工具写的</b>，清除时不会动它们
              </div>
              {foreign.map((f) => (
                <div key={f.path} className="small">
                  <span className="mono">{f.path}</span>
                  <span className="faint"> —— {f.why}</span>
                </div>
              ))}
            </Alert>
          )}

          {confirming ? (
            <Alert kind="err">
              <div className="bold mb-8">确定要清除吗？</div>
              <div className="small mb-12">
                会删掉上面列出的文件。删除前会自动存快照，之后可以在下面的「备份与还原」里找回。
              </div>
              <div className="flex">
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false)
                    void clearVscodeConfig()
                  }}
                >
                  确认清除
                </Button>
                <Button onClick={() => setConfirming(false)}>取消</Button>
              </div>
            </Alert>
          ) : (
            <Button
              variant="danger"
              disabled={busy || (present.length === 0 && cfgFiles === 0)}
              onClick={() => setConfirming(true)}
            >
              <Icons.broom />
              清除本工具写入的 .vscode 配置
            </Button>
          )}
        </Card>

        {/* ---- 备份与还原 ---- */}
        <Card
          title="备份与还原"
          hint="每次写入（或清除）前自动存快照，随时能退回去"
          actions={
            <Button size="sm" variant="ghost" onClick={() => void refreshSnapshots()}>
              <Icons.refresh />
              刷新
            </Button>
          }
          flush
        >
          {snapshots.length === 0 ? (
            <div className="card__body">
              <div className="faint small">
                还没有任何记录。第一次写入或清除时会自动存一份快照，之后如果发现不对，
                可以在这里一键还原到那一刻的样子（当时不存在的文件会被删掉，真正回到原样）。
              </div>
            </div>
          ) : (
            <>
              <DataTable
                columns={[
                  { key: 'time', title: '时间' },
                  { key: 'files', title: '涉及文件' },
                  { key: 'new', title: '其中新建' },
                  { key: 'act', title: '操作' }
                ]}
                rows={snapshots.map((snap, index) => ({
                  key: snap.id,
                  cells: [
                    <span key="t">
                      {new Date(snap.createdAt).toLocaleString()}
                      {index === 0 && (
                        <>
                          {' '}
                          <Badge kind="accent">最近一次</Badge>
                        </>
                      )}
                    </span>,
                    `${snap.fileCount} 个`,
                    snap.newFileCount ? `${snap.newFileCount} 个` : '—',
                    <Button
                      key="a"
                      size="sm"
                      disabled={busy}
                      onClick={() => void restoreSnapshot(snap.id)}
                    >
                      还原到此时
                    </Button>
                  ]
                }))}
              />
              <div className="card__body">
                <div className="faint small">
                  快照存在应用自己的数据目录里，不在你的工程里；每个工程最多保留 20 条。
                </div>
              </div>
            </>
          )}
        </Card>
      </PageBody>

      {/* ---- 一键修复的确认弹窗 ---- */}
      {confirmFix && (
        <Modal
          title={confirmFix.label}
          width={620}
          onClose={() => setConfirmFix(null)}
          footer={
            <>
              <Button onClick={() => setConfirmFix(null)}>取消</Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  const files = confirmFix.files
                  setConfirmFix(null)
                  void cleanArtifacts(files)
                }}
              >
                确认删除
              </Button>
            </>
          }
        >
          <Alert kind="warn">
            这些是构建目录里的产物，删掉不会影响源码 —— 下次构建会重新生成。
            <div className="small mt-8">
              主进程会逐个校验：路径必须在工程内、后缀必须是构建产物，任一条不过就跳过并告诉你原因。
            </div>
          </Alert>
          <div className="list mt-12">
            {confirmFix.files.map((f) => (
              <div key={f} className="list__item">
                <span className="mono">{f}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/*
        改名确认：先看改动清单（逐文件 diff），确认后才写。
        改名会改变构建产物名，属于不可逆操作 —— 所以不直接执行，多一道确认。
      */}
      {renamePlan && (
        <Modal
          title={`把工程名改成 ${renamePlan.newName}？`}
          width={1000}
          onClose={() => setRenamePlan(null)}
          footer={
            <>
              <Button onClick={() => setRenamePlan(null)}>取消</Button>
              <Button
                variant="primary"
                disabled={renameBusy || renamePlan.blocked}
                onClick={() => void applyRename()}
              >
                {renameBusy ? <Spinner /> : null}
                确认改名（{renamePlan.changes.filter((c) => c.action !== 'skip').length} 个文件）
              </Button>
            </>
          }
        >
          {renamePlan.blocked ? (
            <Alert kind="err">
              这次改不了：
              {renamePlan.notes.map((n, i) => (
                <div key={i} className="small">
                  · {n}
                </div>
              ))}
            </Alert>
          ) : (
            <Alert kind="info">
              会改动 <b>{renamePlan.changes.filter((c) => c.action !== 'skip').length}</b> 个文件。
              写之前自动存快照，可一键还原。
            </Alert>
          )}

          <div className="small" style={{ marginTop: 8 }}>
            {renamePlan.notes.map((n, i) => (
              <div key={i}>· {n}</div>
            ))}
          </div>

          <div className="list list__scroll" style={{ maxHeight: 160, marginTop: 10 }}>
            {renamePlan.changes.map((c, i) => (
              <div
                key={c.path}
                className="list__row"
                style={{ cursor: 'pointer' }}
                onClick={() => setRenameIdx(i)}
              >
                <span className="mono small" style={{ width: 62, flex: '0 0 auto' }}>
                  {c.action === 'create'
                    ? '＋新建'
                    : c.action === 'patch'
                      ? '改几行'
                      : c.action === 'delete'
                        ? '删除'
                        : '跳过'}
                </span>
                <div className="grow">
                  <div className="mono small">{c.path}</div>
                  <div className="faint small">{c.note}</div>
                </div>
              </div>
            ))}
          </div>

          {renamePlan.changes[renameIdx]?.before !== null &&
            renamePlan.changes[renameIdx]?.after !== null && (
              <div style={{ marginTop: 10 }}>
                <div className="small bold mb-8">
                  差异：<span className="mono">{renamePlan.changes[renameIdx].path}</span>
                </div>
                <DiffView
                  previous={renamePlan.changes[renameIdx].before ?? ''}
                  current={renamePlan.changes[renameIdx].after ?? ''}
                />
              </div>
            )}
        </Modal>
      )}
    </>
  )
}
