/**
 * 命令行版的「检测一个工程」—— 用来看工具到底读到了什么。
 *
 *   npm run scan -- "C:\Users\someone\proj\my-firmware"
 *
 * 排查「为什么工具显示的是 X 而不是 Y」时，直接跑这个比开界面点半天快。
 */

import { scanProject } from '../src/main/services/scanner'
import { detectTools } from '../src/main/services/toolDetector'
import { defaultGenOptions, generateBundle } from '../src/main/services/generators'
import { DEFAULT_SETTINGS } from '@shared/types'

const target = process.argv[2]
if (!target) {
  console.error('用法: npm run scan -- <工程路径>')
  process.exit(1)
}

const project = scanProject(target)
const tools = detectTools({}, false)
const options = defaultGenOptions(project, tools, DEFAULT_SETTINGS)
const bundle = generateBundle(project, options)

console.log('='.repeat(72))
console.log(`工程根      : ${project.root}`)
console.log(`工程名      : ${project.name}`)
console.log(`CMake 目标  : ${project.targets.map((t) => `${t.name}[${t.kind}]`).join(', ') || '—'}`)
console.log(`CMake 工程名: ${project.cmakeProjectName ?? '—'}`)
console.log('')
console.log(`固件名      : ${project.elfName}`)
console.log(`  来源      : ${project.elfSource}`)
console.log(`  可信度    : ${project.elfNameConfidence}`)
console.log('')
console.log(`芯片        : ${project.device ?? '—'}`)

console.log('\n构建目录:')
for (const bd of project.buildDirs) {
  console.log(
    `  ${bd.name.padEnd(10)} 产物=[${bd.artifacts.map((a) => a.split(/[\\/]/).pop()).join(', ') || '无'}]`
  )
}

console.log('\n解析到的 include:')
for (const d of project.includeDirs) console.log(`  ${d}`)

if (project.warnings.length) {
  console.log('\n警告:')
  for (const w of project.warnings) console.log(`  ⚠ ${w}`)
}
if (project.notes.length) {
  console.log('\n提示:')
  for (const n of project.notes) console.log(`  · ${n}`)
}

console.log('\n将要写入的内容:')
console.log(`  launch.json 配置名     : ${bundle.launch.configurations.map((c) => c.name).join(' | ')}`)
if (bundle.launch.configurations[0]) {
  const first = bundle.launch.configurations[0] as Record<string, unknown>
  console.log(`  第一条的 executable    : ${String(first.executable ?? '—')}`)
  console.log(`  第一条的 device        : ${String(first.device ?? '—')}`)
}
console.log(`  compileCommands        : ${options.compileCommands}`)
console.log(`  svdFile                : ${options.svdFile || '—'}`)
console.log(`  openocd 接线配置       : ${bundle.openocdCfg?.fileName ?? '（不需要）'}`)
console.log(`  tasks 数量             : ${bundle.tasks.tasks.length}`)
console.log('='.repeat(72))
