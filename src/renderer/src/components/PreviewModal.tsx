/**
 * 写入流程弹窗，分三个阶段：
 *
 *   预览   —— 逐文件差异，确认前什么都还没动
 *   写入中 —— 逐文件实时进度（主进程每处理一个文件推一次）
 *   结果   —— 每个文件是新建还是覆盖，并可直接「还原到写入前」
 *
 * 「还原」靠的是写入前自动存下的快照，所以点错了也不怕。
 */

import React from 'react'
import { useStudio } from '../state/store'
import { DiffView } from './DiffView'
import { Alert, Badge, Button, Checkbox, Modal, Spinner } from './ui'
import { probeByKey } from '@shared/probes'
import { WriteSummary } from './WriteSummary'

type Phase = 'preview' | 'writing' | 'result'

const STATUS_META: Record<
  string,
  { label: string; kind: 'ok' | 'warn' | 'err' | 'accent' | 'default' }
> = {
  writing: { label: '写入中', kind: 'accent' },
  written: { label: '已写入', kind: 'ok' },
  unchanged: { label: '未改动', kind: 'default' },
  error: { label: '失败', kind: 'err' }
}

export function PreviewModal(): React.JSX.Element | null {
  const planned = useStudio((s) => s.planned)
  const open = useStudio((s) => s.previewOpen)
  const close = useStudio((s) => s.closePreview)
  const writeNow = useStudio((s) => s.writeNow)
  const settings = useStudio((s) => s.settings)
  const projectRoot = useStudio((s) => s.projectRoot)
  const writeProgress = useStudio((s) => s.writeProgress)
  const lastWriteResult = useStudio((s) => s.lastWriteResult)
  const restoreSnapshot = useStudio((s) => s.restoreSnapshot)
  const activeTemplate = useStudio((s) => s.activeTemplate)
  const options = useStudio((s) => s.options)
  const bundle = useStudio((s) => s.bundle)

  const [active, setActive] = React.useState(0)
  const [backup, setBackup] = React.useState(settings.backupBeforeWrite)
  const [collapsed, setCollapsed] = React.useState(true)
  const [phase, setPhase] = React.useState<Phase>('preview')
  const [restoring, setRestoring] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setActive(0)
      setBackup(useStudio.getState().settings.backupBeforeWrite)
      setPhase('preview')
      setRestoring(false)
    }
  }, [open])

  if (!open) return null

  const confirm = async (): Promise<void> => {
    setPhase('writing')
    await writeNow(backup)
    setPhase('result')
  }

  const doRestore = async (): Promise<void> => {
    if (!lastWriteResult?.snapshotId) return
    setRestoring(true)
    await restoreSnapshot(lastWriteResult.snapshotId)
    setRestoring(false)
    close()
  }

  // ------------------------------------------------------------------------
  // 阶段二：写入中
  // ------------------------------------------------------------------------
  if (phase === 'writing') {
    const done = writeProgress.filter((p) => p.status !== 'writing').length
    const total = writeProgress[0]?.total ?? planned.length

    return (
      <Modal title="正在写入" width={640} onClose={() => undefined}>
        <div className="flex mb-12">
          <Spinner />
          <span>
            正在写入 {done} / {total} 个文件…
          </span>
        </div>

        <div className="list">
          {planned.map((file, index) => {
            const progress = writeProgress.find((p) => p.relativePath === file.relativePath)
            return (
              <div key={file.relativePath} className="list__item">
                <span className="mono" style={{ flex: 1, minWidth: 0 }}>
                  {file.relativePath}
                </span>
                {progress ? (
                  <Badge kind={STATUS_META[progress.status]?.kind ?? 'default'}>
                    {STATUS_META[progress.status]?.label ?? progress.status}
                  </Badge>
                ) : (
                  <span className="faint small">排队中 #{index + 1}</span>
                )}
              </div>
            )
          })}
        </div>
      </Modal>
    )
  }

  // ------------------------------------------------------------------------
  // 阶段三：结果
  // ------------------------------------------------------------------------
  if (phase === 'result') {
    const result = lastWriteResult
    const rows = planned.map((file) => {
      const target = file.path.toLowerCase()
      if (result?.errors.some((e) => e.startsWith(file.relativePath))) {
        return { file, status: 'error' as const, note: '写入失败' }
      }
      if (result?.written.some((w) => w.toLowerCase() === target)) {
        return { file, status: 'written' as const, note: file.exists ? '已覆盖' : '已新建' }
      }
      return { file, status: 'unchanged' as const, note: file.exists ? '内容相同，未改动' : '未改动' }
    })

    const writtenCount = rows.filter((r) => r.status === 'written').length
    const errorCount = rows.filter((r) => r.status === 'error').length

    return (
      <Modal
        title={errorCount ? '写入完成（有失败）' : '写入完成'}
        width={720}
        onClose={close}
        footer={
          <>
            {result?.snapshotId && writtenCount > 0 && (
              <Button variant="ghost" onClick={() => void doRestore()} disabled={restoring}>
                {restoring ? '正在还原…' : '还原到写入前'}
              </Button>
            )}
            <div className="spacer" />
            <Button variant="ghost" onClick={() => void window.api.openInVSCode(projectRoot)}>
              在 VSCode 打开
            </Button>
            <Button variant="primary" onClick={close}>
              完成
            </Button>
          </>
        }
      >
        {errorCount ? (
          <Alert kind="err">有 {errorCount} 个文件写入失败，明细见下表。其它文件已正常写入。</Alert>
        ) : writtenCount === 0 ? (
          <Alert kind="info">所有文件的内容都已经是最新的，没有做任何改动。</Alert>
        ) : (
          <Alert kind="ok">
            已写入 <b>{writtenCount}</b> 个文件到 <span className="mono">{projectRoot}</span>
            {result?.backups.length
              ? `，并在 .vscode/.backup/ 留了 ${result.backups.length} 份备份`
              : ''}
            。
            {result?.snapshotId && (
              <div className="small mt-8">
                写入前的内容已存成快照，随时可以点左下角「还原到写入前」退回去。
              </div>
            )}
          </Alert>
        )}

        <div className="list">
          {rows.map(({ file, status, note }) => (
            <div key={file.relativePath} className="list__item">
              <span style={{ flex: 1, minWidth: 0 }}>
                <div className="mono">{file.relativePath}</div>
                <div className="faint small">{note}</div>
              </span>
              <Badge kind={STATUS_META[status]?.kind ?? 'default'}>
                {STATUS_META[status]?.label ?? status}
              </Badge>
            </div>
          ))}
        </div>

        {result?.errors.length ? (
          <div className="mt-12">
            <Alert kind="err">
              <div className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
                {result.errors.join('\n')}
              </div>
            </Alert>
          </div>
        ) : null}
      </Modal>
    )
  }

  // ------------------------------------------------------------------------
  // 阶段一：预览
  // ------------------------------------------------------------------------
  const file = planned[active]

  return (
    <Modal
      title="写入预览"
      width={980}
      onClose={close}
      footer={
        <>
          <Checkbox checked={backup} onChange={setBackup} label="额外把原文件备份到 .vscode/.backup/" />
          <div className="spacer" />
          <Button onClick={close}>取消</Button>
          <Button variant="primary" onClick={confirm} disabled={!planned.length}>
            确认写入 {planned.length} 个文件
          </Button>
        </>
      }
    >
      {!planned.length ? (
        <Alert kind="warn">没有待写入的文件。</Alert>
      ) : (
        <>
          <Alert kind="accent">
            <div>
              将写入 <span className="mono">{projectRoot || '(未选择工程)'}</span> 下的 {planned.length}{' '}
              个文件。已有的同名文件会被<span className="bold">整体覆盖</span>
              ，但写入前会自动存一份快照，之后可以一键还原。
            </div>

            {/*
              这里只**显示**用的是哪套生成参数，不提供切换 ——
              切换的入口在「工程总览」两步引导条的第②步里（那儿才是决定「要怎么写」的地方）。
            */}
            <div className="row mt-8" style={{ alignItems: 'center', gap: 8 }}>
              <span className="small" style={{ flex: '0 0 auto' }}>
                生成参数来源
              </span>
              <span className="small">
                {activeTemplate ? (
                  <>
                    模板 <span className="accent bold">「{activeTemplate.name}」</span>
                  </>
                ) : (
                  <>
                    <span className="bold">默认</span>
                    <span className="faint">（按本工程的检测结果生成）</span>
                  </>
                )}
              </span>
              <span className="faint small">
                · 想换？关掉这个窗口，在「写入 .vscode 配置」那一步里选
              </span>
            </div>
            <div className="small faint" style={{ marginTop: 4 }}>
              {options ? (
                <>
                  调试探针 <span className="mono">{probeByKey(options.probeKey).label}</span> · 固件{' '}
                  <span className="mono">{options.elfName}</span> · 调试目录{' '}
                  <span className="mono">{options.debugDir}</span>
                  {options.device && (
                    <>
                      {' '}
                      · 芯片 <span className="mono">{options.device}</span>
                    </>
                  )}
                </>
              ) : null}
            </div>
          </Alert>

          {/*
            写完 VSCode 里多了什么、按哪个键 —— 放在这里，因为用户一定会看这个弹窗。
            数据从真实 bundle 推导（见 WriteSummary），不写死文案。
          */}
          {bundle && <WriteSummary bundle={bundle} />}

          <div className="split split--wide-left">
            <div className="list list__scroll">
              {planned.map((f, i) => (
                <div
                  key={f.relativePath}
                  className={i === active ? 'list__item list__item--active' : 'list__item'}
                  onClick={() => setActive(i)}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div className="mono truncate">{f.name}</div>
                    <div className="faint small">{f.exists ? '已存在，将被覆盖' : '新建文件'}</div>
                  </span>
                  {f.exists ? <Badge kind="warn">覆盖</Badge> : <Badge kind="ok">新建</Badge>}
                </div>
              ))}
            </div>

            <div>
              {file && (
                <>
                  <div className="flex mb-8">
                    <span className="mono bold">{file.relativePath}</span>
                    <div className="spacer" />
                    <Button size="sm" variant="ghost" onClick={() => setCollapsed((v) => !v)}>
                      {collapsed ? '展开全部' : '折叠相同行'}
                    </Button>
                  </div>
                  <DiffView previous={file.previous} current={file.content} collapsed={collapsed} />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}
