/**
 * 极简 JSON 持久化：设置、模板、快照都用它。
 * 数据放在 Electron 的 userData 目录，不污染用户工程。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * 历史上用过的数据目录名，**由新到旧**排列。
 *
 * 背景：Electron 的 `app.getName()` 优先取 `productName`，而 userData 目录名就是它。
 * 名字改过几次，每次都会换一个数据目录 —— 这里负责把老目录的数据搬过来，
 * 别让用户的设置、模板、快照凭空消失。
 *
 * | 时期 | 目录名 | 原因 |
 * |---|---|---|
 * | 最早 | `cmake-vscode-studio` | 当时 package.json 只有 `name` |
 * | v1.x | `CMake-VSCode-Configurator` | 补了 `productName`，让 exe 属性和界面一致 |
 * | v2 起 | `CV Studio` | 改名（当前，即 `app.getPath('userData')`） |
 *
 * 顺序很重要：**新的排前面**。迁移时从最近的旧目录开始找，找到有数据的那一个就搬，
 * 这样连续改过两轮名字的用户也能一次搬到位。
 */
const LEGACY_DIR_NAMES = ['CMake-VSCode-Configurator', 'cmake-vscode-studio']

/** 我们自己的东西；只搬这几个，不碰 Electron 的缓存目录 */
const OUR_ITEMS = ['settings.json', 'templates.json', 'snapshots', 'history.json']

let cachedDir: string | null = null

function resolveUserDataDir(): string {
  const target = app.getPath('userData')
  const appData = app.getPath('appData')

  // 当前目录里已有我们自己的文件 → 说明已经在用了，不用搬。
  // 注意：不能用「target 目录是否存在」来判断 —— Electron 启动时会先把 userData
  // 目录建出来（还有它自己的一堆缓存子目录），所以那个判断永远为真、迁移永远不执行。
  if (existsSync(join(target, 'settings.json'))) return target

  // 按「由新到旧」找第一个有数据的旧目录
  for (const name of LEGACY_DIR_NAMES) {
    const legacy = join(appData, name)
    if (legacy.toLowerCase() === target.toLowerCase()) continue
    if (!existsSync(join(legacy, 'settings.json'))) continue

    try {
      mkdirSync(target, { recursive: true })
      for (const item of OUR_ITEMS) {
        const from = join(legacy, item)
        if (!existsSync(from)) continue
        cpSync(from, join(target, item), { recursive: true, force: true })
      }
      return target
    } catch {
      // 迁移失败就继续用那个老目录 —— 宁可不一致，也不能让用户丢设置
      return legacy
    }
  }

  return target
}

export function userDataPath(...parts: string[]): string {
  if (!cachedDir) cachedDir = resolveUserDataDir()
  return join(cachedDir, ...parts)
}

/** 当前实际使用的数据目录（「关于」里展示用） */
export function currentUserDataDir(): string {
  return userDataPath()
}

export function readStoreFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

/**
 * 同步睡眠 N 毫秒。
 *
 * 用 `Atomics.wait` 而不是 `while (Date.now() < until) {}` 忙等 —— 这是关键区别：
 *
 * 忙等会**一直占着 CPU**，在 Electron 主进程里意味着：
 *   · 事件循环被完全堵住，其它 IO 回调排队等着
 *   · 这正是我们要等的那些子进程（写缓存、写配置的）也被拖慢
 *   → 冲突窗口反而被拉长，形成「越等越失败」的死循环
 *
 * `Atomics.wait` 会让当前线程真正挂起，把 CPU 让出去，让锁的持有者有机会释放。
 * 它只能用在非主线程？—— 不是，`Atomics.wait` 在这里可用是因为 Electron
 * 主进程的 JS 线程允许它（Node 环境下 `Atomics.wait` 在非 `SharedArrayBuffer`
 * 场景下同样会阻塞而不是抛错）。
 */
function sleepMs(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  } catch {
    // 极少数环境不让用 Atomics.wait，退回忙等（不理想但能工作）
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* fallback */
    }
  }
}

/**
 * 写 JSON 到数据目录。
 *
 * ## 为什么这里不用「临时文件 + 原子改名」
 *
 * 看起来那是标准做法，但**在 Windows 上会失败**：目标文件只要被任何句柄打开着
 * （哪怕只是只读），`renameSync` 覆盖它就抛 `EPERM`。实测过，见下。
 *
 * 而 `writeFileSync` 直接覆盖反而更容易成功 —— 因为读锁并不阻止写。
 * 所以这里走「直接覆盖 + 退避重试」。
 *
 * ## 谁在占这个文件
 *
 * dev 模式下主进程、渲染进程、以及 Electron 自己的 GPU/utility 子进程会并发
 * 碰 `settings.json`。撞上时原来是一次就抛，用户看到
 *   Error invoking remote method 'window:setTheme': EPERM: operation not permitted
 * 完全不知道该干什么。
 *
 * ## 重试参数是怎么定的
 *
 * 一开始是 5 次、20→40→80→160ms（总共约 0.3s），**实测不够** ——
 * Electron 启动瞬间几个子进程一起碰这个文件，冲突窗口能到 1 秒以上。
 * 实测复现：打包版一启动就报 EPERM，但事后单独检查文件完全可写。
 *
 * 现在改成 8 次、最长 200ms 间隔，总共约 1.1 秒。
 *
 * 为什么敢等这么久：这个函数只在「改设置」时调用（切主题、改工具路径），
 * 不是热路径。用户点一下等 1 秒可以接受，弹一个看不懂的 EPERM 不可接受。
 *
 * 为什么用忙等而不是 await：函数是同步签名，调用方遍布各处，
 * 改成 async 要传染一整套调用链。这里等的是文件句柄释放，
 * 忙等 1 秒对主进程的影响可以忽略（本来也在等 IO）。
 */
export function writeStoreFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const text = JSON.stringify(value, null, 2)

  /**
   * 退避间隔（毫秒）。
   *
   * 从 10ms 起步、上限 200ms，总等待约 0.9 秒。
   * 定这么多轮是因为实测：Electron 启动瞬间几个子进程（GPU、网络、渲染）
   * 会同时初始化各自的缓存目录，`settings.json` 的冲突窗口能持续到 1 秒。
   */
  const backoff = [10, 20, 40, 80, 160, 200, 200, 200]
  let lastErr: unknown = null

  for (let i = 0; i <= backoff.length; i++) {
    try {
      writeFileSync(filePath, text, 'utf8')
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      // 只有「文件被占用 / 没权限」这类才值得重试；其它错误立刻抛
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
      if (i >= backoff.length) break
      sleepMs(backoff[i])
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(
    `写不进去：${filePath}\n${msg}\n` +
      `常见原因：同时开着两个窗口（dev 模式 + 安装版），或杀毒软件正在扫描这个文件。` +
      `先关掉多余的窗口再试。`
  )
}
