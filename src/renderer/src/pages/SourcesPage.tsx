/**
 * 工程 · 构建目标与源文件
 *
 * 解决一个天天遇到但没人管的麻烦：**往 CMake 工程里加一个 .c 文件，编译不进去**。
 * CMake 不会自动扫描新文件，必须写进 `CMakeLists.txt` 的 `add_executable` /
 * `target_sources` —— 忘了就是链接期 `undefined reference`，而且报错位置离真正原因很远。
 *
 * 这一页做三件事：
 *   1. 列出**磁盘上有、但整个工程的 CMakeLists 都没引用**的可编译文件（就是漏掉的那些）
 *   2. 勾一下就能加进构建 / 移出构建，改之前给你逐行 diff
 *   3. 顺手能新建源码骨架（.c / .h / FreeRTOS 任务）
 *
 * 安全网：写入前自动存快照，历史页能一键还原；编辑只做**整行插入/删除**，
 * 不重排你手写的任何一行。
 */

import React from 'react'
import { NoProject } from '../components/NoProject'
import { DiffView } from '../components/DiffView'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Modal,
  PageBody,
  PageHeader,
  Select,
  TextInput
} from '../components/ui'
import { useStudio } from '../state/store'
import type { CmakeApplyResult, CmakeChangePreview, CmakeScanResult, NewFileKind } from '@shared/types'

const NEW_FILE_KINDS: Array<{ value: NewFileKind; label: string }> = [
  { value: 'c', label: 'C 源文件 (.c)' },
  { value: 'h', label: 'C 头文件 (.h)' },
  { value: 'cpp', label: 'C++ 源文件 (.cpp)' },
  { value: 'task-c', label: 'FreeRTOS 任务 (.c)' },
  { value: 'task-h', label: 'FreeRTOS 任务头 (.h)' }
]

export function SourcesPage(): React.JSX.Element {
  const projectRoot = useStudio((s) => s.projectRoot)
  const project = useStudio((s) => s.project)
  const notify = useStudio((s) => s.notify)
  const refreshHistory = useStudio((s) => s.refreshHistory)

  const [scan, setScan] = React.useState<CmakeScanResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [target, setTarget] = React.useState('')
  const [checked, setChecked] = React.useState<Set<string>>(new Set())
  const [preview, setPreview] = React.useState<CmakeChangePreview | null>(null)
  const [pending, setPending] = React.useState<{ add: string[]; remove: string[] } | null>(null)
  const [filter, setFilter] = React.useState('')
  const [newName, setNewName] = React.useState('')
  const [newKind, setNewKind] = React.useState<NewFileKind>('c')

  const reload = React.useCallback(async (): Promise<void> => {
    if (!projectRoot) return
    setBusy(true)
    try {
      const r = await window.api.cmakeScan(projectRoot)
      setScan(r)
      // 默认选第一个可执行目标
      const first = r.targets.find((t) => t.kind === 'executable') ?? r.targets[0]
      setTarget((cur) => cur || first?.name || '')
      setChecked(new Set())
    } catch (err) {
      notify('err', `扫描失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [projectRoot, notify])

  React.useEffect(() => {
    void reload()
  }, [reload])

  if (!projectRoot || !project) {
    return (
      <>
        <PageHeader title="构建目标与源文件" subtitle="还没有选择工程" />
        <PageBody>
          <NoProject reason="要读工程的 CMakeLists.txt 才能知道哪些文件在构建里。" />
        </PageBody>
      </>
    )
  }

  // ------------------------------------------------------------------------
  // 预览 / 写入
  // ------------------------------------------------------------------------

  const openPreview = async (add: string[], remove: string[]): Promise<void> => {
    try {
      const p = await window.api.cmakePreview({ root: projectRoot, targetName: target, add, remove })
      if (!p.changed) {
        notify('warn', '没有需要改动的地方')
        return
      }
      setPending({ add, remove })
      setPreview(p)
    } catch (err) {
      notify('err', `预览失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const confirmWrite = async (): Promise<void> => {
    if (!pending) return
    try {
      const r: CmakeApplyResult = await window.api.cmakeApply({
        root: projectRoot,
        targetName: target,
        add: pending.add,
        remove: pending.remove
      })
      if (!r.ok) {
        notify('err', r.errors.join('；') || '写入失败')
        return
      }
      const bits = [
        r.added.length ? `加入 ${r.added.length} 个` : '',
        r.removed.length ? `移除 ${r.removed.length} 个` : ''
      ]
        .filter(Boolean)
        .join('，')
      notify('ok', `CMakeLists.txt 已更新（${bits}）。下一步构建会重新配置。`)
      setPreview(null)
      setPending(null)
      await Promise.all([reload(), refreshHistory()])
    } catch (err) {
      notify('err', `写入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const createFile = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) {
      notify('warn', '先填文件名')
      return
    }
    try {
      const r = await window.api.cmakeCreateFile(projectRoot, name, newKind)
      if (!r.ok) {
        notify('err', r.error ?? '新建失败')
        return
      }
      notify('ok', `已新建 ${r.relPath}，记得点上面的「加入构建」把它加进去`)
      setNewName('')
      await reload()
    } catch (err) {
      notify('err', `新建失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ------------------------------------------------------------------------

  const inBuild = scan?.inBuild ?? []
  const orphans = (scan?.orphans ?? []).filter((p) =>
    filter ? p.toLowerCase().includes(filter.toLowerCase()) : true
  )
  const shownInBuild = inBuild.filter((p) =>
    filter ? p.toLowerCase().includes(filter.toLowerCase()) : true
  )
  const targetRow = scan?.targets.find((t) => t.name === target)

  return (
    <>
      <PageHeader
        title="构建目标与源文件"
        subtitle={
          scan
            ? `${scan.targets.length} 个目标 · 构建里 ${inBuild.length} 个源文件` +
              (scan.orphans.length ? ` · ${scan.orphans.length} 个没进构建` : '')
            : '正在读取 CMakeLists.txt…'
        }
        actions={
          <Button onClick={() => void reload()} disabled={busy}>
            {busy ? '读取中…' : '重新读取'}
          </Button>
        }
      />

      <PageBody>
        {!scan ? null : (
          <>
            {scan.stats.cmakeListsCount > 1 && (
              <Alert kind="info">
                这个工程有 <b>{scan.stats.cmakeListsCount}</b> 个 CMakeLists.txt。判断「有没有进构建」时
                <b>把所有 CMakeLists 都算进来了</b> —— 所以 HAL、FreeRTOS 那些放在
                <span className="mono"> cmake/stm32cubemx/</span> 里的文件不会被误报成遗漏。
                可编译文件共 {scan.stats.compilableOnDisk} 个，其中 {scan.stats.headersOnDisk} 个头文件
                本来就不需要写进 CMakeLists。
              </Alert>
            )}

            {/* ---- 目标 ---- */}
            <Card title="构建目标" hint={`${scan.targets.length} 个`}>
              <div className="row">
                <div className="grow">
                  <Field label="要修改哪个目标">
                    <Select
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                      options={scan.targets.map((t) => ({
                        value: t.name,
                        label: `${t.name}（${t.kind} · 第 ${t.declaredLine} 行 · ${t.sourceCount} 个源文件）`
                      }))}
                    />
                  </Field>
                </div>
              </div>
              {targetRow && (
                <div className="faint small" style={{ marginTop: 6 }}>
                  <span className="mono">{targetRow.declaredCommand}</span> 声明于第{' '}
                  {targetRow.declaredLine} 行 · include {targetRow.includeCount} · define{' '}
                  {targetRow.defineCount} · link {targetRow.linkCount}
                  {targetRow.usesGlob && (
                    <>
                      {' '}
                      · <b>用了 file(GLOB) 自动收集</b>，新文件其实会自动进来，手动加是多余的
                    </>
                  )}
                </div>
              )}
            </Card>

            {/* ---- 没进构建 ---- */}
            {scan.orphans.length > 0 && (
              <Card
                title="不在构建里"
                hint={`${scan.orphans.length} 个 · 磁盘上有，但 CMakeLists 没引用`}
                actions={
                  <div className="flex">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={checked.size === 0}
                      onClick={() => void openPreview([...checked], [])}
                    >
                      加入构建{checked.size ? `（${checked.size}）` : ''}
                    </Button>
                  </div>
                }
              >
                <div className="row mb-8">
                  <div className="grow">
                    <TextInput
                      placeholder="过滤文件名…"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => setChecked(new Set(orphans.map((p) => p)))}
                    disabled={orphans.length === 0}
                  >
                    全选
                  </Button>
                  <Button size="sm" onClick={() => setChecked(new Set())} disabled={!checked.size}>
                    清空
                  </Button>
                </div>
                <div className="list list__scroll" style={{ maxHeight: 260 }}>
                  {orphans.map((p) => (
                    <div key={p} className="list__row">
                      <Checkbox
                        checked={checked.has(p)}
                        onChange={(on) => {
                          const next = new Set(checked)
                          if (on) next.add(p)
                          else next.delete(p)
                          setChecked(next)
                        }}
                      />
                      <span className="mono grow">{p}</span>
                      <Button size="sm" onClick={() => void openPreview([p], [])}>
                        加入
                      </Button>
                    </div>
                  ))}
                  {orphans.length === 0 && <div className="faint small">没有匹配的文件</div>}
                </div>
              </Card>
            )}

            {/* ---- 构建里的 ---- */}
            <Card title="已在构建里" hint={`${inBuild.length} 个`}>
              <div className="row mb-8">
                <div className="grow">
                  <TextInput
                    placeholder="过滤文件名…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
              </div>
              <div className="list list__scroll" style={{ maxHeight: 320 }}>
                {shownInBuild.map((p) => (
                  <div key={p} className="list__row">
                    <span className="mono grow">{p}</span>
                    <Button size="sm" variant="ghost" onClick={() => void openPreview([], [p])}>
                      移出
                    </Button>
                  </div>
                ))}
                {shownInBuild.length === 0 && <EmptyState title="没有匹配的源文件" />}
              </div>
            </Card>

            {/* ---- 新建 ---- */}
            <Card title="新建源文件" hint="会落盘，但不会自动加进构建">
              <div className="row">
                <div className="grow">
                  <Field label="相对工程根的路径" hint="例如 application/oled_task.c">
                    <TextInput
                      mono
                      placeholder="application/new_task.c"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </Field>
                </div>
                <div style={{ width: 220 }}>
                  <Field label="类型">
                    <Select
                      value={newKind}
                      onChange={(e) => setNewKind(e.target.value as NewFileKind)}
                      options={NEW_FILE_KINDS}
                    />
                  </Field>
                </div>
                <div style={{ paddingTop: 18 }}>
                  <Button variant="primary" onClick={() => void createFile()}>
                    新建
                  </Button>
                </div>
              </div>
            </Card>

            {/* ---- 诊断 ---- */}
            {(scan.missing.length > 0 || scan.unresolved.length > 0 || scan.diagnostics.length > 0) && (
              <Card title="需要注意" hint="只读提示，不会自动修">
                {scan.missing.length > 0 && (
                  <Alert kind="warn">
                    有 {scan.missing.length} 个源文件写进了 CMakeLists，磁盘上却找不到
                    （多半是改名或删除后忘了同步）：
                    <div className="mono small mt-8">
                      {scan.missing.slice(0, 8).map((m) => (
                        <div key={m.relPath}>
                          第 {m.line} 行 · {m.relPath}
                        </div>
                      ))}
                      {scan.missing.length > 8 && <div>…还有 {scan.missing.length - 8} 个</div>}
                    </div>
                  </Alert>
                )}
                {scan.unresolved.length > 0 && (
                  <Alert kind="info">
                    有 {scan.unresolved.length} 行用了认不出的变量，只能看到写法、定位不到文件
                    （不猜，所以不给「移出」按钮）：
                    <div className="mono small mt-8">
                      {scan.unresolved.slice(0, 6).map((u) => (
                        <div key={`${u.line}-${u.raw}`}>
                          第 {u.line} 行 · {u.raw}
                        </div>
                      ))}
                    </div>
                  </Alert>
                )}
                {scan.diagnostics.map((d, i) => (
                  <div key={i} className="small faint">
                    · {d}
                  </div>
                ))}
              </Card>
            )}
          </>
        )}
      </PageBody>

      {/* ---- 差异预览 ---- */}
      {preview && (
        <Modal
          title="确认修改 CMakeLists.txt"
          width={1000}
          onClose={() => {
            setPreview(null)
            setPending(null)
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setPreview(null)
                  setPending(null)
                }}
              >
                取消
              </Button>
              <Button variant="primary" onClick={() => void confirmWrite()}>
                确认写入
              </Button>
            </>
          }
        >
          <Alert kind="info">
            只做<b>整行插入 / 删除</b>，你手写的其它内容一个字都不动。
            写入前会自动存快照，历史页里能一键还原。
            {preview.usedFallback && (
              <>
                <br />
                这次没找到能就地插入的列表，改动会放在文件末尾的托管区块里。
              </>
            )}
          </Alert>

          <div className="small" style={{ margin: '8px 0' }}>
            {preview.notes.map((n, i) => (
              <div key={i}>· {n}</div>
            ))}
          </div>

          <DiffView previous={preview.before} current={preview.after} />
        </Modal>
      )}
    </>
  )
}

export default SourcesPage
