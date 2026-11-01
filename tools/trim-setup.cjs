/**
 * electron-builder 的 afterPack 钩子：裁剪**安装器自己**的 Electron 运行时。
 *
 * 安装器只渲染一个安装界面，用不到这些东西：
 *
 *   dxcompiler.dll / dxil.dll      DirectX shader 编译器，GPU 渲染才用
 *   vk_swiftshader.dll             软件 Vulkan 渲染，没显卡时才回退
 *   d3dcompiler_47.dll             D3D 兼容层
 *   LICENSES.chromium.html         许可证全文，20 MB
 *   chrome_200_percent.pak         200% 缩放的资源
 *
 * 语言包由 electronLanguages 配置处理，这里不重复管。
 *
 * 删错会导致启动失败，所以只删这份明确的清单，不做「名字匹配」那种猜测。
 */

const { readdirSync, rmSync, statSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')

const TRIM = [
  'dxcompiler.dll',
  'dxil.dll',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'd3dcompiler_47.dll',
  'LICENSES.chromium.html',
  'chrome_200_percent.pak'
]

exports.default = async function afterPack(context) {
  const dir = context.appOutDir
  let saved = 0
  const removed = []

  for (const name of TRIM) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      saved += st.size
      unlinkSync(p)
      removed.push(name)
    } catch {
      /* 不存在就算了，不同 Electron 版本带的文件不完全一样 */
    }
  }

  console.log(
    `[trim-setup] 裁掉 ${removed.length} 个文件，省 ${(saved / 1024 / 1024).toFixed(1)} MB`
  )
}