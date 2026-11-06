/**
 * 地址表 —— 「不用改源码就随便看随便改」的那块界面。
 *
 * 和上面的「信号目录」是两条路，解决的问题不一样：
 *   · 信号目录（源码级）：勾变量 → 生成 `&(变量)` 编进固件。能看结构体成员，
 *     但要重新生成 + 重编 + 重烧，而且 static 拿不到地址。
 *   · 地址表（地址级，就是这一块）：从 .elf 符号表读地址，直接下发 `am` 命令。
 *     换变量只在这里点一下，源码一行不动、不用重编，static 也能看。
 *
 * 界面上刻意把「ch0 对应谁」写出来：用户在这边看到的是变量名，VOFA+ 那边看到的是
 * ch0/ch1，这层对应关系没有任何地方会替他记住，不写就是靠猜。
 */

import React from 'react'
import {
  ADDR_SLOT_MAX,
  MEM_KINDS,
  MEM_KIND_LABEL,
  buildReadCommand,
  buildSlotCommands,
  buildWriteCommand,
  hexAddr,
  slotLegend,
  type AddrSlot,
  type ElfVar,
  type ElfVarsResult,
  type MemKind
} from '@shared/addrTable'
import { Alert, Button, Card, Select, TextArea, TextInput } from './ui'

export function AddrTablePanel(props: {
  projectRoot: string
  onNotify: (kind: 'ok' | 'warn' | 'err', text: string) => void
}): React.JSX.Element {
  const { projectRoot, onNotify } = props
  const [result, setResult] = React.useState<ElfVarsResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [query, setQuery] = React.useState('')
  /**
   * 槽位顺序就是波形顺序 —— 用数组而不是 Set，因为顺序有语义。
   * 保存成 `{name, addr, kind}` 而不是引用 ElfVar：重新读 elf 之后地址会变，
   * 但槽位该在还在，用户能立刻看出「地址变了」而不是整表被清空。
   */
  const [slots, setSlots] = React.useState<AddrSlot[]>([])
  /** 生成过的命令串。空的时候不显示复制框，避免误以为已经下发 */
  const [commands, setCommands] = React.useState<string | null>(null)

  /**
   * 只对「已经读完这个工程」之后的改动做自动保存。
   *
   * 存的是工程路径而不是布尔值：切工程时旧工程的 slots 还在 state 里，
   * 用布尔值的话那一下会把旧工程的表写进新工程。
   */
  const loadedForRef = React.useRef<string | null>(null)
  /** onNotify 通常是父组件内联箭头函数，用 ref 拿最新的，免得每次渲染都触发保存 */
  const notifyRef = React.useRef(onNotify)
  React.useEffect(() => {
    notifyRef.current = onNotify
  }, [onNotify])

  // 切换工程：先把上一个工程的残留清掉，否则会短暂显示别的工程的变量
  React.useEffect(() => {
    loadedForRef.current = null
    setSlots([])
    setCommands(null)
    setResult(null)
  }, [projectRoot])

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      // 两件事一起取：elf 给地址，存表给「上次挑了谁」
      const [r, saved] = await Promise.all([
        window.api.vofaElfVars(projectRoot),
        window.api.vofaAddrLoad(projectRoot)
      ])
      setResult(r)
      if (r.error) onNotify('warn', r.error)

      /*
        存的槽位以**名字**为准，地址一律换成这次 elf 里的。
        地址每次重编都可能变，名字不会 —— 用旧地址去读新固件是静默错误，
        所以只要 elf 里有同名符号就覆盖，find 不到的原样留着（界面上会报警）。
      */
      setSlots(
        saved.slots.map((s) => {
          const hit = r.symbols.find((x) => x.name === s.name)
          return hit ? { ...s, addr: hit.addr } : s
        })
      )
      loadedForRef.current = projectRoot
    } catch (err) {
      onNotify('err', `读 ELF 失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [projectRoot, onNotify])

  React.useEffect(() => {
    void load()
  }, [load])

  /*
    改动即存：勾选是「这个工程想盯哪几个量」的决定，不该只活在这次会话里。
    300ms 去抖 —— 连续点上下箭头调顺序时不至于每一下都写一次盘。
  */
  React.useEffect(() => {
    if (loadedForRef.current !== projectRoot) return
    const timer = window.setTimeout(() => {
      void window.api.vofaAddrSave(projectRoot, slots).then((r) => {
        if (!r.ok) notifyRef.current('err', `地址表没存上：${r.error ?? '未知原因'}`)
      })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [slots, projectRoot])

  const symbols = result?.symbols ?? []
  /** 已选变量的名字，用来在候选列表里打勾 */
  const picked = new Set(slots.map((s) => s.name))

  /*
    存表里的名字在当前 .elf 里找不到 —— 通常是变量改名/删掉了，或者换了分支重编。
    这种槽必须显式说出来：它的地址还停在上次读到的位置，静默按那个地址读，
    读到的是内存里别人的值，而且不会报错。
  */
  const missing = React.useMemo(() => {
    if (!result) return [] as string[]
    const names = new Set(result.symbols.map((s) => s.name))
    return slots.filter((s) => !names.has(s.name)).map((s) => s.name)
  }, [result, slots])

  const q = query.trim().toLowerCase()
  const shown = (q ? symbols.filter((s) => s.name.toLowerCase().includes(q)) : symbols)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  const toggle = (v: ElfVar): void => {
    setSlots((prev) => {
      const i = prev.findIndex((s) => s.name === v.name)
      if (i >= 0) return prev.filter((_, k) => k !== i)
      if (prev.length >= ADDR_SLOT_MAX) {
        onNotify('warn', `一张表最多 ${ADDR_SLOT_MAX} 路 —— 固件里槽位是定长的，再多会拖慢发送`)
        return prev
      }
      return [...prev, { name: v.name, addr: v.addr, kind: v.kind }]
    })
    setCommands(null)
  }

  const remove = (name: string): void => {
    setSlots((prev) => prev.filter((s) => s.name !== name))
    setCommands(null)
  }

  const setKind = (name: string, kind: MemKind): void => {
    setSlots((prev) => prev.map((s) => (s.name === name ? { ...s, kind } : s)))
    setCommands(null)
  }

  const move = (i: number, d: -1 | 1): void => {
    setSlots((prev) => {
      const j = i + d
      if (j < 0 || j >= prev.length) return prev
      const next = prev.slice()
      const t = next[i]
      next[i] = next[j]
      next[j] = t
      return next
    })
    setCommands(null)
  }

  const copy = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => onNotify('ok', `已复制${what}`),
      () => onNotify('err', '复制失败，请手动选中复制')
    )
  }

  return (
    <Card
      title="地址表（不改源码 · 不用重编）"
      hint={
        result?.elfPath
          ? `${result.elfPath} · ${new Date(result.mtimeMs ?? 0).toLocaleString()} · ${symbols.length} 个变量`
          : '从编译产物的符号表里取地址'
      }
      actions={
        <Button onClick={() => void load()} disabled={loading}>
          {loading ? '读取中…' : result ? '重新读取' : '读 ELF'}
        </Button>
      }
    >
      <Alert kind="info">
        <div>
          勾一个变量 → 生成一串 <code className="mono">am</code> 命令 → 粘到 VOFA+ 的命令框发一次，
          波形里就有它了。<b>工程源码一行都不用改，也不用重新编译烧录。</b>
        </div>
        <div className="faint small mt-8">
          原理：固件按 <b>地址</b> 读内存，地址来自这份 .elf 的符号表（static 变量也有地址）。
          所以 —— <b>改了代码重新烧录后，要在这里点一次「重新读取」</b>，
          否则读到的是别的变量，而且不会报错。
        </div>
        <div className="faint small mt-8">
          勾选会自动存到 <code className="mono">application/vofa/vofa_addr.json</code>，
          跟着工程走，可以提交到 git 和队友共享。
        </div>
      </Alert>

      {missing.length > 0 && (
        <Alert kind="warn">
          这些变量在当前 .elf 里找不到了：<b>{missing.join('、')}</b>
          。槽位还留着上次的地址 —— 要么变量改名/删了，要么读的不是最新那份 elf。
          按现在这个地址读回来的可能是别的变量的值，<b>先点「重新读取」，确认后还是找不到就移除</b>。
        </Alert>
      )}

      {result?.error && symbols.length === 0 && <Alert kind="warn">{result.error}</Alert>}

      {/* ---- 已选槽位：顺序 = ch0、ch1… ---- */}
      {slots.length > 0 && (
        <div className="mt-12">
          <div className="flex">
            <div className="bold small">已选 {slots.length} / {ADDR_SLOT_MAX}（顺序就是 VOFA+ 里的通道顺序）</div>
            <div className="spacer" />
            <div className="flex">
              <Button onClick={() => { setSlots([]); setCommands(null) }}>清空</Button>
              <Button variant="primary" onClick={() => setCommands(buildSlotCommands(slots))}>
                生成命令
              </Button>
            </div>
          </div>

          {slots.map((s, i) => (
            <div key={s.name} className="row mt-8" style={{ alignItems: 'center', gap: 8 }}>
              <span className="mono bold" style={{ width: 44 }}>
                ch{i}
              </span>
              <span className="mono" style={{ flex: 1 }}>
                {s.name}
              </span>
              {missing.includes(s.name) && <span className="badge badge--warn">elf 里没了</span>}
              <span className="faint mono small">{hexAddr(s.addr)}</span>
              <Select
                value={s.kind}
                onChange={(e) => setKind(s.name, e.target.value as MemKind)}
                options={MEM_KINDS.map((k) => ({ value: k, label: MEM_KIND_LABEL[k] }))}
              />
              <Button onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </Button>
              <Button onClick={() => move(i, 1)} disabled={i === slots.length - 1}>
                ↓
              </Button>
              <Button onClick={() => remove(s.name)}>移除</Button>
            </div>
          ))}
        </div>
      )}

      {/* ---- 生成的命令 ---- */}
      {commands && (
        <div className="mt-12">
          <div className="flex">
            <div className="bold small">把这串发一次（VOFA+ 命令框里整行发送）</div>
            <div className="spacer" />
            <Button onClick={() => copy(commands, '地址表命令')}>复制</Button>
          </div>
          <TextArea value={commands} readOnly rows={3} />
          <div className="faint small mt-8">
            通道对应：{slotLegend(slots).join(' · ')}
          </div>

          {/*
            单点读写单独列一份：改一个值不该逼用户去拼命令。
            rd/wr 和上面的 am 是两件事 —— am 决定「波形里发什么」，
            rd/wr 是「现在这一刻读/写一次」，不用配槽也能用。
          */}
          <div className="bold small mt-12">单点读写（改某个值就发这一条）</div>
          {slots.map((s) => (
            <div key={s.name} className="row mt-8" style={{ alignItems: 'center', gap: 8 }}>
              <span className="mono small" style={{ width: 150 }}>
                {s.name}
              </span>
              <span className="faint mono small" style={{ flex: 1 }}>
                {buildReadCommand(s)}
              </span>
              <Button onClick={() => copy(buildReadCommand(s), `读 ${s.name}`)}>复制读</Button>
              <Button onClick={() => copy(buildWriteCommand(s, '0'), `写 ${s.name} 的模板`)}>
                复制写模板
              </Button>
            </div>
          ))}
          <div className="faint small mt-8">
            写模板最后那个 <code className="mono">0</code> 换成要写的值再发 —— 立即生效，断电不保存。
          </div>
        </div>
      )}

      {/* ---- 候选列表 ---- */}
      <div className="mt-12">
        <div className="flex" style={{ alignItems: 'center' }}>
          <TextInput
            placeholder="搜索变量名（支持部分匹配，例如 speed / gyro / pid）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>

        <div className="mt-8" style={{ maxHeight: 300, overflowY: 'auto' }}>
          {symbols.length === 0 && !result?.error && (
            <div className="faint small">没有可选的变量。这个工程里没有落在 RAM 的全局变量？</div>
          )}
          {shown.map((v) => {
            const on = picked.has(v.name)
            return (
              <label
                key={`${v.addr}:${v.name}`}
                className="row small"
                style={{ alignItems: 'center', gap: 8, padding: '2px 0', cursor: 'pointer' }}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(v)} />
                <span className="mono" style={{ flex: 1 }}>
                  {v.name}
                </span>
                <span className="faint mono small">{hexAddr(v.addr)}</span>
                <span className="faint small" style={{ width: 44, textAlign: 'right' }}>
                  {v.size}B
                </span>
                {v.isStatic && <span className="badge badge--accent">static</span>}
                <span className="faint mono small" style={{ width: 64, textAlign: 'right' }}>
                  {v.section}
                </span>
              </label>
            )
          })}
          {shown.length > 0 && shown.length !== symbols.length && (
            <div className="faint small mt-8">（筛出 {shown.length} / {symbols.length}，清空搜索看全部）</div>
          )}
        </div>
      </div>

      <div className="faint small mt-12">
        注意：这里只收 <b>全局变量</b>（含 static）。结构体成员（<code className="mono">xxx-&gt;speed_rpm</code>）
        在符号表里没有独立地址 —— 那类请用上面的「信号目录」，它知道成员类型，会生成取地址的代码。
      </div>
    </Card>
  )
}
