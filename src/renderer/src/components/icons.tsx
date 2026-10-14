/**
 * 极简图标集：统一 16×16、stroke 用 currentColor，跟着主题走。
 */

import React from 'react'

function Svg(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      {props.children}
    </svg>
  )
}

export const Icons = {
  project: () => (
    <Svg>
      <path d="M2 4.5h4l1.2 1.5H14v6.5H2z" />
      <path d="M2 4.5V3h4.5" />
    </Svg>
  ),
  debug: () => (
    <Svg>
      <circle cx="8" cy="8" r="5.2" />
      <path d="M6.6 6.2 10.4 8l-3.8 1.8z" fill="currentColor" />
    </Svg>
  ),
  tasks: () => (
    <Svg>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.2 8.2 7 10l3.8-4" />
    </Svg>
  ),
  settings: () => (
    <Svg>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
    </Svg>
  ),
  cpp: () => (
    <Svg>
      <path d="M6 3.2C4.6 3.2 4.8 7 3.4 7c1.4 0 1.2 5.8 2.6 5.8" />
      <path d="M10 3.2c1.4 0 1.2 3.8 2.6 3.8-1.4 0-1.2 5.8-2.6 5.8" />
    </Svg>
  ),
  tools: () => (
    <Svg>
      <path d="M10.2 2.4a3.2 3.2 0 0 0-3 5.2L2.6 12.2l1.2 1.2 4.6-4.6a3.2 3.2 0 0 0 4.2-4.1l-1.9 1.9-1.6-.1-.1-1.6z" />
    </Svg>
  ),
  templates: () => (
    <Svg>
      <rect x="2.4" y="2.4" width="8" height="8" rx="1.6" />
      <path d="M5.6 12.4v0a1.6 1.6 0 0 0 1.6 1.2h4.4a1.6 1.6 0 0 0 1.6-1.6V7.6A1.6 1.6 0 0 0 12.6 6" />
    </Svg>
  ),
  build: () => (
    <Svg>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M4.6 6.4 6.4 8 4.6 9.6M8.2 10h3.2" />
    </Svg>
  ),
  /** 历史记录：表盘加一根指针 */
  clock: () => (
    <Svg>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.6 1.6" />
    </Svg>
  ),
  /** 关于：圆圈里的 i */
  info: () => (
    <Svg>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4M8 4.9v.6" />
    </Svg>
  ),
  theme: () => (
    <Svg>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 2.6a5.4 5.4 0 0 0 0 10.8z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  /** 检查与清理：扫帚 */
  broom: () => (
    <Svg>
      <path d="M10.4 2.2 6.6 6l1.4 1.4 3.8-3.8z" />
      <path d="M6.2 6.4 3.4 9.2a1.6 1.6 0 0 0 0 2.3l1.1 1.1a1.6 1.6 0 0 0 2.3 0l2.8-2.8z" />
      <path d="M4.6 11.2 3 12.8" />
    </Svg>
  ),
  write: () => (
    <Svg>
      <path d="M3 12.5V13h.5l7.3-7.3-1.5-1.5L3 11.5z" />
      <path d="M10.2 2.6 12 4.4" />
      <path d="M2.5 9v4.5H7" />
    </Svg>
  ),
  eye: () => (
    <Svg>
      <path d="M1.8 8S4 4.2 8 4.2 14.2 8 14.2 8 12 11.8 8 11.8 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </Svg>
  ),
  refresh: () => (
    <Svg>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8" />
      <path d="M13.4 2.6v2.6h-2.6" />
    </Svg>
  ),
  folder: () => (
    <Svg>
      <path d="M2 4.5h4l1.2 1.5H14v6.5H2z" />
    </Svg>
  ),
  vscode: () => (
    <Svg>
      <path d="M11.4 1.8 5.6 7.1 2.8 5l-1.2.7 2.6 2.3-2.6 2.3 1.2.7 2.8-2.1 5.8 5.3 2.2-1.1V2.9z" />
    </Svg>
  )
}
