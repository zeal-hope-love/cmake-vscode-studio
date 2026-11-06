/**
 * `.ioc` 语义化编辑器。
 *
 * ## 为什么不能按行号改
 *
 * 需求文档里标了实测结论：**CubeMX 重新生成后会重排 `.ioc` 里无关字段的顺序**。
 * 所以 `lines[686] = "USART1.BaudRate=921600"` 这种写法今天能跑、明天就写到别的键上，
 * 而且不报错 —— 改错了 key 只会表现为「配置没生效」，极难排查。
 *
 * 这里一律按 `key=` 前缀定位。
 *
 * ## 编码与换行
 *
 * `.ioc` 是 CubeMX 写的，可能是 CRLF 也可能是 LF，可能带 BOM。
 * 全部原样保留 —— 改完换行符变了，git diff 会变成「整个文件都改了」，
 * 用户根本看不出改了什么。
 */

import { readFileSync, writeFileSync } from 'node:fs'

export type IocEditKind = 'modified' | 'inserted' | 'unchanged'

export interface IocEdit {
  key: string
  kind: IocEditKind
  before?: string
  after: string
}

export class IocEditor {
  private readonly path: string
  private readonly crlf: boolean
  private readonly bom: boolean
  private lines: string[]
  private readonly original: string[]

  constructor(path: string) {
    this.path = path
    const raw = readFileSync(path)
    // BOM 判断必须在 decode 之前 —— 用 utf8 解码会把 BOM 变成一个不可见字符，
    // 后面再想加回去就分不清「本来就有」还是「刚才加上的」。
    this.bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    const text = raw.toString('utf8').replace(/^\uFEFF/, '')
    this.crlf = text.includes('\r\n')
    this.lines = text.replace(/\r\n/g, '\n').split('\n')
    this.original = [...this.lines]
  }

  /** 精确匹配 `key=` 前缀，返回所有匹配行号（一个 key 理论上只有一行，但有就都返回） */
  private find(key: string): number[] {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${escaped}=`)
    const out: number[] = []
    for (let i = 0; i < this.lines.length; i++) {
      if (re.test(this.lines[i])) out.push(i)
    }
    return out
  }

  get(key: string): string | null {
    const idx = this.find(key)
    if (idx.length === 0) return null
    return this.lines[idx[0]].split('=').slice(1).join('=')
  }

  has(key: string): boolean {
    return this.find(key).length > 0
  }

  /**
   * 存在则原地改；不存在则按**字母序**插入。
   *
   * 为什么按字母序：CubeMX 自己写 `.ioc` 就是按 key 排序的。插在末尾虽然也能用，
   * 但和 CubeMX 下次生成的结果不一致，diff 会很大。
   */
  set(key: string, value: string): IocEditKind {
    const idx = this.find(key)
    const next = `${key}=${value}`
    if (idx.length > 0) {
      if (this.lines[idx[0]] === next) return 'unchanged'
      this.lines[idx[0]] = next
      return 'modified'
    }

    // 找第一个「数据行」中 key 字典序大于目标的，插在它前面
    let insertAt = -1
    for (let i = 0; i < this.lines.length; i++) {
      const ln = this.lines[i]
      if (!ln || ln.startsWith('#') || ln.startsWith(';')) continue
      const eq = ln.indexOf('=')
      if (eq < 0) continue
      const k = ln.slice(0, eq)
      if (k > key) {
        insertAt = i
        break
      }
    }
    if (insertAt < 0) insertAt = this.lines.length
    this.lines.splice(insertAt, 0, next)
    return 'inserted'
  }

  /** 删掉某个 key（用于「清理不该有的配置」这类场景） */
  remove(key: string): boolean {
    const idx = this.find(key)
    if (idx.length === 0) return false
    // 从后往前删，避免下标错位
    for (let i = idx.length - 1; i >= 0; i--) this.lines.splice(idx[i], 1)
    return true
  }

  /**
   * 确保一条 DMA 请求存在，并补全它的所有字段。
   *
   * 编号**绝对不写死**：文档里明确说了要用「最小可用编号」。
   * 因为不同工程已有的 DMA 请求数量不同（模板工程是 7 个），
   * 写死 7 在某些工程上会覆盖掉别的外设。
   *
   * @param ident   `USART1_RX` 这种外设_方向标识
   * @param fields  要补全的字段（Instance / Mode / Priority …）
   */
  ensureDmaRequest(
    ident: string,
    fields: Record<string, string>
  ): { slot: string; edits: IocEdit[] } {
    const edits: IocEdit[] = []

    // ① 已经存在同 ident 的请求 → 复用它的编号，只补字段
    let slot: string | null = null
    for (const ln of this.lines) {
      const m = /^Dma\.Request(\d+)=(.+)$/.exec(ln)
      if (m && m[2].trim() === ident) {
        slot = m[1]
        break
      }
    }

    if (slot === null) {
      // ② 没有 → 找最小可用编号
      const used = new Set<number>()
      for (const ln of this.lines) {
        const m = /^Dma\.Request(\d+)=/.exec(ln)
        if (m) used.add(Number(m[1]))
      }
      let n = 0
      while (used.has(n)) n++
      slot = String(n)

      const beforeReq = this.get(`Dma.Request${n}`)
      const kind = this.set(`Dma.Request${n}`, ident)
      edits.push({ key: `Dma.Request${n}`, kind, before: beforeReq ?? undefined, after: ident })

      // RequestsNb 必须 ≥ max(编号)+1，否则 CubeMX 会忽略最后一条
      const beforeNb = this.get('Dma.RequestsNb')
      const nextNb = String(Math.max(n + 1, used.size + 1, Number(beforeNb ?? 0)))
      if (beforeNb !== nextNb) {
        const nbKind = this.set('Dma.RequestsNb', nextNb)
        edits.push({
          key: 'Dma.RequestsNb',
          kind: nbKind,
          before: beforeNb ?? undefined,
          after: nextNb
        })
      }
    }

    // ③ 补全字段（缺什么补什么，已有的也覆盖成目标值）
    const prefix = `Dma.${ident}.${slot}`
    for (const [k, v] of Object.entries(fields)) {
      const key = `${prefix}.${k}`
      const before = this.get(key)
      const kind = this.set(key, v)
      if (kind !== 'unchanged') {
        edits.push({ key, kind, before: before ?? undefined, after: v })
      }
    }

    // ④ RequestParameters 的字段顺序必须和上面补的顺序一致
    const paramKey = `${prefix}.RequestParameters`
    const paramValue = Object.keys(fields).join(',')
    const beforeParam = this.get(paramKey)
    const paramKind = this.set(paramKey, paramValue)
    if (paramKind !== 'unchanged') {
      edits.push({
        key: paramKey,
        kind: paramKind,
        before: beforeParam ?? undefined,
        after: paramValue
      })
    }

    return { slot, edits }
  }

  /**
   * 检查某个 DMA Stream 是否已被**别的外设**占用。
   *
   * 冲突的后果很隐蔽：CubeMX 不报错，运行时两个外设抢同一个 Stream，
   * 后配置的那个静默失效。文档专门列了这一项校验。
   *
   * @returns 占用它的外设名；没冲突返回 null
   */
  findStreamConflict(stream: string, expectIdent: string): string | null {
    const re = /^Dma\.(\S+)\.(\d+)\.Instance=(.+)$/
    for (const ln of this.lines) {
      const m = re.exec(ln)
      if (m && m[3].trim() === stream && m[1] !== expectIdent) return m[1]
    }
    return null
  }

  /** 收集本次所有改动（用于预览 / 写历史） */
  diff(): IocEdit[] {
    const out: IocEdit[] = []
    const max = Math.max(this.lines.length, this.original.length)
    const origSet = new Set(this.original)
    for (const ln of this.lines) {
      if (origSet.has(ln)) continue
      const eq = ln.indexOf('=')
      if (eq < 0) continue
      out.push({ key: ln.slice(0, eq), kind: 'inserted', after: ln.slice(eq + 1) })
    }
    for (let i = 0; i < max; i++) {
      const a = this.original[i]
      const b = this.lines[i]
      if (a === undefined || b === undefined || a === b) continue
      const eq = b.indexOf('=')
      if (eq < 0) continue
      out.push({
        key: b.slice(0, eq),
        kind: 'modified',
        before: a.split('=').slice(1).join('='),
        after: b.slice(eq + 1)
      })
    }
    return out
  }

  /** 是否有实际改动 */
  isDirty(): boolean {
    return this.lines.join('\n') !== this.original.join('\n')
  }

  /** 写回文件，保留原来的 BOM 和换行符 */
  save(): void {
    const sep = this.crlf ? '\r\n' : '\n'
    const text = this.lines.join(sep)
    writeFileSync(this.path, (this.bom ? '\uFEFF' : '') + text, 'utf8')
  }

  /** 不落盘，取出当前内容（测试和预览用） */
  toString(): string {
    return (this.bom ? '\uFEFF' : '') + this.lines.join(this.crlf ? '\r\n' : '\n')
  }
}