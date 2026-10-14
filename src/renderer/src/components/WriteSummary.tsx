/**
 * 「写完 VSCode 里多了什么」——按**怎么触发**分三栏 + 一行小字。
 *
 *   ① 运行和调试      F5 / Ctrl+Shift+D
 *   ② 一键：构建+烧录  Ctrl+Shift+B
 *   ③ 其它任务        Ctrl+Shift+P → Tasks: Run Task
 *
 * 这样分类是因为三者是**三种不同的操作习惯**：按 F5 调试、按 Ctrl+Shift+B 烧录、
 * 其余偶尔用的走命令面板。混成一栏就看不出「烧录到底按哪个键」。
 *
 * 每栏里的一条是「标题 + 内容」竖着排（名字一行、按哪个键一行）。
 * 三栏布局里**不用 Kv** —— 它的标题列固定 130px，在窄栏里会把
 * 「烧录并运行 Debug 固件」和「Ctrl+Shift+B · 先跑…」都挤到断行。
 *
 * 内容全部从**真实生成的 bundle** 推导，不写死文案。
 */

import React from 'react'
import type { ConfigBundle } from '@shared/types'
import { Card } from './ui'

function isDefaultTask(group: unknown): boolean {
  return (
    typeof group === 'object' && group !== null && (group as { isDefault?: boolean }).isDefault === true
  )
}

/** 一条：上面是名字（标题），下面是「按哪个键」（内容） */
function Item(props: {
  name: React.ReactNode
  hint: React.ReactNode
  mark?: boolean
}): React.JSX.Element {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="small">
        {props.mark && <span className="accent bold">★ </span>}
        {props.name}
      </div>
      <div className="faint small">{props.hint}</div>
    </div>
  )
}

export function WriteSummary({ bundle }: { bundle: ConfigBundle }): React.JSX.Element {
  const launchConfigs = bundle.launch.configurations
  const tasks = bundle.tasks.tasks
  const defaultTask = tasks.find((t) => isDefaultTask(t.group))
  const otherTasks = tasks.filter((t) => t !== defaultTask)

  return (
    <>
      <div className="grid grid--3">
        <Card title="运行和调试" hint="Ctrl+Shift+D">
          {launchConfigs.length === 0 ? (
            <div className="faint small">没有生成调试配置</div>
          ) : (
            launchConfigs.map((c) => (
              <Item
                key={c.name}
                name={<span className="mono">{c.name}</span>}
                hint={
                  <>
                    按 <kbd>F5</kbd>
                    {typeof c.preLaunchTask === 'string' && c.preLaunchTask
                      ? ` · 先跑「${c.preLaunchTask}」`
                      : ''}
                  </>
                }
              />
            ))
          )}
        </Card>

        <Card title="一键：构建 + 烧录" hint="Ctrl+Shift+B">
          {defaultTask ? (
            <>
              <Item
                mark
                name={defaultTask.label}
                hint={
                  <>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>
                    {Array.isArray(defaultTask.dependsOn) && defaultTask.dependsOn.length
                      ? ` · 先跑「${defaultTask.dependsOn.join('、')}」`
                      : ''}
                  </>
                }
              />
              <div className="faint small">
                它是默认生成任务，所以按 Ctrl+Shift+B 就是「构建 → 烧录 → 运行」，全程不挂调试器。
              </div>
            </>
          ) : (
            <div className="faint small">没有默认生成任务</div>
          )}
        </Card>

        <Card title="其它任务" hint="Ctrl+Shift+P">
          {otherTasks.length === 0 ? (
            <div className="faint small">没有其它任务</div>
          ) : (
            <div className="small" style={{ lineHeight: 1.9, marginBottom: 6 }}>
              {otherTasks.map((t) => (
                <div key={t.label}>· {t.label}</div>
              ))}
            </div>
          )}
          <div className="faint small">
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → 输入{' '}
            <span className="mono">Tasks: Run Task</span> 挑
          </div>
        </Card>
      </div>

      {/* 次要信息压到小字里 */}
      <div className="faint small" style={{ marginTop: 8, lineHeight: 1.7 }}>
        另外会更新 <span className="mono">settings.json</span>（OpenOCD 路径、cmake 配置）与{' '}
        <span className="mono">c_cpp_properties.json</span>（代码补全与跳转）。
      </div>
    </>
  )
}
