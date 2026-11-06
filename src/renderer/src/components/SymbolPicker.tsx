/**
 * 信号目录 + 映射表。
 *
 * 这一块的界面只做三件事：
 *   ① 在工程变量树里找东西（搜索 / 过滤 / 展开）
 *   ② 点「加入」生成一条映射（只看 or 可调）
 *   ③ 手动绑定兜底（扫不到、局部变量、特殊类型）
 *
 * 至于 C 代码长什么样，交给生成层（vofa_bind.c），这里不碰文件。
 */

import React from 'react'
import { Button, Card, EmptyState, Field, Modal, Select, TextInput } from './ui'
import type {
  PackFeature,
  SymbolNode,
  SymbolScanResult,
  VofaBinding,
  VofaBindingAccess
} from '@shared/types'
import { bindingFromSymbol, sanitizeBindingName, uniqueBindingName } from '@shared/vofaMap'

type NotifyKind = 'ok' | 'warn' | 'err'
type Notify = (kind: NotifyKind, text: string) => void

type Filter = 'all' | 'watch' | 'tune'

/**
 * 每页显示多少行。
 *
 * 为什么默认 20：这个工程的变量树展开能到几百行，一屏塞不下，
 * 用户要的是「看得清、翻得动」，不是「滚到底」。
 * 最大 200 而不是「全部」：几千个节点一次性挂到 DOM 上会明显卡顿，
 * 真要扫全表就用搜索框收窄 —— 那比滚到底快。
 */
const PAGE_SIZES = [10, 20, 50, 100, 200] as const

/** 拍平后的可见行：树按当前展开状态展开，搜索结果是平铺的 */
interface Row {
  node: SymbolNode
  depth: number
}

function flattenVisible(
  nodes: SymbolNode[],
  expanded: Set<string>,
  depth = 0,
  out: Row[] = []
): Row[] {
  for (const n of nodes) {
    out.push({ node: n, depth })
    if (n.children?.length && expanded.has(n.id)) {
      flattenVisible(n.children, expanded, depth + 1, out)
    }
  }
  return out
}

interface ManualForm {
  name: string
  expr: string
  type: string
  access: VofaBindingAccess
  guard: string
  include: string
}

const MANUAL_TYPES: Array<{
  value: string
  label: string
  valueType: 'float' | 'int' | 'bool' | 'pid'
  canTune: boolean
  pid: boolean
}> = [
  { value: 'float', label: 'float（可看 / 可调）', valueType: 'float', canTune: true, pid: false },
  { value: 'int16_t', label: 'int16_t（只看）', valueType: 'int', canTune: false, pid: false },
  { value: 'uint8_t', label: 'uint8_t（只看）', valueType: 'int', canTune: false, pid: false },
  { value: 'bool', label: 'bool（只看）', valueType: 'bool', canTune: false, pid: false },
  {
    value: 'pid_type_def',
    label: 'pid_type_def（可调整组）',
    valueType: 'pid',
    canTune: true,
    pid: true
  },
  {
    value: 'gimbal_PID_t',
    label: 'gimbal_PID_t（可调整组）',
    valueType: 'pid',
    canTune: true,
    pid: true
  }
]

function emptyManual(): ManualForm {
  return { name: '', expr: '', type: 'float', access: 'watch', guard: '', include: '' }
}

function isBalanced(expr: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const stack: string[] = []
  for (const ch of expr) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch)
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return false
    }
  }
  return stack.length === 0
}

interface NodeRowProps {
  node: SymbolNode
  depth: number
  showPath: boolean
  expanded: Set<string>
  onToggle: (id: string) => void
  canWatch: boolean
  canTune: boolean
  bindings: VofaBinding[]
  onAdd: (node: SymbolNode, access: VofaBindingAccess) => void
}

function NodeRow(props: NodeRowProps): React.JSX.Element {
  const { node } = props
  const children = node.children ?? []
  const hasChildren = children.length > 0
  const open = props.expanded.has(node.id)
  const selectedWatch = props.bindings.some((b) => b.id === `${node.id}:watch`)
  const selectedTune = props.bindings.some((b) => b.id === `${node.id}:tune`)
  const watchOk = props.canWatch && (node.access === 'watch' || node.access === 'both')
  const tuneOk = props.canTune && (node.access === 'tune' || node.access === 'both')

  return (
    <div>
      <div className="sym-row" style={{ paddingLeft: 6 + props.depth * 16 }}>
        <span
          className="sym-toggle"
          onClick={() => hasChildren && props.onToggle(node.id)}
          title={hasChildren ? (open ? '折叠' : '展开') : undefined}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className="sym-name" title={`${node.expr}\n${node.reason ?? ''}`}>
          {props.showPath ? node.path : node.name}
        </span>
        <span className="sym-type">{node.type}</span>
        <span className="sym-meta">
          {node.file}:{node.line}
        </span>
        <span className="sym-actions">
          {watchOk && (
            <Button
              size="sm"
              variant={selectedWatch ? 'ghost' : 'default'}
              disabled={selectedWatch}
              onClick={() => props.onAdd(node, 'watch')}
            >
              {selectedWatch ? '已看' : '只看'}
            </Button>
          )}
          {tuneOk && (
            <Button
              size="sm"
              variant={selectedTune ? 'ghost' : 'default'}
              disabled={selectedTune}
              onClick={() => props.onAdd(node, 'tune')}
            >
              {selectedTune ? '已调' : '可调'}
            </Button>
          )}
          {node.access === 'none' && node.reason && (
            <span className="faint small" title={node.reason}>
              不可绑
            </span>
          )}
        </span>
      </div>
      {open &&
        children.map((c) => (
          <NodeRow
            key={c.id}
            node={c}
            depth={props.depth + 1}
            showPath={false}
            expanded={props.expanded}
            onToggle={props.onToggle}
            canWatch={props.canWatch}
            canTune={props.canTune}
            bindings={props.bindings}
            onAdd={props.onAdd}
          />
        ))}
    </div>
  )
}

export function SymbolPicker(props: {
  symbols: SymbolScanResult | null
  bindings: VofaBinding[]
  features: PackFeature[]
  onChange: (bindings: VofaBinding[]) => void
  onNotify?: Notify
  onSaveMap?: () => void
}): React.JSX.Element {
  const notify: Notify = props.onNotify ?? (() => undefined)
  const canWatch = props.features.includes('waveform')
  const canTune = props.features.includes('onlineTuning')

  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<Filter>('all')
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  /** 每页行数，0 = 全部 */
  const [pageSize, setPageSize] = React.useState(20)
  const [page, setPage] = React.useState(0)
  const [manualOpen, setManualOpen] = React.useState(false)
  const [manual, setManual] = React.useState<ManualForm>(emptyManual())

  React.useEffect(() => {
    setExpanded(new Set((props.symbols?.tree ?? []).map((n) => n.id)))
  }, [props.symbols])

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const matchesFilter = (n: SymbolNode): boolean =>
    filter === 'all' || n.access === 'both' || n.access === filter

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const results = React.useMemo(() => {
    if (!props.symbols || !terms.length) return []
    // 这里不再 slice(0, 200)：截断会让「一共多少条」这件事变得不可信，
    // 而且第 201 条之后的变量永远翻不到。分页接管了「一次渲染多少」。
    return props.symbols.flat.filter((n) => {
      if (!matchesFilter(n)) return false
      const hay = `${n.path} ${n.name} ${n.type} ${n.file}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.symbols, query, filter])

  /**
   * 当前要展示的行（还没分页）。
   *
   * 搜索时是一条条平铺的结果；没搜索时是**按展开状态拍平的树** ——
   * 树必须拍平才能分页：直接对顶层节点分页的话，一页里某个节点展开后
   * 会把自己的子节点挤到下一页去，父子就分家了。
   */
  const allRows = React.useMemo<Row[]>(() => {
    if (!props.symbols) return []
    if (terms.length) return results.map((node) => ({ node, depth: 0 }))
    return flattenVisible(props.symbols.tree, expanded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.symbols, terms.length, results, expanded])

  const pageCount = Math.max(1, Math.ceil(allRows.length / pageSize))
  // 展开/收起之后总页数会变，用 clamp 过的页码取值，别让用户停在一个空页上
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = allRows.slice(safePage * pageSize, safePage * pageSize + pageSize)

  // 换了搜索词、筛选条件或每页行数，一律回到第 1 页 —— 停在原页码上
  // 多半会看到一片空白，用户会以为「搜不到」
  React.useEffect(() => {
    setPage(0)
  }, [query, filter, pageSize])

  const add = (node: SymbolNode, access: VofaBindingAccess): void => {
    if (node.access === 'none') {
      notify('warn', node.reason ?? '这个值不能直接绑定')
      return
    }
    if (access === 'tune' && node.valueType !== 'float' && node.valueType !== 'pid') {
      notify('warn', '只有 float 或 PID 组能在线改；其它类型先「只看」')
      return
    }
    if (props.bindings.some((b) => b.id === `${node.id}:${access}`)) {
      notify('warn', '已经加过了')
      return
    }
    const b = bindingFromSymbol(node, access, props.bindings)
    props.onChange([...props.bindings, b])
  }

  const remove = (id: string): void => {
    props.onChange(props.bindings.filter((b) => b.id !== id))
  }

  const rename = (id: string, name: string): void => {
    props.onChange(props.bindings.map((b) => (b.id === id ? { ...b, name } : b)))
  }

  const addManual = (): void => {
    const name = manual.name.trim()
    const expr = manual.expr.trim()
    if (!name) {
      notify('warn', '名字不能为空')
      return
    }
    if (!expr) {
      notify('warn', '表达式不能为空')
      return
    }
    if (!isBalanced(expr)) {
      notify('warn', '表达式括号不配对，先检查一下')
      return
    }
    const mt = MANUAL_TYPES.find((t) => t.value === manual.type) ?? MANUAL_TYPES[0]
    const access: VofaBindingAccess = manual.access === 'tune' && mt.canTune ? 'tune' : 'watch'
    if (access === 'tune' && !canTune) {
      notify('warn', '这个模块不支持在线调参')
      return
    }
    const b: VofaBinding = {
      id: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      name: uniqueBindingName(name, props.bindings),
      expr,
      type: manual.type,
      valueType: mt.valueType,
      access,
      guard: manual.guard.trim() || undefined,
      include: manual.include.trim() || undefined,
      source: 'manual',
      pidType: mt.pid ? (manual.type as 'pid_type_def' | 'gimbal_PID_t') : undefined,
      fields: mt.pid ? ['Kp', 'Ki', 'Kd', 'max_out', 'max_iout'] : undefined
    }
    props.onChange([...props.bindings, b])
    setManualOpen(false)
    setManual(emptyManual())
    notify('ok', `已加入 ${b.name}`)
  }

  const symbols = props.symbols
  const empty = !symbols || symbols.tree.length === 0

  return (
    <>
      <Card
        title="信号目录"
        hint="从工程里选变量；扫不到就用「手动绑定」"
        actions={
          <div className="flex">
            <Button size="sm" onClick={() => setManualOpen(true)}>
              + 手动绑定
            </Button>
            {props.bindings.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => props.onChange([])}>
                清空
              </Button>
            )}
          </div>
        }
      >
        <div className="row mb-12">
          <div className="grow">
            <TextInput
              mono
              placeholder="搜索变量 / 成员 / 文件，例如：yaw kp"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div style={{ width: 150 }}>
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
              options={[
                { value: 'all', label: '全部' },
                { value: 'watch', label: '只看' },
                { value: 'tune', label: '可调' }
              ]}
            />
          </div>
          <div style={{ width: 120 }}>
            <Select
              value={String(pageSize)}
              onChange={(e) => setPageSize(Number(e.target.value))}
              options={PAGE_SIZES.map((n) => ({ value: String(n), label: `每页 ${n} 行` }))}
            />
          </div>
        </div>

        {!symbols ? (
          <div className="faint small">正在扫描工程里的变量…</div>
        ) : empty ? (
          <EmptyState title="没扫到可绑定的全局变量">
            扫描认两种东西：头文件里的 <span className="mono">extern</span> 声明，以及 .c
            里文件作用域的变量定义（这两种都不需要你改代码）。
            函数局部变量、<span className="mono">static</span> 变量扫得到但绑不了 ——
            原因见下面两个折叠区。实在不行还有「+ 手动绑定」。
          </EmptyState>
        ) : allRows.length === 0 ? (
          <div className="faint small">没有匹配的变量。换个关键词，或者手动绑定。</div>
        ) : (
          <>
            <div className="list list__scroll" style={{ maxHeight: 420 }}>
              {pageRows.map(({ node, depth }) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  depth={depth}
                  showPath={terms.length > 0}
                  expanded={expanded}
                  onToggle={toggle}
                  canWatch={canWatch}
                  canTune={canTune}
                  bindings={props.bindings}
                  onAdd={add}
                />
              ))}
            </div>

            {/*
              分页条固定放在列表下面：列表本身还是可滚的（每页 100/200 行时
              一屏放不下），但「我在第几页、一共多少」不用滚到底才看得见。
              只有一页时整条不显示 —— 没得翻的时候画一排灰按钮只是噪音。
            */}
            {pageCount > 1 && (
              <div className="row mt-8" style={{ alignItems: 'center' }}>
                <span className="faint small">
                  共 {allRows.length} {terms.length ? '个匹配' : '个变量'} · 第{' '}
                  {safePage + 1} / {pageCount} 页
                </span>
                <span className="spacer" />
                <Button size="sm" onClick={() => setPage(0)} disabled={safePage === 0}>
                  « 首页
                </Button>
                <Button size="sm" onClick={() => setPage(safePage - 1)} disabled={safePage === 0}>
                  ‹ 上一页
                </Button>
                <Button
                  size="sm"
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= pageCount - 1}
                >
                  下一页 ›
                </Button>
                <Button
                  size="sm"
                  onClick={() => setPage(pageCount - 1)}
                  disabled={safePage >= pageCount - 1}
                >
                  末页 »
                </Button>
              </div>
            )}
          </>
        )}

        {symbols?.truncated && (
          <div className="faint small" style={{ marginTop: 8 }}>
            变量太多，已截断到前 5000 个节点。用搜索框找具体名字更稳。
          </div>
        )}

        {symbols && (symbols.statics?.length ?? 0) > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="small faint">
              文件私有变量 static（{symbols.statics.length} 个，不可绑定）
            </summary>
            <div className="small faint" style={{ marginTop: 6 }}>
              <div style={{ marginBottom: 4 }}>
                这些变量在你工程里是 <span className="mono">static</span>
                ，链接后是文件内局部符号 —— 生成的 <span className="mono">vofa_bind.c</span>
                在另一个编译单元里，<b>取不到它们的地址</b>。这不是工具的偏好，是 C 语言的
                translation unit 隔离。
                <br />
                要用：删掉 <span className="mono">static</span>
                ，再在对应头文件里加一行 <span className="mono">extern</span> 声明
                （两行都不用改逻辑，改完回这里重新扫描就会出现在上面）。
              </div>
              {symbols.statics.slice(0, 20).map((n) => (
                <div key={n.id} className="mono">
                  · {n.name}（{n.type}，{n.file}:{n.line}）
                </div>
              ))}
              {symbols.statics.length > 20 ? <div>…</div> : null}
            </div>
          </details>
        )}

        {symbols && symbols.locals.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="small faint">
              函数内变量（{symbols.locals.length} 个，不可直接绑定）
            </summary>
            <div className="small faint" style={{ marginTop: 6 }}>
              {symbols.locals.slice(0, 20).map((n) => (
                <div key={n.id} className="mono">
                  · {n.name}（{n.type}，{n.file}:{n.line}）
                </div>
              ))}
              {symbols.locals.length > 20 ? <div>…</div> : null}
              <div style={{ marginTop: 4 }}>
                这些是函数里的局部变量，生命周期不允许注册指针。把它们改成全局、加 getter，或者用
                vofa_user_bind.c 钩子。
              </div>
            </div>
          </details>
        )}
      </Card>

      <Card
        title="已选（映射表）"
        hint={`${props.bindings.length} 项 · 存 application/vofa/vofa_map.json`}
        actions={
          props.onSaveMap ? (
            <Button size="sm" onClick={props.onSaveMap}>
              保存映射表
            </Button>
          ) : undefined
        }
      >
        {props.bindings.length === 0 ? (
          <div className="faint small">
            还没选。上面的「只看」「可调」点一下就会出现在这里，生成时只改 vofa_bind.c。
          </div>
        ) : (
          <div className="list">
            {props.bindings.map((b) => (
              <div className="list__row" key={b.id}>
                <div style={{ width: 170 }}>
                  <TextInput
                    mono
                    value={b.name}
                    onChange={(e) => rename(b.id, e.target.value)}
                    onBlur={() => rename(b.id, sanitizeBindingName(b.name))}
                  />
                </div>
                <div className="grow">
                  <div className="mono small" title={b.expr}>
                    {b.expr}
                  </div>
                  <div className="faint small">
                    {b.access === 'watch' ? '只看' : '可调'} · {b.type}
                    {b.pidType ? `（整组 ${(b.fields ?? []).join('/')}）` : ''}
                    {b.source === 'manual' ? ' · 手动' : ''}
                    {b.valueType !== 'float' && b.access === 'watch' ? ' · 自动镜像' : ''}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => remove(b.id)}>
                  移除
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {manualOpen && (
        <Modal
          title="手动绑定一个值"
          width={720}
          onClose={() => setManualOpen(false)}
          footer={
            <>
              <Button onClick={() => setManualOpen(false)}>取消</Button>
              <Button variant="primary" onClick={addManual}>
                加入
              </Button>
            </>
          }
        >
          <div className="small faint mb-12">
            扫不到的变量、`static` 变量、局部变量、宏拼出来的类型，都可以在这里直接写表达式。
            表达式必须是在 vofa_bind.c 里能编译通过的 C 代码。
          </div>
          <div className="grid grid--2">
            <Field label="显示名（VOFA 命令里用）" hint="只能字母/数字/下划线，空格会换成 _">
              <TextInput
                mono
                value={manual.name}
                onChange={(e) => setManual((m) => ({ ...m, name: e.target.value }))}
                placeholder="yaw_kp"
              />
            </Field>
            <Field label="类型">
              <Select
                value={manual.type}
                onChange={(e) =>
                  setManual((m) => ({
                    ...m,
                    type: e.target.value,
                    access:
                      m.access === 'tune' &&
                      !(MANUAL_TYPES.find((t) => t.value === e.target.value)?.canTune ?? false)
                        ? 'watch'
                        : m.access
                  }))
                }
                options={MANUAL_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              />
            </Field>
          </div>
          <Field label="表达式" hint="例如 get_yaw_motor_point()->gyro_pid.Kp 或 chassis.vx">
            <TextInput
              mono
              value={manual.expr}
              onChange={(e) => setManual((m) => ({ ...m, expr: e.target.value }))}
              placeholder="get_yaw_motor_point()->gyro_pid.Kp"
            />
          </Field>
          <div className="grid grid--2">
            <Field label="权限">
              <Select
                value={manual.access}
                onChange={(e) =>
                  setManual((m) => ({ ...m, access: e.target.value as VofaBindingAccess }))
                }
                options={[
                  { value: 'watch', label: '只看（画波形）' },
                  {
                    value: 'tune',
                    label: '可调（在线改）',
                    disabled:
                      !canTune || !(MANUAL_TYPES.find((t) => t.value === manual.type)?.canTune ?? false)
                  }
                ]}
              />
            </Field>
            <Field label="判空表达式（可空）" hint="例如 get_yaw_motor_point()">
              <TextInput
                mono
                value={manual.guard}
                onChange={(e) => setManual((m) => ({ ...m, guard: e.target.value }))}
                placeholder="get_yaw_motor_point()"
              />
            </Field>
          </div>
          <Field label="include 头文件（可空）" hint="表达式里的符号声明在哪个头文件">
            <TextInput
              mono
              value={manual.include}
              onChange={(e) => setManual((m) => ({ ...m, include: e.target.value }))}
              placeholder="application/gimbal_task.h"
            />
          </Field>
        </Modal>
      )}
    </>
  )
}
