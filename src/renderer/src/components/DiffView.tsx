/**
 * 行级差异视图：写入前让用户看清「这个文件会变成什么样」。
 *
 * 用经典 LCS 做行对齐；文件太大时退化成整段替换提示，避免卡死界面。
 */

import React from 'react'

export interface DiffLine {
  type: 'add' | 'del' | 'same'
  text: string
  oldNo: number | null
  newNo: number | null
}

const MAX_LINES = 700

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  return text.replace(/\r\n/g, '\n').split('\n')
}

export function diffLines(previous: string | null, current: string): DiffLine[] {
  const oldLines = splitLines(previous)
  const newLines = splitLines(current)

  if (previous === null) {
    return newLines.map((text, i) => ({ type: 'add' as const, text, oldNo: null, newNo: i + 1 }))
  }

  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    return [
      {
        type: 'del',
        text: `（原文件 ${oldLines.length} 行，差异过大，不做逐行对比）`,
        oldNo: null,
        newNo: null
      },
      { type: 'add', text: `（新内容 ${newLines.length} 行）`, oldNo: null, newNo: null }
    ]
  }

  // LCS 动态规划
  const n = oldLines.length
  const m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'same', text: oldLines[i], oldNo: i + 1, newNo: j + 1 })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'del', text: oldLines[i], oldNo: i + 1, newNo: null })
      i += 1
    } else {
      result.push({ type: 'add', text: newLines[j], oldNo: null, newNo: j + 1 })
      j += 1
    }
  }
  while (i < n) {
    result.push({ type: 'del', text: oldLines[i], oldNo: i + 1, newNo: null })
    i += 1
  }
  while (j < m) {
    result.push({ type: 'add', text: newLines[j], oldNo: null, newNo: j + 1 })
    j += 1
  }

  return result
}

export function DiffView(props: {
  previous: string | null
  current: string
  collapsed?: boolean
}): React.JSX.Element {
  const lines = React.useMemo(
    () => diffLines(props.previous, props.current),
    [props.previous, props.current]
  )

  const stats = React.useMemo(() => {
    let add = 0
    let del = 0
    for (const l of lines) {
      if (l.type === 'add') add += 1
      else if (l.type === 'del') del += 1
    }
    return { add, del }
  }, [lines])

  const shown = props.collapsed ? collapseContext(lines) : lines

  return (
    <>
      <div className="flex small mb-8">
        <span className="ok">+{stats.add}</span>
        <span className="err">−{stats.del}</span>
        {props.collapsed && <span className="faint">（相同内容已折叠）</span>}
      </div>
      <div className="diff">
        {shown.map((line, index) => (
          <div
            key={index}
            className={
              line.type === 'add'
                ? 'diff__line diff__line--add'
                : line.type === 'del'
                  ? 'diff__line diff__line--del'
                  : 'diff__line'
            }
          >
            <span className="diff__gutter">{line.oldNo ?? ''}</span>
            <span className="diff__gutter">{line.newNo ?? ''}</span>
            <span>
              {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

/** 把连续 4 行以上的相同内容折叠成一行提示 */
function collapseContext(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = []
  let run: DiffLine[] = []

  const flush = (): void => {
    if (run.length > 6) {
      out.push(...run.slice(0, 2))
      out.push({
        type: 'same',
        text: `… 略过 ${run.length - 4} 行相同内容 …`,
        oldNo: null,
        newNo: null
      })
      out.push(...run.slice(-2))
    } else {
      out.push(...run)
    }
    run = []
  }

  for (const line of lines) {
    if (line.type === 'same') {
      run.push(line)
    } else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out
}
