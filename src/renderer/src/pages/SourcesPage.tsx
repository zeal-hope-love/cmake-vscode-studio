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
  /** 清理 Keil/IAR 残留的确认弹窗（操作是「移到回收站」，可还） */
  const [trashOpen, setTrashOpen] = React.useState(false)
  const [target, setTarget] = React.useState('')
  const [checked, setChecked] = React.useState<Set<string>>(new Set())
  const [preview, setPreview] = React.useState<CmakeChangePreview | null>(null)
  const [pending, setPending] = React.useState<{ add: string[]; remove: string[] } | null>(null)
  const [filter, setFilter] = React.useState('')
  const [newName, setNewName] = React.useState('')
  const [newKind, setNewKind] = React.useState<NewFileKind>('c')
  const [newDir, setNewDir] = React.useState('.')
  /** 上一次的工程指纹，用来判断「外面是不是有人动了文件」 */
  const sigRef = React.useRef('')
  const prevOrphans = React.useRef<number | null>(null)

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

  /**
   * 自动识别外面新建的文件。
   *
   * 你在 VSCode 里新建一个 .c，这里**不需要点任何按钮**就能出现在「不在构建里」。
   * 每 2 秒问一次主进程「工程变了没」—— 那是个只 stat 目录和 CMakeLists 的轻量指纹，
   * 比全量扫描便宜得多；指纹真的变了才去重新解析。
   * 窗口重新获得焦点时也立刻查一次（从编辑器切回来是最常见的时机）。
   */
  React.useEffect(() => {
    if (!projectRoot) return
    let stopped = false

    const tick = async (): Promise<void> => {
      try {
        const s = await window.api.cmakeSignature(projectRoot)
        const key = `${s.dirCount}|${s.dirMtimeMax}|${s.cmakeMtimeMax}|${s.compilableCount}`
        if (!sigRef.current) {
          sigRef.current = key
          return
        }
        if (sigRef.current !== key) {
          sigRef.current = key
          await reload()
        }
      } catch {
        /* 工程被删/权限问题时忽略，下一轮再试 */
      }
    }

    const timer = window.setInterval(() => {
      if (!stopped) void tick()
    }, 2000)
    const onFocus = (): void => {
      void tick()
    }
    window.addEventListener('focus', onFocus)
    void tick()

    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectRoot, reload])

  /** 新冒出来的「没进构建」文件主动提醒一次，不用自己去盯列表 */
  React.useEffect(() => {
    if (!scan) return
    const n = scan.orphans.length
    if (prevOrphans.current !== null && n > prevOrphans.current) {
      notify('warn', `检测到 ${n - prevOrphans.current} 个新文件还没进构建，勾一下「加入构建」就行`)
    }
    prevOrphans.current = n
  }, [scan, notify])

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
      // 目录从下拉选，这里拼成相对工程根的路径
      const full = newDir === '.' ? name : newDir + '/' + name
      const r = await window.api.cmakeCreateFile(projectRoot, full, newKind)
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
            {/*
              解析没看全时必须拦住「加入构建」。
              只看根 CMakeLists.txt 会漏掉 include()/add_subdirectory() 里的源文件，
              把本来就在构建里的报成遗漏；照着加会重复编译、链接报 multiple definition。
              宁可说「我看不全」，也不能给一份看起来确定的错清单。
            */}
            {scan.stats.cmakeUnresolved.length > 0 && (
              <Alert kind="warn">
                <div className="bold mb-8">
                  这个 CMake 工程的构建定义我<b>没看全</b>，下面的「不在构建里」可能不准，已先禁用加入。
                </div>
                {scan.stats.cmakeUnresolved.slice(0, 6).map((u, i) => (
                  <div key={i} className="small mono">
                    · {u}
                  </div>
                ))}
                {scan.stats.cmakeUnresolved.length > 6 && (
                  <div className="small faint">…还有 {scan.stats.cmakeUnresolved.length - 6} 条</div>
                )}
                <div className="small" style={{ marginTop: 6 }}>
                  已经读了：<span className="mono">{scan.stats.cmakeParsedFiles.join('、')}</span>
                </div>
              </Alert>
            )}

            {scan.stats.cmakeListsCount > 1 && (
              <Alert kind="info">
                <div className="bold mb-8">
                  这个工程有 {scan.stats.cmakeListsCount} 个 CMakeLists.txt，但它是<b>一个</b>
                  构建，不是多个
                </div>
                CMake 的规矩是<b>每个目录一个 CMakeLists.txt</b>，由根文件用{' '}
                <span className="mono">add_subdirectory()</span> /{' '}
                <span className="mono">include()</span> 串起来 —— 它们合起来描述同一个构建。
                <div className="mt-8">
                  <b>构建入口永远是根部这个</b>
                  <span className="mono"> {scan.buildEntry}</span>（
                  <span className="mono">cmake -S 工程根</span> 就是从它开始读），
                  <b>不能选</b> —— 换入口就等于换工程。
                </div>
                <div className="mt-8">
                  能选的是<b>构建哪个目标</b>（
                  <span className="mono">cmake --build build --target 名字</span>）。 这个工程一共{' '}
                  {scan.allTargets.length} 个目标：
                </div>
                <div style={{ marginTop: 6 }}>
                  {scan.allTargets.map((t) => (
                    <div key={`${t.file}:${t.name}`} className="small">
                      <span className="mono">{t.name}</span>
                      <span className="faint">
                        {' '}
                        · {t.isExecutable ? '可执行文件' : t.kind === 'custom' ? '接口库' : '库'} ·{' '}
                        {t.sourceCount} 个源文件 · 声明于{' '}
                      </span>
                      <span className="mono faint">{t.file}</span>
                    </div>
                  ))}
                </div>
                <div className="faint small" style={{ marginTop: 6 }}>
                  本页只能改<b>根文件里</b>那个目标（下面下拉框里的），其它目标在子文件 / 生成文件里，
                  改它们会被 CubeMX 重新生成覆盖。
                  <br />
                  可编译文件共 {scan.stats.compilableOnDisk} 个，其中 {scan.stats.headersOnDisk}{' '}
                  个头文件 本来就不需要写进 CMakeLists。
                </div>
              </Alert>
            )}

            {/*
              残留和「漏加」必须分开显示：处理方式相反（删掉 vs 补进构建）。
              混在一起，用户很容易把 Keil 时代的 MDK-ARM/delay.c 当成漏加的文件加进构建。
            */}
            {scan.leftovers.length > 0 && (
              <Alert kind="warn">
                <div className="bold mb-8">
                  发现 {scan.leftovers.length} 个疑似「别的构建系统留下的残留」
                </div>
                <div className="small">
                  它们确实不在 CMake 构建里，但<b>不是漏加</b> —— 是 Keil/IAR 时代的东西，
                  加进构建只会引入一份和现在无关的旧代码，正常做法是删掉。
                </div>
                <div style={{ marginTop: 6 }}>
                  {scan.leftovers.map((l) => (
                    <div key={l.relPath} className="small">
                      <span className="mono">{l.relPath}</span>
                      <span className="faint">
                        {' '}
                        · {l.system} · {l.reason}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <Button size="sm" onClick={() => setTrashOpen(true)}>
                    清理这些残留（{scan.leftovers.length} 个）
                  </Button>
                  <span className="faint small" style={{ alignSelf: 'center' }}>
                    会移到<b>回收站</b>，不是直接删 —— 判断错了还能捞回来
                  </span>
                </div>
                <div className="faint small" style={{ marginTop: 6 }}>
                  这些文件已从上面的「不在构建里」里剔出去，免得和真正漏加的文件混在一起。
                </div>
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
                      disabled={checked.size === 0 || scan.stats.cmakeUnresolved.length > 0}
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
            <Card title="新建源文件" hint="目录从下拉里选，不用手打路径">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div style={{ width: 300 }}>
                  <Field label="放到哪个目录" hint="工程里已有的目录">
                    <Select
                      value={newDir}
                      onChange={(e) => setNewDir(e.target.value)}
                      options={scan.dirs.map((d) => ({
                        value: d,
                        label: d === '.' ? '（工程根目录）' : `${d}/`
                      }))}
                    />
                  </Field>
                </div>
                <div className="grow">
                  <Field label="文件名" hint="带扩展名，例如 oled_task.c">
                    <TextInput
                      mono
                      placeholder="oled_task.c"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </Field>
                </div>
                <div style={{ width: 220 }}>
                  <Field label="类型" hint="决定骨架里生成什么">
                    <Select
                      value={newKind}
                      onChange={(e) => setNewKind(e.target.value as NewFileKind)}
                      options={NEW_FILE_KINDS}
                    />
                  </Field>
                </div>
                <Field label={'\u00a0'}>
                  <Button variant="primary" onClick={() => void createFile()}>
                    新建
                  </Button>
                </Field>
              </div>
              {newName.trim() && (
                <div className="faint small" style={{ marginTop: 6 }}>
                  会创建{' '}
                  <span className="mono">
                    {newDir === '.' ? newName.trim() : `${newDir}/${newName.trim()}`}
                  </span>
                  ，建完自动出现在上面的「不在构建里」，勾一下就能加进构建。
                </div>
              )}
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

      {/* ---- 清理残留（移到回收站，可还） ---- */}
      {trashOpen && scan && (
        <Modal
          title="把这些残留移到回收站？"
          width={720}
          onClose={() => setTrashOpen(false)}
          footer={
            <>
              <Button onClick={() => setTrashOpen(false)}>取消</Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    setBusy(true)
                    try {
                      const r = await window.api.cmakeTrashFiles(
                        projectRoot,
                        scan.leftovers.map((l) => l.relPath)
                      )
                      if (!r.ok) {
                        notify('err', r.errors.join('；') || '清理失败')
                        return
                      }
                      notify('ok', `已把 ${r.trashed.length} 个文件移到回收站`)
                      setTrashOpen(false)
                      await refreshHistory()
                      await reload()
                    } finally {
                      setBusy(false)
                    }
                  })()
                }}
              >
                {busy ? '处理中…' : '移到回收站'}
              </Button>
            </>
          }
        >
          <Alert kind="info">
            走的是<b>回收站</b>，不是永久删除 —— 到 Windows 回收站里可以还原。操作前照样会存快照。
          </Alert>
          <div className="small" style={{ marginTop: 8 }}>
            {scan.leftovers.map((l) => (
              <div key={l.relPath} className="mono">
                · {l.relPath}
              </div>
            ))}
          </div>
        </Modal>
      )}

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
