/**
 * 通用 UI 组件。所有页面都从这里取，保证观感与交互一致。
 */

import React from 'react'

export function PageHeader(props: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="main__header">
      <div style={{ minWidth: 0 }}>
        <h1 className="main__title">{props.title}</h1>
        {props.subtitle && <div className="main__subtitle">{props.subtitle}</div>}
      </div>
      {props.actions && <div className="main__header-actions">{props.actions}</div>}
    </div>
  )
}

export function PageBody(props: { children: React.ReactNode }): React.JSX.Element {
  return <div className="main__content">{props.children}</div>
}

// --------------------------------------------------------------------------
// 容器
// --------------------------------------------------------------------------

export function Card(props: {
  title?: React.ReactNode
  hint?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  flush?: boolean
  /** 给个 id，方便别处 scrollIntoView（例如两步引导条点「上一步」） */
  id?: string
}): React.JSX.Element {
  return (
    <section className="card" id={props.id}>
      {(props.title || props.actions) && (
        <header className="card__head">
          {props.title && <span className="card__title">{props.title}</span>}
          {props.hint && <span className="card__hint">{props.hint}</span>}
          {props.actions && <div className="card__actions">{props.actions}</div>}
        </header>
      )}
      <div className={props.flush ? 'card__body card__body--flush' : 'card__body'}>
        {props.children}
      </div>
    </section>
  )
}

export function Alert(props: {
  kind?: 'ok' | 'warn' | 'err' | 'accent' | 'info'
  icon?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const cls = props.kind && props.kind !== 'info' ? `alert alert--${props.kind}` : 'alert'
  const icon =
    props.icon ??
    (props.kind === 'ok' ? '✓' : props.kind === 'warn' ? '⚠' : props.kind === 'err' ? '✕' : 'ℹ')
  return (
    <div className={cls}>
      <span className="alert__icon">{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{props.children}</div>
    </div>
  )
}

export function EmptyState(props: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty__title">{props.title}</div>
      {props.children}
    </div>
  )
}

// --------------------------------------------------------------------------
// 按钮
// --------------------------------------------------------------------------

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant
    size?: 'sm' | 'md'
  }
): React.JSX.Element {
  const { variant = 'default', size = 'md', className, ...rest } = props
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')
  return <button type="button" className={classes} {...rest} />
}

// --------------------------------------------------------------------------
// 表单
// --------------------------------------------------------------------------

export function Field(props: {
  label?: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <div className="field" style={props.style}>
      {props.label && <label className="field__label">{props.label}</label>}
      {props.children}
      {props.hint && <span className="field__hint">{props.hint}</span>}
    </div>
  )
}

export function TextInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }
): React.JSX.Element {
  const { mono, className, ...rest } = props
  return (
    <input
      className={['input', mono ? 'input--mono' : '', className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    />
  )
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea className="textarea" spellCheck={false} {...props} />
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & {
    options: Array<{ value: string; label: string; disabled?: boolean }>
  }
): React.JSX.Element {
  const { options, ...rest } = props
  return (
    <select className="select" {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Checkbox(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: React.ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label && <span>{props.label}</span>}
    </label>
  )
}

export function SwitchRow(props: {
  title: React.ReactNode
  desc?: React.ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="switch-row">
      <div className="switch-row__text">
        <div className="switch-row__title">{props.title}</div>
        {props.desc && <div className="switch-row__desc">{props.desc}</div>}
      </div>
      <Checkbox checked={props.checked} onChange={props.onChange} disabled={props.disabled} />
    </div>
  )
}

// --------------------------------------------------------------------------
// 展示
// --------------------------------------------------------------------------

export function Badge(props: {
  kind?: 'ok' | 'warn' | 'err' | 'accent' | 'default'
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  const kind = props.kind ?? 'default'
  return (
    <span className={kind === 'default' ? 'badge' : `badge badge--${kind}`} title={props.title}>
      {props.children}
    </span>
  )
}

export function Kv(props: {
  items: Array<[React.ReactNode, React.ReactNode] | null>
  mono?: boolean
}): React.JSX.Element {
  const rows = props.items.filter(Boolean) as Array<[React.ReactNode, React.ReactNode]>
  return (
    <div className="kv">
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <div className="kv__k">{k}</div>
          <div className={props.mono === false ? 'kv__v kv__v--plain' : 'kv__v'}>{v}</div>
        </React.Fragment>
      ))}
    </div>
  )
}

export function Tabs<T extends string>(props: {
  value: T
  onChange: (value: T) => void
  tabs: Array<{ key: T; label: React.ReactNode }>
}): React.JSX.Element {
  return (
    <div className="tabs">
      {props.tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          className={t.key === props.value ? 'tab tab--active' : 'tab'}
          onClick={() => props.onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// --------------------------------------------------------------------------
// 模态框
// --------------------------------------------------------------------------

export function Modal(props: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}): React.JSX.Element {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={props.width ? { width: props.width } : undefined}>
        <header className="modal__head">
          <span className="modal__title">{props.title}</span>
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={props.onClose} title="关闭 (Esc)">
            ✕
          </Button>
        </header>
        <div className="modal__body">{props.children}</div>
        {props.footer && <footer className="modal__foot">{props.footer}</footer>}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// 表格
// --------------------------------------------------------------------------

export function DataTable(props: {
  columns: Array<{ key: string; title: React.ReactNode; width?: string | number }>
  rows: Array<{ key: string; cells: React.ReactNode[]; onClick?: () => void; selected?: boolean }>
  empty?: React.ReactNode
}): React.JSX.Element {
  if (!props.rows.length && props.empty) {
    return <>{props.empty}</>
  }

  return (
    <table className={props.rows.some((r) => r.onClick) ? 'table table--clickable' : 'table'}>
      <thead>
        <tr>
          {props.columns.map((c) => (
            <th key={c.key} style={c.width ? { width: c.width } : undefined}>
              {c.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r) => (
          <tr key={r.key} className={r.selected ? 'is-selected' : undefined} onClick={r.onClick}>
            {r.cells.map((cell, i) => (
              <td key={i}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

export function Spinner(): React.JSX.Element {
  return <span className="spinner" />
}

export function PathText(props: { value: string | null | undefined; max?: number }): React.JSX.Element {
  const text = props.value ?? ''
  if (!text) return <span className="faint">—</span>
  const max = props.max ?? 90
  const shown = text.length > max ? '…' + text.slice(-(max - 1)) : text
  return (
    <span className="mono truncate" title={text}>
      {shown}
    </span>
  )
}
