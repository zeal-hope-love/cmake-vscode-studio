/**
 * 首次启动的新手向导。
 *
 * 为什么需要它：这个工具从「一个文本菜单」变成了「8 个页面的图形界面」，
 * 打开第一眼确实会懵。所以第一屏先讲清楚三件事 ——
 *   它到底改什么、最短路径怎么走、其它页面不用管。
 *
 * 用纯 CSS/SVG 画示意图而不是塞截图：体积为零、支持深浅主题、任意 DPI 都清晰。
 */

import React from 'react'
import { useStudio } from '../state/store'
import { Badge, Button, Checkbox, Modal } from './ui'

interface Step {
  title: string
  subtitle: string
  body: React.ReactNode
}

// --------------------------------------------------------------------------
// 示意图零件
// --------------------------------------------------------------------------

function FlowBox(props: {
  title: string
  lines?: string[]
  tone?: 'plain' | 'accent' | 'ok'
}): React.JSX.Element {
  const tone = props.tone ?? 'plain'
  const border =
    tone === 'accent' ? 'var(--accent)' : tone === 'ok' ? 'var(--ok)' : 'var(--border-strong)'
  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: 0,
        border: `1px solid ${border}`,
        background: tone === 'accent' ? 'var(--accent-soft)' : 'var(--bg-raised)',
        borderRadius: 'var(--radius)',
        padding: '10px 12px'
      }}
    >
      <div className="bold small mb-8">{props.title}</div>
      {props.lines?.map((l) => (
        <div key={l} className="mono faint" style={{ fontSize: 11, lineHeight: 1.7 }}>
          {l}
        </div>
      ))}
    </div>
  )
}

function Arrow(): React.JSX.Element {
  return (
    <div className="faint" style={{ flex: '0 0 auto', fontSize: 16, padding: '0 2px' }}>
      →
    </div>
  )
}

function Numbered(props: { n: number; title: string; desc: React.ReactNode; done?: boolean }) {
  return (
    <div className="flex" style={{ alignItems: 'flex-start', gap: 12, padding: '9px 0' }}>
      <span
        style={{
          flex: '0 0 auto',
          width: 24,
          height: 24,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          fontSize: 12,
          fontWeight: 700,
          background: props.done ? 'var(--ok)' : 'var(--accent)',
          color: '#fff'
        }}
      >
        {props.done ? '✓' : props.n}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bold">{props.title}</div>
        <div className="small muted" style={{ marginTop: 2, lineHeight: 1.6 }}>
          {props.desc}
        </div>
      </div>
    </div>
  )
}

import { AboutInfo } from './AboutInfo'

// --------------------------------------------------------------------------
// 六步内容
// --------------------------------------------------------------------------

const STEPS: Step[] = [
  {
    title: '它到底改什么',
    subtitle: '只写工程里的 .vscode 配置，不碰你的源码和 CMakeLists.txt',
    body: (
      <>
        <div className="flex mb-12" style={{ alignItems: 'stretch' }}>
          <FlowBox
            title="你的 CMake 工程"
            lines={['CMakeLists.txt', 'CMakePresets.json', '*.ioc（可选）', 'build/Debug/*.elf']}
          />
          <Arrow />
          <FlowBox
            title="本工具检测"
            tone="accent"
            lines={['芯片型号', '固件名', '构建目录', '工具链路径']}
          />
          <Arrow />
          <FlowBox
            title="写入 .vscode/"
            tone="ok"
            lines={[
              'launch.json',
              'tasks.json',
              'settings.json',
              'c_cpp_properties.json',
              'openocd-*.cfg'
            ]}
          />
        </div>

        <div className="alert alert--accent" style={{ marginBottom: 0 }}>
          <span className="alert__icon">💡</span>
          <div>
            所有信息都是<b>从工程里读出来</b>的，不需要你手填芯片型号或固件名。 没有{' '}
            <span className="mono">.ioc</span> 的工程会按「通用 CMake」处理，一样能用。
          </div>
        </div>
      </>
    )
  },
  {
    title: '最短路径：三步',
    subtitle: '其它页面全部有合理默认值，第一次用不需要动',
    body: (
      <>
        <Numbered
          n={1}
          title="选择工程"
          desc={
            <>
              粘贴路径、点「浏览…」，或者直接从下方列表里点 —— 它会自动列出你
              <b> VSCode 里正在打开</b>和<b>最近打开过</b>的工程。
            </>
          }
        />
        <Numbered
          n={2}
          title="看一眼检测结果"
          desc={
            <>
              芯片、固件名、preset、构建目录、工具链都会显示出来。
              有黄框提示说明有需要注意的地方，但通常不挡事。
            </>
          }
        />
        <Numbered
          n={3}
          title="点右上角「写入配置」"
          desc={
            <>会先给你看每个文件「将变成什么样」的差异，确认后才真正落盘。 平时到这一步就结束了。</>
          }
        />

        <div className="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          <span className="alert__icon">👉</span>
          <div>
            整个流程就是：<b>选工程 → 点「写入配置」</b>。中间那一步只是让你确认一下。
          </div>
        </div>
      </>
    )
  },
  {
    title: '侧边栏这几栏分别在干嘛',
    subtitle: '带 ★ 的是你多半要看的；分组依据只有一个：这页需不需要先选工程',
    body: (
      <div className="onboard-table">
        {[
          ['工程总览', '★ 选工程、看检测结果、写入配置', '每天都会用到'],
          ['调试 launch.json', 'F5 下拉框里有哪些配置', '要加自定义调试配置时才来'],
          ['任务 tasks.json', 'Ctrl+Shift+B 的任务', '要加构建/烧录任务时才来'],
          ['设置 settings.json', 'OpenOCD 路径、cmake 配置等', '工具路径没探测到时来'],
          ['IntelliSense', '代码跳转、补全', '发现跳转不准时来'],
          ['构建与烧录', '不离开工具就能编译、烧录', '想在这儿一键烧录时用'],
          ['检查与清理', '检测到的问题、清除配置、还原', '配置写坏了想退回时来'],
          [
            '模板与配置',
            '不依赖工程新建/编辑模板，直接改四份文件内容',
            '有好几个工程、或想攒一套标准配置时'
          ],
          ['工具与路径', '探测到的工具、探针选择', '换调试器 / 换电脑时来（不需要先选工程）'],
          ['历史记录', '做过什么 + 每条都能直接再来一次', '想「重新配置那个工程」时不用翻目录'],
          ['关于与版本', '版本号、运行环境、数据目录', '反馈问题时来']
        ].map(([name, what, when]) => (
          <div key={name} className="onboard-table__row">
            <div className="bold small">{name}</div>
            <div className="small muted">{what}</div>
            <div className="small faint">{when}</div>
          </div>
        ))}
      </div>
    )
  },
  {
    title: '写入会发生什么',
    subtitle: '默认是直接覆盖，但有两道保险',
    body: (
      <>
        <div className="mb-12">
          {[
            'launch.json —— 调试配置',
            'tasks.json —— 构建 / 烧录任务',
            'settings.json —— 工作区设置',
            'c_cpp_properties.json —— IntelliSense',
            'openocd-<芯片>-<探针>.cfg —— OpenOCD 接线配置'
          ].map((f) => (
            <div
              key={f}
              className="flex"
              style={{ padding: '5px 0', borderBottom: '1px dashed var(--border)' }}
            >
              <Badge kind="accent">写入</Badge>
              <span className="mono small">{f}</span>
            </div>
          ))}
        </div>

        <div className="alert alert--warn" style={{ marginBottom: 8 }}>
          <span className="alert__icon">⚠</span>
          <div>
            <b>同名文件会被整体覆盖</b>，和原来那个 PowerShell 脚本行为一致。
          </div>
        </div>

        <div className="small muted" style={{ lineHeight: 1.7 }}>
          两道保险：<b>①</b> 写入前有差异预览，看得见自己原来有什么；
          <b>②</b> 预览窗口里可以勾选「写入前把原文件备份到{' '}
          <span className="mono">.vscode/.backup/</span>」。
        </div>
      </>
    )
  },
  {
    title: '两种工程模式',
    subtitle: '工具会自动判断，你不用选',
    body: (
      <div className="grid grid--2">
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card__head">
            <span className="card__title">STM32 / 嵌入式模式</span>
            <div className="card__actions">
              <Badge kind="ok">自动识别</Badge>
            </div>
          </div>
          <div className="card__body small" style={{ lineHeight: 1.8 }}>
            <div className="mb-8">
              判定条件：工程里有 <span className="mono">.ioc</span> 文件
            </div>
            <div>
              · 芯片型号从 <span className="mono">Mcu.CPN</span> 读
            </div>
            <div>
              · 生成 <span className="mono">cortex-debug</span> 调试配置
            </div>
            <div>· 生成 OpenOCD 接线配置与烧录任务</div>
            <div>· 自动匹配 SVD，调试能看外设寄存器</div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card__head">
            <span className="card__title">通用 CMake 模式</span>
            <div className="card__actions">
              <Badge>自动识别</Badge>
            </div>
          </div>
          <div className="card__body small" style={{ lineHeight: 1.8 }}>
            <div className="mb-8">
              判定条件：没有 <span className="mono">.ioc</span>
            </div>
            <div>
              · 生成 <span className="mono">cppdbg</span>（gdb）调试配置
            </div>
            <div>
              · MSVC 工程自动换成 <span className="mono">cppvsdbg</span>
            </div>
            <div>· 构建 / 任务 / 设置 / IntelliSense 照常工作</div>
            <div>· 不写任何 OpenOCD 相关内容</div>
          </div>
        </div>
      </div>
    )
  },
  {
    title: '关于与版本',
    subtitle: '出问题时把这段信息发出来，能省很多来回',
    body: <AboutInfo />
  }
]

// --------------------------------------------------------------------------
// 组件
// --------------------------------------------------------------------------

export function Onboarding(): React.JSX.Element | null {
  const open = useStudio((s) => s.helpOpen)
  const closeHelp = useStudio((s) => s.closeHelp)
  const markDone = useStudio((s) => s.completeOnboarding)

  const [step, setStep] = React.useState(0)
  const [skipNext, setSkipNext] = React.useState(true)

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setSkipNext(true)
    }
  }, [open])

  if (!open) return null

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  const finish = (): void => {
    void markDone(skipNext)
    closeHelp()
  }

  return (
    <Modal
      title="欢迎使用 · 新手引导"
      width={860}
      onClose={finish}
      footer={
        <>
          <Checkbox checked={skipNext} onChange={setSkipNext} label="以后不再自动显示" />
          <div className="spacer" />
          <Button variant="ghost" onClick={finish}>
            跳过
          </Button>
          <Button disabled={step === 0} onClick={() => setStep((v) => v - 1)}>
            上一步
          </Button>
          {isLast ? (
            <Button variant="primary" onClick={finish}>
              开始使用
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setStep((v) => v + 1)}>
              下一步
            </Button>
          )}
        </>
      }
    >
      {/* 步骤指示 */}
      <div className="onboard-dots">
        {STEPS.map((s, i) => (
          <button
            key={s.title}
            type="button"
            className={
              i === step
                ? 'onboard-dot onboard-dot--active'
                : i < step
                  ? 'onboard-dot onboard-dot--done'
                  : 'onboard-dot'
            }
            onClick={() => setStep(i)}
            title={s.title}
          >
            {i < step ? '✓' : i + 1}
          </button>
        ))}
      </div>

      <h2 style={{ margin: '14px 0 4px', fontSize: 18 }}>{current.title}</h2>
      <div className="muted small mb-12">{current.subtitle}</div>

      {current.body}
    </Modal>
  )
}
