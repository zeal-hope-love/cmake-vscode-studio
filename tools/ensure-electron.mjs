/**
 * npm postinstall 兜底：确保 Electron 的二进制真的下载下来了。
 *
 * 背景：在国内网络下 Electron 自带的 postinstall 经常拿不到 GitHub 上的包，
 * 表现是 `npm install` 秒完成、但 `node_modules/electron/dist/electron.exe`
 * 并不存在。这里检查一次，缺了就按 npmmirror 镜像补下。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'

function log(msg) {
  console.log(`[ensure-electron] ${msg}`)
}

try {
  const require = createRequire(import.meta.url)
  const electronDir = path.dirname(require.resolve('electron/package.json'))
  const distExe = path.join(electronDir, 'dist', 'electron.exe')

  if (existsSync(distExe)) {
    log('electron.exe 已就绪')
    process.exit(0)
  }

  const installScript = path.join(electronDir, 'install.js')
  if (!existsSync(installScript)) {
    log('找不到 electron/install.js，跳过（请手动检查 electron 安装）')
    process.exit(0)
  }

  log(`缺少 electron.exe，正在从镜像下载: ${MIRROR}`)

  const env = { ...process.env, ELECTRON_MIRROR: MIRROR, ELECTRON_CUSTOM_DIR: '{{ version }}' }
  // 这两个变量会把 electron 变成纯 Node 或破坏下载 URL，必须清掉
  delete env.ELECTRON_CUSTOM_FILENAME
  delete env.ELECTRON_RUN_AS_NODE

  execFileSync(process.execPath, ['install.js'], { cwd: electronDir, stdio: 'inherit', env })

  log(existsSync(distExe) ? '下载完成 ✓' : '下载后仍未找到 electron.exe，请检查网络')
} catch (err) {
  log(`跳过（不影响主流程）: ${err instanceof Error ? err.message : String(err)}`)
}
