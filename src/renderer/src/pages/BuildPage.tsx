/**
 * 构建与烧录页：不离开这个工具就能把工程 configure / build / 烧进芯片，日志实时回显。
 */

import React from 'react'
import { useStudio } from '../state/store'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  PageBody,
  PageHeader,
  Select,
  TextInput
} from '../components/ui'
import { Icons } from '../components/icons'

type Variant = 'Debug' | 'Release'

export default function BuildPage(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const options = useStudio((s) => s.options)
  const bundle = useStudio((s) => s.bundle)
  const logLines = useStudio((s) => s.logLines)
  const clearLog = useStudio((s) => s.clearLog)
  const startRun = useStudio((s) => s.startRun)
  const cancelRun = useStudio((s) => s.cancelRun)
  const activeRunId = useStudio((s) => s.activeRunId)

  const [variant, setVariant] = React.useState<Variant>('Debug')
  const [usePreset, setUsePreset] = React.useState(true)
  const [customCommand, setCustomCommand] = React.useState('')
  const [customArgs, setCustomArgs] = React.useState('')
  const [autoScroll, setAutoScroll] = React.useState(true)
  const logRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setUsePreset(Boolean(options?.hasBuildPresets))
  }, [options?.hasBuildPresets])

  React.useEffect(() => {
    if (!autoScroll) return
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logLines, autoScroll])

  if (!project || !options || !bundle) {
    return (
      <>
        <PageHeader title="构建与烧录" />
        <PageBody>
          <EmptyState title="请先载入工程" />
        </PageBody>
      </>
    )
  }

  const cwd = project.root
  const preset = variant === 'Debug' ? options.debugPreset : options.releasePreset
  const buildDir = variant === 'Debug' ? options.debugDir : options.releaseDir
  const cmake = options.cmakeExe || 'cmake'

  const run = (title: string, command: string, args: string[]): void => {
    void startRun(title, command, args, cwd)
  }

  const doConfigure = (): void => {
    if (usePreset) {
      run(`配置 CMake（${preset}）`, cmake, ['--preset', preset])
    } else {
      const args = ['-S', '.', '-B', buildDir]
      if (options.generator) args.push('-G', options.generator)
      args.push(`-DCMAKE_BUILD_TYPE=${variant}`)
      run(`配置 CMake（${variant}）`, cmake, args)
    }
  }

  const doBuild = (): void => {
    const args = usePreset ? ['--build', '--preset', preset] : ['--build', buildDir]
    run(`构建 ${variant}`, cmake, args)
  }

  const doClean = (): void => {
    run(`清理 ${variant}`, cmake, ['--build', buildDir, '--target', 'clean'])
  }

  const flashCfg = bundle.openocdCfg
  const openocd = options.openocdExe || 'openocd'
  const cfgPath = flashCfg ? `${cwd}\\.vscode\\${flashCfg.fileName}` : ''
  const elfRel = `${buildDir}/${options.elfName}.elf`
  const elfAbs = `${cwd}\\${elfRel.replace(/\//g, '\\')}`

  const doFlash = (): void => {
    if (!flashCfg) return
    run(`烧录并运行 ${variant} 固件`, openocd, [
      '-f',
      cfgPath,
      '-c',
      `program ${elfRel} verify reset exit`
    ])
  }

  const doErase = (): void => {
    if (!flashCfg) return
    run('擦除芯片', openocd, [
      '-f',
      cfgPath,
      '-c',
      'init; reset halt; flash erase_sector 0 0 last; reset run; exit'
    ])
  }

  const doReset = (): void => {
    if (!flashCfg) return
    run('复位并运行', openocd, ['-f', cfgPath, '-c', 'init; reset run; exit'])
  }

  return (
    <>
      <PageHeader
        title="构建与烧录"
        subtitle={`工作目录：${cwd}`}
        actions={
          <>
            <Button size="sm" onClick={() => void window.api.openInVSCode(cwd)}>
              <Icons.vscode />在 VSCode 打开
            </Button>
            <Button size="sm" variant="danger" disabled={!activeRunId} onClick={() => void cancelRun()}>
              停止当前命令
            </Button>
          </>
        }
      />

      <PageBody>
        {!options.cmakeExe && (
          <Alert kind="warn">
            没有探测到 CMake 可执行文件，将直接调用 <span className="mono">cmake</span>（依赖 PATH）。
            可以到「工具与路径」页手动指定。
          </Alert>
        )}

        <div className="grid grid--2">
          {/* ---- 构建 ---- */}
          <Card title="构建" hint="调用 CMake，和 VSCode 里的构建是同一件事">
            <div className="row mb-12">
              <Field label="目标配置" style={{ flex: 1 }}>
                <Select
                  value={variant}
                  onChange={(e) => setVariant(e.target.value as Variant)}
                  options={[
                    { value: 'Debug', label: `Debug（${options.debugPreset}）` },
                    { value: 'Release', label: `Release（${options.releasePreset}）` }
                  ]}
                />
              </Field>
            </div>

            <Checkbox
              checked={usePreset}
              onChange={setUsePreset}
              label={
                options.hasBuildPresets
                  ? `使用 preset（cmake --build --preset ${preset}）`
                  : '工程没有 buildPresets，只能用目录方式'
              }
            />

            <div className="divider" />

            <div className="flex flex-wrap">
              <Button onClick={doConfigure} disabled={Boolean(activeRunId)}>
                配置（configure）
              </Button>
              <Button variant="primary" onClick={doBuild} disabled={Boolean(activeRunId)}>
                构建（build）
              </Button>
              <Button onClick={doClean} disabled={Boolean(activeRunId)}>
                清理
              </Button>
            </div>

            <div className="small faint mt-12">
              构建目录：<span className="mono">{buildDir}</span>
              {options.hasBuildPresets ? (
                <Badge kind="ok">支持 preset</Badge>
              ) : (
                <Badge kind="warn">无 buildPresets</Badge>
              )}
            </div>
          </Card>

          {/* ---- 烧录 ---- */}
          <Card title="烧录" hint="通过 OpenOCD 把 ELF 写进芯片">
            {!flashCfg ? (
              <Alert kind="warn">
                当前探针（{bundle.openocdCfg ? '' : options.probeKey}）不需要 OpenOCD
                接线配置，因此没有生成烧录命令。
                <div className="mt-8 small">
                  想用 OpenOCD 烧录的话，到「工具与路径」页把探针改成 「CMSIS-DAP / ST-Link / J-Link（走
                  OpenOCD）」。
                </div>
              </Alert>
            ) : (
              <>
                <div className="kv mb-12">
                  <div className="kv__k">接线配置</div>
                  <div className="kv__v">{flashCfg.fileName}</div>
                  <div className="kv__k">OpenOCD</div>
                  <div className="kv__v">{options.openocdExe || 'openocd（PATH）'}</div>
                  <div className="kv__k">固件</div>
                  <div className="kv__v">{elfAbs}</div>
                </div>

                <div className="flex flex-wrap">
                  <Button variant="primary" onClick={doFlash} disabled={Boolean(activeRunId)}>
                    烧录并运行
                  </Button>
                  <Button onClick={doReset} disabled={Boolean(activeRunId)}>
                    仅复位运行
                  </Button>
                  <Button variant="danger" onClick={doErase} disabled={Boolean(activeRunId)}>
                    擦除芯片
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>

        {/* ---- 自定义命令 ---- */}
        <Card title="自定义命令" hint="想跑什么就跑什么，工作目录固定在工程根">
          <div className="row">
            <div style={{ flex: 1 }}>
              <Field label="命令">
                <TextInput
                  mono
                  value={customCommand}
                  placeholder="例如 ninja 或 arm-none-eabi-size"
                  onChange={(e) => setCustomCommand(e.target.value)}
                />
              </Field>
            </div>
            <div style={{ flex: 2 }}>
              <Field label="参数（空格分隔，含空格的片段用双引号包起来）">
                <TextInput
                  mono
                  value={customArgs}
                  placeholder="例如 -C build\Debug"
                  onChange={(e) => setCustomArgs(e.target.value)}
                />
              </Field>
            </div>
            <Button
              disabled={!customCommand.trim() || Boolean(activeRunId)}
              onClick={() => run('自定义命令', customCommand.trim(), parseArgs(customArgs))}
            >
              运行
            </Button>
          </div>
        </Card>

        {/* ---- 日志 ---- */}
        <Card
          title="输出"
          hint={`${logLines.length} 行`}
          actions={
            <>
              <Checkbox checked={autoScroll} onChange={setAutoScroll} label="自动滚动" />
              <Button size="sm" variant="ghost" onClick={clearLog} disabled={!logLines.length}>
                清空
              </Button>
            </>
          }
        >
          <div className="log" ref={logRef}>
            {logLines.length === 0 ? (
              <span className="faint">（还没有输出。点上面的构建 / 烧录按钮开始。）</span>
            ) : (
              logLines.map((line) => (
                <span
                  key={line.id}
                  className={
                    line.stream === 'stderr'
                      ? 'log__line--stderr'
                      : line.stream === 'system'
                        ? 'log__line--system'
                        : line.stream === 'ok'
                          ? 'log__line--ok'
                          : undefined
                  }
                >
                  {line.text}
                </span>
              ))
            )}
          </div>
        </Card>
      </PageBody>
    </>
  )
}

/** 简易命令行分词：支持双引号包住带空格的参数 */
function parseArgs(text: string): string[] {
  const out: string[] = []
  let buf = ''
  let inQuotes = false
  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (/\s/.test(ch) && !inQuotes) {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}
