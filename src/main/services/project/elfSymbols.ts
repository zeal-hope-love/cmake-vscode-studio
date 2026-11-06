/**
 * 从编译产物 `.elf` 里读全局变量（名字 + 地址）。
 *
 * 为什么自己解析而不调 `arm-none-eabi-nm`：
 *   ① nm 不一定在 PATH 里（CubeCLT / CubeMX 各自的安装位置都不一样），
 *      而 elf 文件是构建出来的、一定在；
 *   ② 解析符号表本身只有几十行，换来「不依赖外部程序、不用猜路径」很划算。
 *
 * 只收 STT_OBJECT 且地址落在 RAM 里的符号：
 *   · 函数、段符号（__bss_start__ 这类）不是变量，界面里列出来全是噪音
 *   · flash 里的 const 表不能改，也没必要在波形里看
 *
 * static（LOCAL）符号照样收 —— 这正是这条路比源码扫描强的地方：
 * 源码扫描看不到 `static`，链接器却给了它一个真实地址，按地址读就行。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { kindFromSize, type ElfVar, type ElfVarsResult } from '@shared/addrTable'

/** STM32 上可能放变量的地址段：SRAM / CCM(F4) 或 DTCM(F7) */
const RAM_RANGES: Array<[number, number]> = [
  [0x20000000, 0x20040000],
  [0x10000000, 0x10020000]
]

const SHT_SYMTAB = 2
const STT_OBJECT = 1
/** 符号表里这些特殊 shndx 不是真实节 */
const SHN_UNDEF = 0
const SHN_LORESERVE = 0xff00

interface Section {
  nameOff: number
  type: number
  addr: number
  offset: number
  size: number
  link: number
  entsize: number
}

function inRam(addr: number, size: number): boolean {
  const end = addr + Math.max(size, 1)
  return RAM_RANGES.some(([lo, hi]) => addr >= lo && end <= hi)
}

/**
 * 读 ELF32 小端的符号表。
 *
 * 只解析节头表，不碰程序头 —— 我们关心的东西（symtab / strtab / 各节地址）
 * 全在节头里。64 位和大端直接拒绝：STM32 工程不可能出现，出现了说明
 * 用户选错了文件（比如选了 .exe 或宿主的 .o），报错比猜要好。
 */
export function parseElfVars(buf: Buffer): ElfVar[] {
  if (buf.length < 52 || buf.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error('不是 ELF 文件（文件头不对）')
  }
  if (buf[4] !== 1) throw new Error('这是 64 位 ELF，不是 STM32 的程序')
  if (buf[5] !== 1) throw new Error('这是大端 ELF，暂不支持')

  const shoff = buf.readUInt32LE(0x20)
  const shentsize = buf.readUInt16LE(0x2e)
  let shnum = buf.readUInt16LE(0x30)
  let shstrndx = buf.readUInt16LE(0x32)
  if (shoff === 0 || shnum === 0) {
    throw new Error('ELF 里没有节头表（可能被 strip 掉了）')
  }
  if (shoff + shnum * shentsize > buf.length) {
    throw new Error('节头表越界，文件可能不完整（拷贝没考完？）')
  }

  const sec = (i: number): Section => {
    const o = shoff + i * shentsize
    return {
      nameOff: buf.readUInt32LE(o),
      type: buf.readUInt32LE(o + 4),
      addr: buf.readUInt32LE(o + 0xc),
      offset: buf.readUInt32LE(o + 0x10),
      size: buf.readUInt32LE(o + 0x14),
      link: buf.readUInt32LE(o + 0x18),
      entsize: buf.readUInt32LE(o + 0x24)
    }
  }

  // 节名表的下标可能溢出到 0xffff（真值放在 0 号节的 sh_link 里），ELF 允许这么写
  if (shstrndx === 0xffff) {
    shstrndx = sec(0).link
    shnum = Math.max(shnum, sec(0).size)
  }
  const shstr = shstrndx < shnum ? sec(shstrndx) : null

  const cstr = (base: number, limit: number, at: number): string => {
    let p = base + at
    const end = Math.min(base + limit, buf.length)
    let stop = p
    while (stop < end && buf[stop] !== 0) stop += 1
    return buf.toString('latin1', p, stop)
  }

  const sectionName = (idx: number): string => {
    if (!shstr || idx >= shnum) return ''
    const s = sec(idx)
    return cstr(shstr.offset, shstr.size, s.nameOff)
  }

  // 找到符号表（正常只有一个 .symtab）
  let symtab: Section | null = null
  for (let i = 0; i < shnum; i += 1) {
    const s = sec(i)
    if (s.type === SHT_SYMTAB) {
      symtab = s
      break
    }
  }
  if (!symtab) throw new Error('ELF 里没有符号表（链接时被 strip 掉了？改一下 CMake 的 strip 选项）')

  const strtab = symtab.link < shnum ? sec(symtab.link) : null
  if (!strtab) throw new Error('符号表没有对应的字符串表，文件可能损坏')

  const entsize = symtab.entsize || 16
  const out: ElfVar[] = []
  const seen = new Set<string>()

  for (let o = symtab.offset; o + 16 <= symtab.offset + symtab.size; o += entsize) {
    const info = buf[o + 0x0c]
    if ((info & 0xf) !== STT_OBJECT) continue

    const shndx = buf.readUInt16LE(o + 0x0e)
    if (shndx === SHN_UNDEF || shndx >= SHN_LORESERVE) continue

    const addr = buf.readUInt32LE(o + 4)
    const size = buf.readUInt32LE(o + 8)
    if (addr === 0 || !inRam(addr, size)) continue

    // 只有 1/2/4 字节的量对波形和调参有意义。
    // 结构体、数组、字符串缓冲（USBD_CDC 那种 56 字节的）按 float 读出来是垃圾，
    // 列进界面只是噪音 —— 想看结构体成员得用注册表那条路（它知道成员类型）。
    if (size !== 1 && size !== 2 && size !== 4) continue

    const name = cstr(strtab.offset, strtab.size, buf.readUInt32LE(o))
    // `.L0`、`$d` 这类是编译器/汇编器的内部符号，不是源码里的变量；
    // 名字里带 `.` 的（`max_angle.2`）是同一个 static 被重复展开的产物，
    // C 标识符不可能含点，一并滤掉。
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) continue

    // 同一个地址可能既有全局符号又有局部别名（-ffunction-sections 之类）
    const key = `${addr}:${name}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      name,
      addr,
      size,
      section: sectionName(shndx),
      isStatic: info >> 4 === 0,
      kind: kindFromSize(size)
    })
  }

  return out.sort((a, b) => a.addr - b.addr || a.name.localeCompare(b.name))
}

/** 这些目录里的 elf 不用看：库、驱动、构建中间产物都不可能是目标 */
const SKIP_DIR = new Set(['.git', 'node_modules', 'Drivers', 'Middlewares', 'CMakeFiles', '.vscode'])

/**
 * 找最新的 .elf。
 *
 * 优先 build/ 下的（构建产物本来就在那儿），其次工程根下的。
 * 多个候选时取**修改时间最新**的 —— 用户刚构建完，最新的那个才对应他烧进去的固件。
 */
export function findElf(root: string): string | null {
  const hits: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue
        walk(full, depth + 1)
      } else if (/\.elf$/i.test(e.name)) {
        hits.push(full)
      }
    }
  }
  if (!existsSync(root)) return null
  walk(root, 0)
  if (!hits.length) return null

  hits.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs
    } catch {
      return 0
    }
  })
  return hits[0]
}

/** 读一个 elf 的全部可读写变量 */
export function readElfVars(elfPath: string): ElfVarsResult {
  try {
    const st = statSync(elfPath)
    const symbols = parseElfVars(readFileSync(elfPath))
    return {
      elfPath,
      mtimeMs: st.mtimeMs,
      symbols,
      error: symbols.length ? undefined : 'ELF 里没找到落在 RAM 的全局变量'
    }
  } catch (err) {
    return {
      elfPath,
      mtimeMs: null,
      symbols: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** 界面入口：给工程根就自己找 elf，也可以指定（用户想读 Release 那份） */
export function scanProjectVars(root: string, elfPath?: string): ElfVarsResult {
  const target = elfPath ?? findElf(root)
  if (!target) {
    return {
      elfPath: null,
      mtimeMs: null,
      symbols: [],
      error: '工程里没有 .elf —— 先构建一次（Ctrl+Shift+B），符号表才有东西可读'
    }
  }
  return readElfVars(target)
}
