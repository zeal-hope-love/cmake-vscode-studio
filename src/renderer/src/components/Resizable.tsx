/**
 * 可拖动的分栏。
 *
 * 两处用到：
 *   · 左侧导航栏（拖它自己的右边缘）
 *   · 页面里的「列表 + 表单」两栏布局（拖中间的分隔条）
 *
 * 宽度存进应用设置（`uiWidths`），下次打开还是你调好的宽度。
 */

import React from 'react'
import { useStudio } from '../state/store'

export interface StoredWidth {
  width: number
  dragging: boolean
  startDrag: (event: React.MouseEvent) => void
}

/**
 * 一个宽度值：初始取设置里存的，拖动时实时更新，松手才落盘。
 * 拖动过程中每帧都写设置会疯狂触发 IPC，所以落盘放在 mouseup。
 */
export function useStoredWidth(
  key: string,
  defaultWidth: number,
  min: number,
  max: number
): StoredWidth {
  const stored = useStudio((s) => s.settings.uiWidths[key])
  const setUiWidth = useStudio((s) => s.setUiWidth)

  const [width, setWidth] = React.useState(stored ?? defaultWidth)
  const [dragging, setDragging] = React.useState(false)
  const widthRef = React.useRef(width)

  React.useEffect(() => {
    widthRef.current = width
  }, [width])

  // 设置里已经有值时跟它走（例如另一个窗口改了、或首次从磁盘载入）
  React.useEffect(() => {
    if (typeof stored === 'number' && stored >= min && stored <= max) setWidth(stored)
  }, [stored, min, max])

  const startDrag = React.useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = widthRef.current
      setDragging(true)

      const onMove = (ev: MouseEvent): void => {
        const next = Math.min(max, Math.max(min, startWidth + ev.clientX - startX))
        widthRef.current = next
        setWidth(next)
      }

      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setDragging(false)
        setUiWidth(key, widthRef.current)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [key, min, max, setUiWidth]
  )

  return { width, dragging, startDrag }
}

/** 细长的拖动条；鼠标悬停时才显形，不打扰视觉 */
export function ResizeHandle(props: {
  onMouseDown: (event: React.MouseEvent) => void
  active?: boolean
  title?: string
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false)
  const lit = props.active || hover

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={props.title ?? '拖动调整宽度'}
      onMouseDown={props.onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: '0 0 auto',
        width: 8,
        alignSelf: 'stretch',
        cursor: 'col-resize',
        display: 'flex',
        justifyContent: 'center',
        background: 'transparent'
      }}
    >
      <div
        style={{
          width: 2,
          borderRadius: 1,
          background: lit ? 'var(--accent)' : 'transparent',
          transition: 'background 0.12s'
        }}
      />
    </div>
  )
}

/**
 * 两栏布局：左侧定宽可拖，右侧自适应。替代原来写死 268px 的 `.split`。
 *
 * 用法上和原来的写法几乎一样，把 `<div className="split">` 换成它即可：
 *
 *   <SplitPane storageKey="launch-list">
 *     <Card>…左栏…</Card>
 *     <div>…右栏…</div>
 *   </SplitPane>
 */
export function SplitPane(props: {
  /** 恰好两个子元素：第一个是左栏（可拖宽），第二个是右栏（自适应） */
  children: React.ReactNode
  /** 宽度存在设置里的键名，不同页面各自记忆 */
  storageKey?: string
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
}): React.JSX.Element {
  const { width, dragging, startDrag } = useStoredWidth(
    props.storageKey ?? 'split',
    props.defaultWidth ?? 300,
    props.minWidth ?? 220,
    props.maxWidth ?? 640
  )

  const children = React.Children.toArray(props.children)

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      <div style={{ width, flex: '0 0 auto', minWidth: 0 }}>{children[0]}</div>
      <ResizeHandle onMouseDown={startDrag} active={dragging} />
      <div style={{ flex: 1, minWidth: 0 }}>{children[1]}</div>
    </div>
  )
}
