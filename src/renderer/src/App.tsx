/**
 * 应用根组件：外壳 + 页面路由。
 *
 * 顶部不再放工作流条 —— 那三步属于「配这个工程」的流程，
 * 已经挪回「工程总览」页里面，哪儿来的回哪儿去。
 */

import React from 'react'
import { useStudio, type PageKey } from './state/store'
import { TitleBar } from './components/TitleBar'
import { Sidebar, StatusBar, ToastHost } from './components/shell'
import { PreviewModal } from './components/PreviewModal'
import { Onboarding } from './components/Onboarding'
import { Alert, Button, EmptyState, PageBody } from './components/ui'
import { UpdateNotice } from './components/UpdateNotice'
import type { UpdateInfo } from '@shared/updateTypes'
import ProjectPage from './pages/ProjectPage'
import SourcesPage from './pages/SourcesPage'
import PacksPage from './pages/PacksPage'
import LaunchPage from './pages/LaunchPage'
import TasksPage from './pages/TasksPage'
import SettingsPage from './pages/SettingsPage'
import CppPage from './pages/CppPage'
import ToolsPage from './pages/ToolsPage'
import ProbeSettingsPage from './pages/ProbeSettingsPage'
import TemplatesPage from './pages/TemplatesPage'
import InspectPage from './pages/InspectPage'
import HistoryPage from './pages/HistoryPage'
import AboutPage from './pages/AboutPage'
import BuildPage from './pages/BuildPage'

const PAGES: Record<PageKey, () => React.JSX.Element> = {
  project: ProjectPage,
  sources: SourcesPage,
  packs: PacksPage,
  launch: LaunchPage,
  tasks: TasksPage,
  settings: SettingsPage,
  cpp: CppPage,
  build: BuildPage,
  inspect: InspectPage,
  templates: TemplatesPage,
  probe: ProbeSettingsPage,
  tools: ToolsPage,
  history: HistoryPage,
  about: AboutPage
}

export default function App(): React.JSX.Element {
  const bootstrap = useStudio((s) => s.bootstrap)
  const bindRunEvents = useStudio((s) => s.bindRunEvents)
  const bindWriteProgress = useStudio((s) => s.bindWriteProgress)
  const activePage = useStudio((s) => s.activePage)
  const errorText = useStudio((s) => s.errorText)
  const setError = useStudio((s) => s.setError)
  const projectRoot = useStudio((s) => s.projectRoot)
  const setPage = useStudio((s) => s.setPage)
  const browseProject = useStudio((s) => s.browseProject)

  React.useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  React.useEffect(() => bindRunEvents(), [bindRunEvents])
  React.useEffect(() => bindWriteProgress(), [bindWriteProgress])

  /*
   * 启动时的更新检查。
   *
   * 三个刻意的设计：
   *   1. **延迟 3 秒** —— 先让界面出来、让用户能干活，
   *      别在启动那一刻跟主进程抢资源。
   *   2. **只查一次**（会话内记忆）—— 切页、重渲染都不再触发。
   *   3. **失败静默** —— 没网、被墙、限流都不打扰，只在「关于」页显示。
   *      用户打开工具是为了干活，不是来看错误提示的。
   */
  const [update, setUpdate] = React.useState<UpdateInfo | null>(null)
  const [updateDismissed, setUpdateDismissed] = React.useState(false)
  const updateChecked = React.useRef(false)

  React.useEffect(() => {
    if (updateChecked.current) return
    updateChecked.current = true
    const t = setTimeout(() => {
      void window.api
        .checkUpdate(false)
        .then((info) => setUpdate(info))
        .catch(() => {
          /* 静默失败：这里不打扰用户 */
        })
    }, 3000)
    return () => clearTimeout(t)
  }, [])

  const Page = PAGES[activePage]

  return (
    <div className="app">
      <TitleBar />

      <div className="body">
        <Sidebar />

        <main className="main">
          {/*
            「还没有选择工程」不再由外壳拦截整页 —— 每个需要工程的页面
            都会先渲染自己的 PageHeader，正文用统一的 <NoProject />。
            外壳拦的话页面标题会丢，而且和页面自己的空状态长得不一样。
          */}
          {/* 有新版本时在页面顶部挂一条提示；点 ✕ 就本次启动不再出现 */}
          {!updateDismissed && (
            <div style={{ padding: '14px 18px 0' }}>
              <UpdateNotice
                info={update}
                checking={false}
                onCheck={() => void window.api.checkUpdate(true).then(setUpdate)}
                onDismiss={() => setUpdateDismissed(true)}
                compact
              />
            </div>
          )}

          <Page />

          {errorText && (
            <div style={{ padding: '0 18px 12px' }}>
              <Alert kind="err">
                <div className="bold mb-8">出错了</div>
                <div className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
                  {errorText}
                </div>
                <div className="mt-8">
                  <Button size="sm" onClick={() => setError(null)}>
                    知道了
                  </Button>
                </div>
              </Alert>
            </div>
          )}
        </main>
      </div>

      <StatusBar />
      <ToastHost />
      <PreviewModal />
      <Onboarding />
    </div>
  )
}
