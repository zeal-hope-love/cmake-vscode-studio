/**
 * 地址表 —— 不改源码、不重编的那条调参路。
 *
 * 另一条路（vofa_bind.c）是**源码级**的：勾变量 → 生成 `&(变量)` → 编译进固件。
 * 每加一个变量都要重新生成、重新编译、重新烧录，而且 static 变量拿不到地址。
 *
 * 这条路是**地址级**的：从编译产物 `.elf` 的符号表里读「变量名 → 地址」，
 * 把地址直接下发给固件（`am 槽号 地址 类型`），固件按地址读内存。于是：
 *   · 换看哪个变量 = 在上位机重新勾一次，源码一行不动、不用重编
 *   · static 变量也能看 —— 符号表里它是 LOCAL 符号，但地址是真实存在的
 *
 * 代价必须说在前面：**地址必须和正在跑的固件一致**。改了代码没重新烧录，
 * 读到的是别的变量，而且不会报错（就是这么设计的，没有校验和可用）。
 */

/** 和 vofa_task.c 里的 VOFA_ADDR_SLOT_MAX 必须一致，超出的槽固件会拒 */
export const ADDR_SLOT_MAX = 16

/** 固件认的类型标记，和 vofa_task.c 的 vofa_type_parse 一一对应 */
export type MemKind = 'f' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32'

export const MEM_KINDS: MemKind[] = ['f', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32']

export const MEM_KIND_LABEL: Record<MemKind, string> = {
  f: 'float',
  u8: 'uint8',
  i8: 'int8',
  u16: 'uint16',
  i16: 'int16',
  u32: 'uint32',
  i32: 'int32'
}

/** 从 ELF 符号表里读到的一个变量 */
export interface ElfVar {
  name: string
  /** 绝对地址（RAM 里的运行时地址） */
  addr: number
  /** 符号大小（字节），用来猜类型、也是越界检查的依据 */
  size: number
  /** 所在节，例如 .bss / .data / .ccmram */
  section: string
  /** 文件内 static —— 源码扫描看不到它，但符号表里有 */
  isStatic: boolean
  /** 猜出来的类型，用户可以改 */
  kind: MemKind
}

/** 一个地址槽：按什么类型读哪块内存 */
export interface AddrSlot {
  name: string
  addr: number
  kind: MemKind
}

/**
 * 存进工程的那份地址表（`application/vofa/vofa_addr.json`）。
 *
 * 为什么要落盘：勾选是「这个工程想盯哪几个量」的决定，属于工程配置，不属于一次会话。
 * 不存的话，关掉工具、切个页面、重启一次，用户就得重新勾一遍 —— 而地址可能
 * 已经和上次不一样了，重新勾的时候还得回想上次选了谁。
 *
 * 和 vofa_map.json 分开存：那是「生成代码要看什么」，编译期生效；
 * 这份是「运行时按地址看什么」，改它不需要重新生成、也不需要重新编译。
 * 混在一个文件里会让「另存/回滚」变成一件牵连的事。
 *
 * `addr` 也一起存：它是**上次读 elf 时的地址**，加载时会被重新读到的地址覆盖。
 * 留着它是为了 elf 里已经找不到这个变量时，还能显示「上次是哪个地址」，
 * 让用户知道这条槽是什么时候失效的，而不是看见一行空白。
 */
export interface AddrTableFile {
  version: 1
  packId: 'vofa'
  updatedAt: number
  /** 顺序就是 ch0、ch1…，有语义，不能排序 */
  slots: AddrSlot[]
}

export function normalizeAddrTable(raw: unknown): AddrTableFile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.slots)) return null

  const toAddr = (v: unknown): number => {
    if (typeof v === 'number') return Number.isFinite(v) ? v >>> 0 : NaN
    if (typeof v !== 'string') return NaN
    const t = v.trim()
    const n = /^0x/i.test(t) ? Number.parseInt(t.slice(2), 16) : Number.parseInt(t, 10)
    return Number.isFinite(n) ? n >>> 0 : NaN
  }

  const slots: AddrSlot[] = []
  for (const item of o.slots) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    if (typeof s.name !== 'string' || !s.name) continue
    const addr = toAddr(s.addr)
    if (!Number.isFinite(addr)) continue
    // 类型不认识就按 4 字节 float —— 强行丢掉会让用户以为变量被删了
    const kind = MEM_KINDS.includes(s.kind as MemKind) ? (s.kind as MemKind) : 'f'
    slots.push({ name: s.name, addr, kind })
    if (slots.length >= ADDR_SLOT_MAX) break
  }

  return {
    version: 1,
    packId: 'vofa',
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
    slots
  }
}

export function serializeAddrTable(table: AddrTableFile): string {
  // 地址写成 0x 字符串：这个文件是给人看、给 git diff 看的，
  // 十进制 537406780 对着 map 文件根本认不出来是哪个地址。
  const slots = table.slots.map((s) => ({ name: s.name, addr: hexAddr(s.addr), kind: s.kind }))
  return `${JSON.stringify({ ...table, addrNote: '地址为上次读 elf 的结果，重新读取后会更新', slots }, null, 2)}\n`
}

/** 读 ELF 的结果 */
export interface ElfVarsResult {
  /** 读的是哪个文件；找不到时是 null */
  elfPath: string | null
  /** 文件修改时间（毫秒）。和固件是不是同一个版本，只能靠这个和用户自己判断 */
  mtimeMs: number | null
  symbols: ElfVar[]
  /** 扫描时遇到的问题（找不到、解析失败…）。有值不代表失败，界面按需显示 */
  error?: string
}

/**
 * 按大小猜类型。
 *
 * 4 字节默认猜 float：机器人工程里绝大多数 4 字节全局量都是 fp32，
 * 按 int 显示会把 1.5 显示成 1069547520，一眼就知道选错了。
 * 2 字节猜 int16（遥控器、编码器读数那类），1 字节猜 int8。
 */
export function kindFromSize(size: number): MemKind {
  if (size === 1) return 'i8'
  if (size === 2) return 'i16'
  return 'f'
}

/** 地址写法统一成 0x 加 8 位大写 —— 和 map 文件、调试器里看到的一致 */
export function hexAddr(addr: number): string {
  return `0x${(addr >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * 生成「一次配好全部槽」的命令串。
 *
 * 开头先 `ac` 清空：否则上一批的槽会留在表里，波形通道数和上位机以为的对不上。
 * 槽号从 0 连续排 —— 固件按槽号顺序打包，所以 **ch0 就是列表里第一个**。
 */
export function buildSlotCommands(slots: AddrSlot[]): string {
  const parts = ['ac']
  slots.slice(0, ADDR_SLOT_MAX).forEach((s, i) => {
    parts.push(`am ${i} ${hexAddr(s.addr)} ${s.kind}`)
  })
  return parts.join(';')
}

/** 一条写命令，模板值留空让用户自己填 */
export function buildWriteCommand(slot: AddrSlot, value = '0'): string {
  return `wr ${hexAddr(slot.addr)} ${slot.kind} ${value}`
}

/** 一条读命令 */
export function buildReadCommand(slot: AddrSlot): string {
  return `rd ${hexAddr(slot.addr)} ${slot.kind}`
}

/**
 * 槽位和 VOFA+ 通道的对应关系，一行一个。
 *
 * 必须显式列出来：用户看到的是变量名，VOFA+ 里看到的是 ch0/ch1，
 * 中间这层对应关系不存在任何一个地方，只能由我们告诉他。
 */
export function slotLegend(slots: AddrSlot[]): string[] {
  return slots.slice(0, ADDR_SLOT_MAX).map((s, i) => `ch${i}  ${s.name}  (${s.kind})`)
}
