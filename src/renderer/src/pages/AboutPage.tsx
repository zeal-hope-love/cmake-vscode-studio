/**
 * 关于与版本。
 *
 * 以前这些信息藏在新手引导的第 6 步里，没人找得到 —— 现在侧边栏底部有个常驻入口。
 */

import React from 'react'
import { useStudio } from '../state/store'
import { Button, Card, PageBody, PageHeader } from '../components/ui'
import { AboutInfo } from '../components/AboutInfo'
import { UpdateNotice } from '../components/UpdateNotice'
import type { UpdateInfo } from '@shared/updateTypes'
import { Icons } from '../components/icons'

export default function AboutPage(): React.JSX.Element {
  const appInfo = useStudio((s) => s.appInfo)
  const settings = useStudio((s) => s.settings)
  const saveSettings = useStudio((s) => s.saveSettings)
  /*
   * 更新检测状态放这个页面自己管，不进全局 store ——
   * 只有这一页看得到，没必要让所有页面跟着重渲染。
   */
  const [update, setUpdate] = React.useState<UpdateInfo | null>(null)
  const [checking, setChecking] = React.useState(false)

  const doCheck = React.useCallback(async (force: boolean): Promise<void> => {
    setChecking(true)
    try {
      setUpdate(await window.api.checkUpdate(force))
    } catch (err) {
      setUpdate({
        currentVersion: appInfo?.version ?? '',
        latestVersion: '',
        hasUpdate: false,
        releaseUrl: '',
        releaseName: '',
        notes: '',
        publishedAt: '',
        assets: [],
        status: 'error',
        detail: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setChecking(false)
    }
  }, [appInfo?.version])

  // 进页面就查一次（走缓存，不会每次都打 GitHub）
  React.useEffect(() => {
    void doCheck(false)
  }, [doCheck])

  const resetOnboarding = useStudio((s) => s.resetOnboarding)
  const openHelp = useStudio((s) => s.openHelp)

  return (
    <>
      <PageHeader
        title="关于与版本"
        subtitle={appInfo ? `${appInfo.name} v${appInfo.version}` : 'CV Studio'}
        actions={
          <>
            <Button size="sm" onClick={() => void openHelp()}>
              新手引导
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void resetOnboarding()}>
              <Icons.refresh />
              每次启动都显示引导
            </Button>
          </>
        }
      />

      <PageBody>
        <UpdateNotice
          info={update}
          checking={checking}
          onCheck={() => void doCheck(true)}
          autoCheck={settings.checkUpdates !== false}
          onToggleAutoCheck={(v) => void saveSettings({ checkUpdates: v })}
        />

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
              · 写 <span className="mono">.vscode/</span> 下的 <span className="mono">launch.json</span>{' '}
              / <span className="mono">tasks.json</span> / <span className="mono">settings.json</span> /{' '}
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
              · 设置 / 模板 / 写入快照都在{' '}
              <span className="mono">
                {appInfo?.userData ?? '%APPDATA%\\CV Studio'}
              </span>
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
