/**
 * 应用设置：外观、版本更新、关于。
 *
 * ## 为什么把这三块并到一页
 *
 * 以前主题在标题栏、更新在「关于与版本」页、关于信息又是单独一页 ——
 * 三样都算「应用自己的事」，却分散在三个地方，用户找起来全靠猜。
 * 现在按「越不常改的越靠下」排：外观 → 更新 → 关于。
 *
 * ## 关于为什么放最后
 *
 * 它是**查阅型**内容（版本号、Electron 版本、数据目录、复制给开发者看的环境信息），
 * 平时不需要操作。放在最下面，需要时滚到底即可，也不挡着上面两个真正会动手改的区块。
 *
 * ## 更新区块和标题栏芯片是同一份状态
 *
 * 都读 store 里的 `updateState`（源头在主进程），所以「芯片显示 42% 时
 * 这一页也一定是 42%」。这里不复用芯片的 UI —— 芯片是「一眼看一眼」的紧凑形态，
 * 这一页要放得下说明文字、开关、发布说明，硬套会两边都别扭。
 */

import React from 'react'
import { themeLabel, useStudio } from '../state/store'
import type { AppSettings } from '@shared/types'
import { Button, Card, Field, PageBody, PageHeader, Select, Spinner } from '../components/ui'
import { AboutInfo } from '../components/AboutInfo'
import { Icons } from '../components/icons'
import { RELEASES_URL, REPO_URL } from '@shared/repoLinks'

/** 主题的显示名（下拉里用） */
const THEME_OPTIONS: Array<{ value: AppSettings['theme']; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1)
}

export default function AppSettingsPage(): React.JSX.Element {
  const settings = useStudio((s) => s.settings)
  const setTheme = useStudio((s) => s.setTheme)
  const saveSettings = useStudio((s) => s.saveSettings)
  const appInfo = useStudio((s) => s.appInfo)

  const update = useStudio((s) => s.updateState)
  const checkUpdateNow = useStudio((s) => s.checkUpdateNow)
  const downloadUpdateNow = useStudio((s) => s.downloadUpdateNow)
  const cancelUpdateDownload = useStudio((s) => s.cancelUpdateDownload)
  const installUpdate = useStudio((s) => s.installUpdate)

  /*
   * 从标题栏芯片点「详情」过来时，把更新卡片滚进视野并闪一下。
   * 和以前 AboutPage 的做法一致：序号自增 ⇒ 连点也能再滚一次。
   */
  const updateFocusSeq = useStudio((s) => s.updateFocusSeq)
  const [flash, setFlash] = React.useState(false)

  React.useEffect(() => {
    if (!updateFocusSeq) return
    const t = setTimeout(() => {
      document.getElementById('update-card')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      setFlash(true)
    }, 80)
    return () => clearTimeout(t)
  }, [updateFocusSeq])

  React.useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(false), 1600)
    return () => clearTimeout(t)
  }, [flash])

  const info = update?.info ?? null
  const phase = update?.phase ?? 'idle'
  const downloading = phase === 'downloading'
  const ready = phase === 'ready'
  const progress = update?.progress ?? null
  const percent = progress && progress.percent >= 0 ? progress.percent : null

  /** 开关「启动时自动检查」：主进程那边的检查逻辑每次都会重新读设置 */
  const toggleAutoCheck = (on: boolean): void => {
    void saveSettings({ checkUpdates: on }).then(() => {
      // 打开时立刻查一次；关掉时 runCheck 会直接把阶段改成 disabled
      void checkUpdateNow(false)
    })
  }

  return (
    <>
      <PageHeader
        title="设置"
        subtitle={appInfo ? `CV Studio v${appInfo.version} · 外观与更新` : '外观与更新'}
        actions={
          <Button size="sm" variant="ghost" onClick={() => void window.api.openExternal(REPO_URL)}>
            <Icons.external />
            GitHub
          </Button>
        }
      />

      <PageBody>
        {/* ================= 外观 ================= */}
        <Card
          title="外观"
          hint="主题一年改不了两次，所以从标题栏挪到了这里"
          actions={<span className="faint small">{themeLabel(settings.theme)}</span>}
        >
          <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
            <div style={{ width: 220 }}>
              <Field label="主题">
                <Select
                  value={settings.theme}
                  options={THEME_OPTIONS}
                  onChange={(e) => void setTheme(e.target.value as AppSettings['theme'])}
                />
              </Field>
            </div>
            <div className="faint small" style={{ paddingBottom: 10, flex: 1 }}>
              选「跟随系统」时会跟着 Windows 的深色模式自动切换，不用手动改。
              主题同时作用于界面和标题栏（右上角窗口按钮的颜色）。
            </div>
          </div>
        </Card>

        {/* ================= 版本更新 ================= */}
        <div className={flash ? 'card-flash' : undefined}>
          <Card
            id="update-card"
            title="版本更新"
            hint="检测到新版本会自动在后台下载，下完提示重启"
            actions={
              <Button size="sm" variant="ghost" onClick={() => void checkUpdateNow(true)}>
                {phase === 'checking' ? <Spinner /> : <Icons.refresh />}
                {phase === 'checking' ? '检查中…' : '检查更新'}
              </Button>
            }
          >
            {/* ---- 一行状态摘要 ---- */}
            <div className="small" style={{ lineHeight: 1.9 }}>
              <div>
                当前版本 <b>v{info?.currentVersion ?? appInfo?.version ?? '—'}</b>
                {info?.hasUpdate && (
                  <span style={{ color: 'var(--accent)', marginLeft: 10, fontWeight: 600 }}>
                    最新 v{info.latestVersion}
                  </span>
                )}
                {phase === 'up-to-date' && <span className="faint" style={{ marginLeft: 8 }}>已是最新</span>}
                {info?.publishedAt && (
                  <span className="faint" style={{ marginLeft: 8 }}>
                    · 发布于 {info.publishedAt.slice(0, 10)}
                  </span>
                )}
              </div>

              {phase === 'disabled' && (
                <div className="faint">
                  自动检查已关闭。点右上角「检查更新」仍可以手动查一次。
                </div>
              )}
              {phase === 'error' && (
                <div style={{ color: 'var(--warn)' }}>
                  检查失败：{update?.error ?? '未知原因'}
                  <span className="faint"> —— 不影响使用，想装新版也可以直接去 </span>
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => void window.api.openExternal(RELEASES_URL)}
                  >
                    GitHub Releases
                  </button>
                  <span className="faint">。</span>
                </div>
              )}
            </div>

            {/* ---- 下载中 ---- */}
            {downloading && (
              <div style={{ marginTop: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className="small">
                    正在后台下载
                    {progress && progress.total > 0 && (
                      <span className="faint">
                        {' '}
                        {mb(progress.received)} / {mb(progress.total)} MB
                      </span>
                    )}
                    {progress && progress.speed > 0 && (
                      <span className="faint"> · {mb(progress.speed)} MB/s</span>
                    )}
                  </span>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="faint small">{percent !== null ? `${percent}%` : '…'}</span>
                    <Button size="sm" variant="ghost" onClick={() => void cancelUpdateDownload()}>
                      取消
                    </Button>
                  </span>
                </div>
                <div className="update-pop__bar">
                  <span
                    style={{
                      width: percent !== null ? `${percent}%` : '35%',
                      ...(percent === null
                        ? { animation: 'cv-progress-slide 1.2s ease-in-out infinite' }
                        : {})
                    }}
                  />
                </div>
              </div>
            )}

            {/* ---- 已就绪：提示重启 ---- */}
            {ready && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 8,
                  background: 'var(--accent-soft)',
                  border: '1px solid var(--accent)'
                }}
              >
                <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
                  ✓ v{update?.readyVersion ?? info?.latestVersion} 安装包已下载完成，重启即可完成更新
                </div>
                <div className="faint small" style={{ marginBottom: 10 }}>
                  {update?.canInstall
                    ? '点「重启更新」会启动安装程序并关闭应用，装完再打开就是新版本。'
                    : '这是免安装版，需要手动替换 exe —— 打开所在文件夹拿文件。'}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {update?.canInstall && (
                    <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
                      <Icons.download />
                      重启更新
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const dir = (update?.filePath ?? '').replace(/[\\/][^\\/]+$/, '')
                      if (dir) void window.api.openExternal('file:///' + dir.replace(/\\/g, '/'))
                    }}
                  >
                    打开所在文件夹
                  </Button>
                  <span className="faint small">
                    安装时若提示「未知发布者」，点「仍要运行」即可（未购买代码签名证书）
                  </span>
                </div>
              </div>
            )}

            {/* ---- 有新版但没下载（自动下载关了 / 失败） ---- */}
            {(phase === 'available' || (info?.hasUpdate && phase !== 'ready' && !downloading)) && (
              <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
                <Button size="sm" variant="primary" onClick={() => void downloadUpdateNow()}>
                  <Icons.download />
                  下载更新包
                </Button>
                {info?.releaseUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void window.api.openExternal(info.releaseUrl)}
                  >
                    <Icons.external />
                    在浏览器打开发布页
                  </Button>
                )}
              </div>
            )}

            {/* ---- 发布说明 ---- */}
            {info?.hasUpdate && info.notes && (
              <details style={{ marginTop: 12 }}>
                <summary className="small faint" style={{ cursor: 'pointer' }}>
                  更新内容
                </summary>
                <pre
                  className="small"
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 260,
                    overflow: 'auto',
                    background: 'var(--bg-sunken)',
                    padding: 10,
                    borderRadius: 6,
                    margin: '8px 0 0',
                    fontFamily: 'inherit'
                  }}
                >
                  {info.notes}
                </pre>
              </details>
            )}

            {/* ---- 两个开关 ---- */}
            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8
              }}
            >
              <label className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.checkUpdates !== false}
                  onChange={(e) => toggleAutoCheck(e.target.checked)}
                />
                <span className="small">启动时自动检查更新</span>
                <span className="faint small">（关掉后仍可手动检查）</span>
              </label>

              <label className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.autoDownloadUpdates !== false}
                  onChange={(e) => void saveSettings({ autoDownloadUpdates: e.target.checked })}
                />
                <span className="small">检测到新版本就自动下载</span>
                <span className="faint small">
                  （下载完只提示重启，不会打断你手上的活；关掉后要自己点下载）
                </span>
              </label>
            </div>
          </Card>
        </div>

        {/* ================= 关于（放在最后） ================= */}
        <Card title="版本与运行环境" hint="出问题时把这段发出来，能省很多来回">
          <AboutInfo />
        </Card>

        <Card title="这个工具做什么" hint="一句话：只读工程、只写 .vscode">
          <div className="small muted" style={{ lineHeight: 1.9 }}>
            <div>
              · 读 <span className="mono">CMakeLists.txt</span> /{' '}
              <span className="mono">CMakePresets.json</span> / <span className="mono">*.ioc</span>{' '}
              和构建产物，推导出芯片、固件名、构建目录、头文件目录；
            </div>
            <div>
              · 写 <span className="mono">.vscode/</span> 下的{' '}
              <span className="mono">launch.json</span> / <span className="mono">tasks.json</span> /{' '}
              <span className="mono">settings.json</span> /{' '}
              <span className="mono">c_cpp_properties.json</span> /{' '}
              <span className="mono">openocd-*.cfg</span>；
            </div>
            <div>
              · <b>不碰</b>你的源码和 <span className="mono">CMakeLists.txt</span>；
            </div>
            <div>· 每次写入前自动存快照，随时可以在「检查与清理」页还原，或者一键清除全部配置。</div>
          </div>
        </Card>

        <Card title="数据放在哪" hint="不在你的工程里">
          <div className="small muted" style={{ lineHeight: 1.9 }}>
            <div>
              · 设置 / 模板 / 写入快照 / 下载的安装包都在{' '}
              <span className="mono">{appInfo?.userData ?? '%APPDATA%\\CV Studio'}</span>
            </div>
            <div>· 卸载或删掉这个目录，不会影响任何工程</div>
            <div>
              · 唯一会写进工程的，是上面列出的 <span className="mono">.vscode</span> 文件
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
