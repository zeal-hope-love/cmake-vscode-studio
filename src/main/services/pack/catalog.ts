/**
 * packs 目录的定位，以及把 `packs/<id>/pack.json` 读成 PackManifest。
 *
 * 只读磁盘、不碰工程。**「这个包装到你的工程上行不行」不在这里** ——
 * 那是 `compat.ts` 的事，两者分开是为了加新包时不用改这里。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PackManifest } from '@shared/packTypes'

/**
 * packs 放哪。
 * 打包后走 extraResources 复制到 resources/packs；开发时就是仓库根的 packs/。
 * 两者内容一样，所以开发时看到的和用户装到的完全一致。
 */
export function packsDir(): string {
  // packs 的位置随运行方式变，所以按顺序试几个候选，第一个存在的就用：
  //   · 打包后：进程里 __dirname 是 <app>/resources/app.asar/out/main，
  //     packs 在 asar 外面（extraResources → resources/packs）
  //   · 开发时：__dirname 是 <repo>/out/main，packs 在仓库根
  //   · 自检运行器：它把 TS 打包成仓库根的一个 .cjs，__dirname 就是仓库根
  // 刻意**不问** electron 的 app.isPackaged —— 自检是纯 Node，压根没有 electron。
  const candidates: string[] = []
  // 注意：纯 Node 下 process.resourcesPath 是 undefined，join('', 'packs') 会得到
  // 相对路径 "packs" —— 靠当前目录侥幸命中，换个工作目录就废。所以先判空再加。
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'packs'))
  candidates.push(
    join(__dirname, '../../packs'),
    join(__dirname, 'packs'),
    join(__dirname, '../packs'),
    join(process.cwd(), 'packs')
  )
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return candidates[0]
}

export function listPacks(): PackManifest[] {
  const dir = packsDir()
  if (!existsSync(dir)) return []
  const out: PackManifest[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const m = loadPack(e.name)
    if (m) out.push(m)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function loadPack(id: string): PackManifest | null {
  if (!/^[a-z0-9-]+$/i.test(id)) return null
  const dir = join(packsDir(), id)
  const file = join(dir, 'pack.json')
  if (!existsSync(file)) return null
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as PackManifest
    m.dir = dir
    m.params ??= []
    m.files ??= []
    m.generated ??= []
    m.patches ??= []
    m.manualSteps ??= []
    m.requires ??= {}
    return m
  } catch {
    return null
  }
}

/** 读 pack 里的一个文件（固定文件或模板） */
export function readPackFile(id: string, relName: string): string | null {
  const dir = join(packsDir(), id, 'files', relName)
  if (!existsSync(dir)) return null
  try {
    return readFileSync(dir, 'utf8')
  } catch {
    return null
  }
}