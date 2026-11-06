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
// 七步内容（第一页是 AI 声明，从 2.0.2 起）
// --------------------------------------------------------------------------

const STEPS: Step[] = [
  {
    title: '先说清楚：这是 AI 写的软件',
    subtitle: '代码、界面、文案、文档全部由 AI 编程助手生成 —— 用之前请先看这一页',
    body: (
      <>
        <div className="alert alert--warn" style={{ marginBottom: 14 }}>
          <span className="alert__icon">🤖</span>
          <div>
            这个工具<b>没有一行是人手敲的</b>。需求、验收、真机测试由作者负责，
            具体实现由 AI 编程助手（对话里逐条写代码的那种）完成。
            你现在看的这份引导、README、发布说明，同样是它写的。
          </div>
        </div>

        <div className="grid grid--2" style={{ marginBottom: 12 }}>
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card__head">
              <span className="card__title">好处</span>
            </div>
            <div className="card__body small" style={{ lineHeight: 1.8 }}>
              <div>· 迭代快：哪里别扭，说一声就能改</div>
              <div>· 文档和代码同步，不会写着写着对不上</div>
              <div>· 不藏私：所有逻辑都能在仓库里查到</div>
            </div>
          </div>
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card__head">
              <span className="card__title">代价</span>
              <div className="card__actions">
                <Badge kind="warn">重点看这段</Badge>
              </div>
            </div>
            <div className="card__body small" style={{ lineHeight: 1.8 }}>
              <div>
                · <b>它会在没人注意的地方出错</b>，而且错得很自信
              </div>
              <div>· 遇到它没见过的工程结构，判断容易想当然</div>
              <div>· 生成的配置能跑通，不等于在你的板子上跑得对</div>
            </div>
          </div>
        </div>

        <div className="small" style={{ lineHeight: 1.9 }}>
          <div className="bold mb-8">最可能出错的三个地方</div>
          <div>
            · 芯片型号 / OpenOCD target 判错 → 调试连不上，或者连到了不该连的核
          </div>
          <div>· 工具链没探测到 → 构建任务报「找不到 arm-none-eabi-gcc」</div>
          <div>· 不是 STM32、也不用 CubeMX 的工程，按「通用 CMake」兜底，细节未必贴合</div>
        </div>

        <div className="alert alert--accent" style={{ marginTop: 14, marginBottom: 0 }}>
          <span className="alert__icon">🛡</span>
          <div>
            三条自保：<b>①</b> 写入前看差异预览，别闭眼点确认；<b>②</b>{' '}
            勾上「写入前备份原文件」；<b>③</b> 新工程第一次用，先确认它在 git 里或者有副本。
            真出问题，把「关于与版本」那一页的信息贴到 GitHub Issues。
          </div>
        </div>
      </>
    )
  },
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
    subtitle: '分四组：工程 = 这一个工程本身；配置 = 它生成的配置；扩展 = 往工程里装东西；系统 = 应用与机器',
    body: (
      <div className="onboard-table">
        {[
          ['工程 · 配置调试文件', '★ 选工程、看检测结果、写入配置', '每天都会用到'],
          ['工程 · 检查与清理', '体检 + 一键修复（工程改名、陈旧产物…）', '配置写坏了、或者觉得哪儿不对'],
          ['工程 · 源文件管理', '图形化改 CMakeLists.txt 的源文件列表', '有 .c 文件没被编译进去时'],
          ['工程 · 构建与烧录', '不离开工具就能编译、烧录、看实时日志', '想在这儿一键烧录时'],
          ['配置 · VSCode 配置', '四个 JSON 的可视化编辑（launch / tasks / settings / cpp）', '要手改某个具体字段时'],
          ['配置 · 探针与芯片', 'device、适配器速度、SVD、Live Watch', '换调试器、或者调试连不上时'],
          ['配置 · 模板', '整套配置存下来，套到别的工程', '好几个工程想用同一套配置'],
          ['扩展 · 模块包', '目前是 VOFA+ 在线调参', '要在板子跑着的时候调 PID'],
          ['系统 · 工具链与路径', '探测到的工具、手动指定路径', '换电脑、或工具没探测到时'],
          ['系统 · 历史与恢复', '做过什么 + 每条都能再来一次 + 快照还原', '想「把那个工程照上次再配一遍」'],
          ['关于与版本', '版本号、运行环境、数据目录、检查更新', '反馈问题时来']
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
