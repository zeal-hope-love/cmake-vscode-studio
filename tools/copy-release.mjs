/**
 * 把打包产物复制到 **工作区之外** 再交付。
 *
 * 为什么需要：如果这个项目放在 DSH（或类似沙箱工具）的工作区里，工作区目录会被
 * 加上 `Everyone: 拒绝删除子目录和文件` 这样的 ACL。NSIS 自解压（安装版、portable）
 * 在这种目录里运行会异常 —— 表现为「无法关闭」「不能打开要写入的文件」
 * 「Error writing temporary file」等一堆看起来像安装包坏了的错误。
 *
 * 把 exe 复制到一个普通目录再双击就完全正常。这个脚本就是干这件事的。
 *
 * 用法：npm run dist:copy [目标目录]
 *   默认目标：%USERPROFILE%\Desktop\CMakeVSCodeConfigurator-release
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const src = resolve('release')
if (!existsSync(src)) {
  console.error('找不到 release/ —— 先跑 npm run dist:installer')
  process.exit(1)
}

const dest = process.argv[2]
  ? resolve(process.argv[2])
  : join(homedir(), 'Desktop', 'CMakeVSCodeConfigurator-release')

mkdirSync(dest, { recursive: true })

const files = readdirSync(src).filter((f) => /\.(exe|blockmap|yml)$/i.test(f))
if (!files.length) {
  console.error('release/ 里没有可交付的文件')
  process.exit(1)
}

for (const f of files) {
  copyFileSync(join(src, f), join(dest, f))
  console.log('  ' + f)
}

console.log('\n已复制到：' + dest)
console.log('从那个目录双击运行 —— 不要在工作区里直接运行。')
