#!/usr/bin/env node
/**
 * 版本台账 —— 把「内核」类依赖的当前版本和线上最新版摆在一起看。
 *
 * 为什么要单独做这个：应用自身的版本号（2.0.4）只是我们自己改的一个数字，
 * 真正决定「这版跑在什么底座上」的是下面这几层依赖：
 *
 *   Electron          运行时内核（里面装着 Chromium + Node）
 *   electron-builder  打包器 / 安装器引擎（NSIS、绿色版自解压都归它）
 *   electron-vite     构建框架
 *   Vite              dev server 和产物打包
 *   React             界面框架
 *   TypeScript        类型检查
 *
 * 这些不跟着走，会出现「自认为发了新版，用户装的还是两年前的内核」这种事，
 * 而用户是看不出来的 —— 界面上只有我们自己的 2.0.x。
 *
 * 用法：
 *   npm run check:kernels              看表（联网查最新版，约 1 秒）
 *   npm run check:kernels -- --strict  内核 / 打包 / 构建链有大版本落后就退出码 1
 *   npm run check:kernels -- --offline 不联网，只列本机装的
 *   npm run check:kernels -- --json    给脚本吃
 *
 * 打包时 tools/build-installer.mjs 会顺手调一次（只警告不拦截），
 * 不想看就设 CVSTUDIO_SKIP_KERNEL_CHECK=1。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const argv = new Set(process.argv.slice(2))
const OFFLINE = argv.has('--offline')
const STRICT = argv.has('--strict')
const JSON_OUT = argv.has('--json')

// ---------------------------------------------------------------------------
// 分层。strict 只盯前两层 + 构建链：框架和类型定义的补丁版不值得为它单独发版。

const LAYERS = [
  {
    key: 'runtime',
    label: '运行时内核',
    why: '里面装的 Chromium / Node 决定能用的 Web 标准和安全补丁',
    strict: true,
    members: ['electron']
  },
  {
    key: 'packaging',
    label: '打包与安装器',
    why: '生成 exe、安装包、绿色版的那一层；NSIS 也由它带下来',
    strict: true,
    members: ['electron-builder']
  },
  {
    key: 'build',
    label: '构建链',
    why: '这三个的大版本必须一起升，单独升一个必炸',
    strict: true,
    members: ['electron-vite', 'vite', '@vitejs/plugin-react']
  },
  {
    key: 'framework',
    label: '界面框架',
    why: '应用运行时的库，跟着 Electron 走就行',
    strict: false,
    members: ['react', 'react-dom', 'zustand']
  },
  {
    key: 'tooling',
    label: '语言与工具',
    why: '不参与运行时；TypeScript 大版本升级要单独验证',
    strict: false,
    members: ['typescript', 'prettier', '@types/node', '@types/react', '@types/react-dom']
  }
]

const KNOWN = new Set(LAYERS.flatMap((l) => l.members))

// ---------------------------------------------------------------------------
// 小工具

/** 中日韩全角字符在等宽字体里占两格，不算宽度表会歪 */
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
const dw = (s) => {
  let n = 0
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1
  return n
}
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - dw(s)))

function parseVer(v) {
  const m = String(v ?? '').match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

function gap(cur, latest) {
  const a = parseVer(cur)
  const b = parseVer(latest)
  if (!a || !b) return { level: 'unknown', text: '—' }
  if (b.major > a.major) return { level: 'major', text: `大版本 +${b.major - a.major}` }
  if (b.minor > a.minor) return { level: 'minor', text: `小版本 +${b.minor - a.minor}` }
  if (b.patch > a.patch) return { level: 'patch', text: `补丁 +${b.patch - a.patch}` }
  if (a.major === b.major && a.minor === b.minor && a.patch === b.patch)
    return { level: 'ok', text: '最新' }
  return { level: 'ahead', text: '比线上新' }
}

const LEVEL_TAG = {
  ok: '✓',
  ahead: '↑',
  patch: '~',
  minor: '!',
  major: '!!',
  pinned: '=',
  unknown: '?'
}

function installedVersion(name) {
  try {
    const p = join(root, 'node_modules', name, 'package.json')
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')).version
  } catch {
    return null
  }
}

function declaredRange(name) {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? '-'
}

/** 直接问 registry，比 `npm view` 快一个数量级（一次 fetch 400ms 上下） */
async function latestVersion(name) {
  let registry = process.env.npm_config_registry || 'https://registry.npmmirror.com'
  try {
    const rc = readFileSync(join(root, '.npmrc'), 'utf8')
    const m = rc.match(/^registry\s*=\s*(\S+)/m)
    if (m) registry = m[1]
  } catch {
    /* 没有 .npmrc 就用默认 */
  }
  const url = `${registry.replace(/\/+$/, '')}/${encodeURIComponent(name)}/latest`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return body.version ?? null
}

/** NSIS 版本不写在 package.json 里，是 electron-builder 第一次打包时下载到缓存里的 */
function nsisVersion() {
  const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  const cache = join(base, 'electron-builder', 'Cache')
  try {
    const dir = readdirSync(cache).find((d) => d.startsWith('nsis-'))
    return dir ? dir.replace(/^nsis-/, '') : null
  } catch {
    return null
  }
}

/**
 * Electron 真正的「内核」是它肚子里那套 Chromium + Node。
 * 版本号从 releases.electronjs.org 的清单里查（约 2MB，超时就当拿不到）。
 */
async function electronInternals() {
  try {
    const v = readFileSync(join(root, 'node_modules/electron/dist/version'), 'utf8').trim()
    const res = await fetch('https://releases.electronjs.org/releases.json', {
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null
    const list = await res.json()
    const hit = list.find((x) => x.version === v)
    return hit ? { version: v, chrome: hit.chrome, node: hit.node } : { version: v }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const names = [
    ...LAYERS.flatMap((l) => l.members).filter(
      (n) => n in (pkg.devDependencies ?? {}) || n in (pkg.dependencies ?? {})
    ),
    ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) => !KNOWN.has(n))
  ]
  const uniq = [...new Set(names)]

  // 先拿 Electron 肚子里的 Node 版本 —— @types/node 要跟它走，不该盲升到最新
  const internals = OFFLINE ? null : await electronInternals()
  const electronNodeMajor = parseVer(internals?.node)?.major ?? null

  const rows = []
  await Promise.all(
    uniq.map(async (name) => {
      const cur = installedVersion(name)
      let latest = null
      let err = null
      if (!OFFLINE) {
        try {
          latest = await latestVersion(name)
        } catch (e) {
          err = e.message
        }
      }
      let g = gap(cur, latest)
      /*
       * @types/node 的版本号跟着 Node 的**大版本**走，而运行时那个 Node 装在
       * Electron 里（45.2.3 → Node 24）。所以线上 26.x 不是「新」，是「不对」——
       * 升上去会让人以为能用 Node 26 才有的 API，实际一跑就崩。
       */
      if (name === '@types/node' && electronNodeMajor && parseVer(cur)?.major === electronNodeMajor) {
        g = { level: 'pinned', text: `对齐 Node ${electronNodeMajor}` }
      }
      rows.push({
        name,
        layer: LAYERS.find((l) => l.members.includes(name))?.key ?? 'other',
        range: declaredRange(name),
        current: cur,
        latest,
        gap: g,
        error: err
      })
    })
  )
  // Promise.all 按完成顺序 push，这里按声明顺序收回，输出才稳定
  rows.sort((a, b) => uniq.indexOf(a.name) - uniq.indexOf(b.name))

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          app: { version: pkg.version },
          electronInternals: internals,
          nsis: nsisVersion(),
          rows
        },
        null,
        2
      )
    )
    return exitIfStrict(rows)
  }

  const col = (title, w) => pad(title, w)
  console.log('')
  console.log(`  ${pkg.productName} v${pkg.version} —— 底座版本台账`)
  console.log('')
  console.log(
    `  ${col('状态', 6)}${col('部件', 24)}${col('当前', 12)}${col('最新', 12)}${col('差距', 14)}package.json 里写的`
  )
  console.log('  ' + '─'.repeat(78))

  for (const layer of LAYERS) {
    const inLayer = rows
      .filter((r) => r.layer === layer.key)
      .sort((a, b) => layer.members.indexOf(a.name) - layer.members.indexOf(b.name))
    if (!inLayer.length) continue
    console.log(`  ${layer.label} —— ${layer.why}`)
    for (const r of inLayer) {
      const tag = LEVEL_TAG[r.gap.level] ?? '?'
      const cur = r.current ?? '未安装'
      const latest = OFFLINE ? '(离线)' : (r.latest ?? (r.error ? '查询失败' : '—'))
      console.log(
        `  ${pad(tag, 6)}${pad(r.name, 24)}${pad(cur, 12)}${pad(latest, 12)}${pad(r.gap.text, 14)}${
          r.range !== '-' ? r.range : ''
        }`
      )
    }
    console.log('')
  }

  const others = rows.filter((r) => r.layer === 'other')
  if (others.length) {
    console.log('  其他依赖')
    for (const r of others) {
      console.log(
        `  ${pad(LEVEL_TAG[r.gap.level], 6)}${pad(r.name, 24)}${pad(r.current ?? '未安装', 12)}${pad(
          OFFLINE ? '(离线)' : (r.latest ?? '—'),
          12
        )}${pad(r.gap.text, 14)}${r.range}`
      )
    }
    console.log('')
  }

  // 附带的非 npm 部件
  const nsis = nsisVersion()
  const esbuild = installedVersion('esbuild')
  console.log('  附：')
  if (internals?.chrome) {
    console.log(`    Electron 肚里的内核  Chromium ${internals.chrome} / Node ${internals.node}`)
  }
  console.log(`    安装器引擎 NSIS    ${nsis ?? '未下载（第一次打包时拉取）'}（electron-builder 自带）`)
  if (esbuild) console.log(`    安装器打包器        esbuild ${esbuild}（编译 installer/src 用）`)
  console.log(
    `    构建用 Node         ${process.version}（CI 用 22 —— 见 .github/workflows/release.yml）`
  )
  console.log('')

  const behind = rows.filter((r) => !['ok', 'ahead', 'pinned'].includes(r.gap.level))
  if (!behind.length) {
    console.log('  全部是最新版。')
  } else {
    const majors = behind.filter((r) => r.gap.level === 'major')
    const minors = behind.filter((r) => r.gap.level !== 'major')

    if (minors.length) {
      console.log(`  可以顺手升掉（补丁 / 小版本，风险低）：`)
      console.log(`    npm install -D ${minors.map((r) => `${r.name}@latest`).join(' ')}`)
    }
    if (majors.length) {
      console.log('')
      console.log(
        `  大版本落后（要单独一个提交，升完 npm run typecheck && npm run selftest && npm run build）：`
      )
      for (const r of majors) {
        const layer = LAYERS.find((l) => l.key === r.layer)
        console.log(
          `    ${pad(r.name, 24)}${pad(`${r.current} → ${r.latest}`, 22)}${layer?.label ?? '其他'}`
        )
      }
    }
    console.log('')
    console.log('  详细流程见 docs/DEVELOPMENT.md「发版前先过一遍底座」一节。')
  }
  console.log('')
  exitIfStrict(rows)
}

function exitIfStrict(rows) {
  if (!STRICT) return
  const bad = rows.filter((r) => {
    const layer = LAYERS.find((l) => l.key === r.layer)
    return layer?.strict && r.gap.level === 'major'
  })
  if (bad.length) {
    console.error(`  --strict：内核层有大版本落后 —— ${bad.map((b) => b.name).join(', ')}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[check-kernels] 失败：', e.message)
  process.exit(2)
})
