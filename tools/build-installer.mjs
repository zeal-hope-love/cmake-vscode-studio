/**
 * 构建自定义安装器。
 *
 *   1. 用 electron-builder --dir 打出 win-unpacked（应用本体）
 *   2. 把 installer/src 编译成 JS
 *   3. 组装安装器的独立 Electron 应用（自己的 main/preload/renderer + payload）
 *   4. 用 electron-builder 把它打成单文件 exe
 *
 * 产物：release/CmakeVscodeStudio-<ver>-setup.exe
 *
 * 为什么要自己组装而不是用 electron-builder 的 nsis：
 * NSIS 是老式 Win32 对话框，字体点阵化、不支持高 DPI，中文尤其糊。
 * Electron 本身就是 Chromium，用它渲染安装界面就是高清网页。
 */

import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
/*
 * 暂存目录可以用环境变量换个地方。
 *
 * 平时用默认的 .installer-build 就行；但那个目录每次都要整棵删掉重来，
 * 万一里面有文件被别的进程占着（杀软扫描、同步盘、上一次打包崩在中途），
 * 删除会 EBUSY，整条流水线直接挂在这一步 —— 这时换个干净目录就能继续：
 *
 *   CVSTUDIO_STAGING=.installer-build2 npm run dist:setup
 */
const staging = process.env.CVSTUDIO_STAGING
  ? resolve(root, process.env.CVSTUDIO_STAGING)
  : join(root, '.installer-build')
/*
 * 应用本体目录（要被打进安装包的那份）。
 *
 * 默认是 release/win-unpacked，但它**经常删不掉**：OneDrive 把桌面重定向成
 * 同步目录，`resources/app.asar` 会被同步进程或杀软短暂独占，于是 electron-builder
 * 既没法重打、也没法 `trash` 旧目录，整条流水线在第一步就断。
 *
 * 这时换个输出目录打一遍，再把这里指过去就行：
 *
 *   npx electron-builder --win --dir -c.directories.output=release-203
 *   CVSTUDIO_UNPACKED=release-203/win-unpacked npm run dist:setup
 */
const unpacked = process.env.CVSTUDIO_UNPACKED
  ? resolve(root, process.env.CVSTUDIO_UNPACKED)
  : join(root, 'release', 'win-unpacked')

function step(msg) {
  console.log(`\n[installer] ${msg}`)
}

// ---------------------------------------------------------------------------

step(`构建 ${pkg.productName} v${pkg.version} 应用本体`)
if (!existsSync(join(unpacked, `${pkg.productName}.exe`))) {
  execFileSync('npx', ['electron-builder', '--win', '--dir'], {
    cwd: root,
    stdio: 'inherit',
    shell: true
  })
} else {
  console.log(`  复用已有的 ${unpacked}`)
}

step('清空暂存目录')
rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'app', 'payload'), { recursive: true })

step('编译安装器主进程 / preload')
await build({
  entryPoints: [join(root, 'installer/src/main.ts')],
  outfile: join(staging, 'app', 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'warning'
})
await build({
  entryPoints: [join(root, 'installer/src/preload.ts')],
  outfile: join(staging, 'app', 'preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'warning'
})

step('复制界面与元信息')
cpSync(join(root, 'installer/src/renderer'), join(staging, 'app', 'renderer'), {
  recursive: true
})
copyFileSync(join(root, 'resources/icon.png'), join(staging, 'app', 'icon.png'))
// 界面里 <img src="icon.png"> 要相对于 index.html 找，所以也放一份到 renderer/
copyFileSync(join(root, 'resources/icon.png'), join(staging, 'app', 'renderer', 'icon.png'))

writeFileSync(
  join(staging, 'app', 'meta.json'),
  JSON.stringify(
    {
      version: pkg.version,
      productName: pkg.productName,
      executableName: `${pkg.productName}.exe`
    },
    null,
    2
  ),
  'utf8'
)

writeFileSync(
  join(staging, 'package.json'),
  JSON.stringify(
    {
      name: 'cv-studio-setup',
      version: pkg.version,
      description: `${pkg.productName} 安装器`,
      main: 'app/main.js',
      author: pkg.author,
      devDependencies: {}
    },
    null,
    2
  ),
  'utf8'
)

/**
 * 把应用本体裁一遍再放进 payload/。
 *
 * Electron 的发行包里有大量**这个应用根本用不到**的东西：
 *   locales/*.pak            55 种语言，48 MB —— 我们只出中文版
 *   dxcompiler.dll           25 MB —— DirectX shader 编译器，GPU 加速才用
 *   LICENSES.chromium.html   20 MB —— 许可证全文，安装包里没必要带
 *   vk_swiftshader.dll        5 MB —— 软件 Vulkan 渲染，只有没显卡时才回退
 *   d3dcompiler_47.dll        5 MB —— 同上，D3D 兼容层
 *   chrome_200_percent.pak    1 MB —— 200% 缩放的资源，我们有高 DPI 处理
 *
 * 裁完从 369 MB 降到 265 MB 左右，压缩后安装包小一大截。
 *
 * 注意**不能裁**的：
 *   resources.pak / icudtl.dat / ffmpeg.dll / chrome_100_percent.pak
 *   —— 这些是 Chromium 运行时必需文件，删了就起不来。
 */
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak'])

function trimPayload(srcDir, dstDir) {
  let savedBytes = 0
  const removed = []

  /** 这些文件/目录直接从安装包里排除（相对路径） */
  const excludeFiles = new Set([
    'LICENSES.chromium.html',
    'dxcompiler.dll',
    'dxil.dll',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'd3dcompiler_47.dll',
    'chrome_200_percent.pak'
  ])

  const walk = (rel) => {
    const srcAbs = join(srcDir, rel)
    const st = statSync(srcAbs)
    const name = rel.split(/[\\/]/).pop() ?? rel

    if (st.isDirectory()) {
      // locales 只留中文和英文
      if (rel === 'locales') {
        mkdirSync(join(dstDir, rel), { recursive: true })
        for (const f of readdirSync(srcAbs)) {
          if (KEEP_LOCALES.has(f)) {
            copyFileSync(join(srcAbs, f), join(dstDir, rel, f))
          } else {
            savedBytes += statSync(join(srcAbs, f)).size
            removed.push(rel + '/' + f)
          }
        }
        return
      }
      mkdirSync(join(dstDir, rel), { recursive: true })
      for (const f of readdirSync(srcAbs)) walk(rel ? rel + '/' + f : f)
      return
    }

    if (excludeFiles.has(name)) {
      savedBytes += st.size
      removed.push(rel)
      return
    }

    copyFileSync(srcAbs, join(dstDir, rel))
  }

  mkdirSync(dstDir, { recursive: true })
  for (const f of readdirSync(srcDir)) walk(f)
  return { savedBytes, removed }
}

step('把应用本体裁完放进 payload/')
const trimDir = join(staging, 'trimmed')
const trim = trimPayload(unpacked, trimDir)
console.log(
  `  裁掉 ${trim.removed.length} 个文件，省 ${(trim.savedBytes / 1024 / 1024).toFixed(1)} MB`
)

step('把裁剪后的内容放进 payload/（不压缩，启动快）')
/*
 * 直接把裁剪后的目录搬进 payload/。
 *
 * 试过压成 tar.gz（能省 30 MB），但安装时要先解压 265 MB，
 * 多花十几秒 —— 用户明确说「太占空间也没事」，那就走快的路子。
 */
const trimmedDir = join(staging, 'trimmed')
cpSync(trimmedDir, join(staging, 'app', 'payload'), { recursive: true })
rmSync(trimmedDir, { recursive: true, force: true })

/*
 * 给安装器自己打一份 portable exe。
 *
 * 为什么用 portable 而不是再套一层 NSIS：portable 目标产出的就是
 * 「解压到临时目录然后运行」的自解压 exe，天然适合做安装器外壳 ——
 * 用户双击后解出安装器并跑起来，界面由我们自己用 Electron 渲染。
 *
 * 注意不要把安装器本身也做成 nsis：那正是要替换掉的老式向导。
 */
step('打包安装器 exe（portable 外壳）')
/*
 * 中间产物（安装器外壳的 win-unpacked、块映射文件等）也放进暂存目录。
 *
 * 以前放在 release/installer，好处是能翻出来看，坏处是下一次打包要先把它删干净 ——
 * 而那个目录里的 app.asar 一旦被别的进程占住（杀软、同步盘），删除就 EBUSY，
 * 打包会在最后一步无谓地失败。暂存目录本来就是一次性的，放这儿最省事。
 */
const installerOut = join(staging, 'out')

/*
 * 用**配置文件**而不是命令行参数。
 *
 * 踩过：`--config.productName CV Studio Setup` 会被 shell 拆成
 * `CV`、`Studio`、`Setup` 三个参数，electron-builder 报
 * "Unknown arguments: Studio, Setup"。任何带空格的值都得写进 yml。
 */
const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version

const setupConfig = join(staging, 'builder.yml')
writeFileSync(
  setupConfig,
  [
    'appId: com.poxia.cvstudio.setup',
    'productName: CV Studio Setup',
    'directories:',
    `  output: ${installerOut.replace(/\\/g, '/')}`,
    'win:',
    '  target: portable',
    `  icon: ${join(root, 'resources', 'icon.ico').replace(/\\/g, '/')}`,
    'portable:',
    `  artifactName: CmakeVscodeStudio-${pkg.version}-setup.\${ext}`,
    'compression: maximum',
    /*
     * 安装器自己的运行时也裁 —— 它只渲染一个界面，
     * 不需要 55 种语言、不需要 DirectX shader 编译器、不需要 Vulkan 软渲染。
     */
    'electronLanguages:',
    '  - zh-CN',
    '  - en-US',
    `electronVersion: ${electronVersion}`,
    'npmRebuild: false',
    `afterPack: ${join(root, 'tools', 'trim-setup.cjs').replace(/\\/g, '/')}`,
    /*
     * payload 是 265 MB 的完整 Electron 应用（含 235 MB 主程序），
     * **不能塞进 asar** —— asar 启动时要建索引，这么大的包会让
     * 安装器窗口黑屏好几秒。用 extraResources 放到 asar 外面。
     */
    'files:',
    '  - app/main.js',
    '  - app/preload.js',
    '  - app/renderer/**',
    '  - app/meta.json',
    '  - app/icon.png',
    '  - package.json',
    'extraResources:',
    '  - from: app/payload',
    '    to: payload'
  ].join('\n'),
  'utf8'
)

execFileSync('npx', ['electron-builder', '--config', setupConfig], {
  cwd: staging,
  stdio: 'inherit',
  shell: true
})

step('整理产物')
const produced = join(installerOut, `CmakeVscodeStudio-${pkg.version}-setup.exe`)
const finalExe = join(root, 'release', `CmakeVscodeStudio-${pkg.version}-setup.exe`)
if (existsSync(produced)) {
  copyFileSync(produced, finalExe)
  const sizeMB = (readFileSync(finalExe).length / 1024 / 1024).toFixed(0)
  console.log(`\n[installer] 完成：${finalExe}（${sizeMB} MB）`)
} else {
  throw new Error(`没找到产物：${produced}`)
}