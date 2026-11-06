/**
 * VOFA+ 的「信号目录」与「映射表」数据模型。
 *
 * 这一层解决的是「界面上选什么」：
 *   · SymbolNode   —— 工程里真实存在的变量/成员，带层级、类型、位置
 *   · VofaBinding  —— 用户勾出来的一条映射（某个变量 → 某个通道/参数）
 *   · VofaMap      —— 整张映射表，存进 application/vofa/vofa_map.json
 *
 * 生成层不直接吃 VofaMap：mapToPackBindings() 把它转成 PackBindings，
 * 再交给 packInstaller 渲染 C 代码。这样「选择」和「生成」是分开的。
 */

import type { ChannelBinding, PackBindings, ParamBinding, PidBinding } from './packTypes'

// --------------------------------------------------------------------------
// 符号目录
// --------------------------------------------------------------------------

/** 一个符号在运行时的值类型（只关心能不能当 float 读、能不能写） */
export type SymbolValueType = 'float' | 'int' | 'bool' | 'pid' | 'struct' | 'unknown'

/** 能对这个符号做什么 */
export type SymbolAccess = 'watch' | 'tune' | 'both' | 'none'

export interface SymbolNode {
  /** 稳定 id：`文件:行:表达式`，重新扫描时同一条声明 id 不变 */
  id: string
  /** 人读的名字（变量名/字段名） */
  name: string
  /** 人读的路径：`yaw.gyro_pid.Kp`、`rc.ch[0]` */
  path: string
  /** 生成的 C 表达式：`get_yaw_motor_point()->gyro_pid.Kp` */
  expr: string
  /** 源码里的原始类型名 */
  type: string
  valueType: SymbolValueType
  access: SymbolAccess
  /** 需要判空的表达式；空表示不需要 */
  guard?: string
  /** 声明它的头文件（相对工程根） */
  include?: string
  file: string
  line: number
  /** PID 组才有 */
  pidType?: 'pid_type_def' | 'gimbal_PID_t'
  /** PID 组包含的字段 */
  fields?: string[]
  children?: SymbolNode[]
  /** 不可绑定的原因 */
  reason?: string
  isArray?: boolean
  /**
   * 绑定时要在生成的 vofa_bind.c 顶部补的一行声明。
   *
   * 变量只在 .c 里定义、头文件没写 extern 时才会有值。
   * 有 include 的（头文件里声明过）留空 —— 生成器直接 #include 就行。
   */
  externDecl?: string
}

export interface SymbolScanResult {
  /** 实例树（根是全局变量 / 访问器） */
  tree: SymbolNode[]
  /** 所有可搜索的叶子，搜索框用 */
  flat: SymbolNode[]
  /** 函数内变量：能扫到，但不能直接绑定 */
  locals: SymbolNode[]
  /**
   * 文件作用域但带 static 的变量：能看见、不能绑。
   *
   * C 的翻译单元隔离 —— static 在链接期是 local symbol，生成的 vofa_bind.c
   * 拿不到它的地址。单独列出来是为了「不假装它不存在」：
   * 用户看到它、知道原因，就能自己决定要不要去掉 static。
   */
  statics: SymbolNode[]
  /** 工程里出现过的类型名 */
  types: string[]
  scannedFiles: number
  truncated: boolean
}

// --------------------------------------------------------------------------
// 映射表
// --------------------------------------------------------------------------

export type VofaBindingAccess = 'watch' | 'tune'

export interface VofaBinding {
  /** 与 SymbolNode.id 对应；手动绑定用 `manual:<时间>` */
  id: string
  /** 通道名 / 参数前缀（VOFA 命令里用） */
  name: string
  expr: string
  type: string
  valueType: SymbolValueType
  access: VofaBindingAccess
  guard?: string
  include?: string
  /**
   * 生成 vofa_bind.c 时要补的一行声明（变量只在 .c 里定义、头文件没写 extern）。
   * 有这个字段就不用改用户的源文件。
   */
  externDecl?: string
  source: 'scan' | 'manual'
  /** PID 组：生成 vofa_reg_pid_* */
  pidType?: 'pid_type_def' | 'gimbal_PID_t'
  fields?: string[]
  /** 界面显示用，不参与生成 */
  symbolPath?: string
  file?: string
  line?: number
}

export interface VofaMap {
  version: 1
  packId: 'vofa'
  updatedAt: number
  bindings: VofaBinding[]
  /** 生成参数也顺手存一份，重开工具时能恢复 */
  params?: Record<string, string | number | boolean>
}

export function emptyVofaMap(): VofaMap {
  return { version: 1, packId: 'vofa', updatedAt: 0, bindings: [] }
}

/** 把磁盘上的 JSON 收成合法映射表；坏了就返回 null，不让界面崩 */
export function normalizeVofaMap(raw: unknown): VofaMap | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1 || o.packId !== 'vofa' || !Array.isArray(o.bindings)) return null
  const bindings: VofaBinding[] = []
  for (const item of o.bindings) {
    if (!item || typeof item !== 'object') continue
    const b = item as Record<string, unknown>
    if (
      typeof b.id !== 'string' ||
      typeof b.name !== 'string' ||
      typeof b.expr !== 'string' ||
      (b.access !== 'watch' && b.access !== 'tune')
    ) {
      continue
    }
    bindings.push({
      id: b.id,
      name: b.name,
      expr: b.expr,
      type: typeof b.type === 'string' ? b.type : 'float',
      valueType: (b.valueType as SymbolValueType) ?? 'unknown',
      access: b.access,
      guard: typeof b.guard === 'string' && b.guard ? b.guard : undefined,
      include: typeof b.include === 'string' && b.include ? b.include : undefined,
      source: b.source === 'manual' ? 'manual' : 'scan',
      pidType: b.pidType === 'pid_type_def' || b.pidType === 'gimbal_PID_t' ? b.pidType : undefined,
      fields: Array.isArray(b.fields)
        ? b.fields.filter((f): f is string => typeof f === 'string')
        : undefined,
      symbolPath: typeof b.symbolPath === 'string' ? b.symbolPath : undefined,
      file: typeof b.file === 'string' ? b.file : undefined,
      line: typeof b.line === 'number' ? b.line : undefined
    })
  }
  const params =
    o.params && typeof o.params === 'object' && !Array.isArray(o.params)
      ? (o.params as Record<string, string | number | boolean>)
      : undefined
  return {
    version: 1,
    packId: 'vofa',
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    bindings,
    params
  }
}

export function serializeVofaMap(map: VofaMap): string {
  return JSON.stringify(map, null, 2) + '\n'
}

// --------------------------------------------------------------------------
// 符号 → 绑定
// --------------------------------------------------------------------------

/** 类型名是不是浮点（能直接喂给 vofa_reg_param / vofa_reg_channel） */
export function isFloatType(type: string | undefined): boolean {
  if (!type) return false
  const t = type.toLowerCase()
  return /\b(float|double|fp32|fp64)\b/.test(t) || t === 'float' || t === 'double'
}

/**
 * 名称清洗：VOFA 命令用空格分词，所以名字里不能有空格/引号。
 * 截到 23 个字符，和 vofa_task.c 的 VOFA_NAME_LEN=24 对齐。
 */
export function sanitizeBindingName(name: string): string {
  let n = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!n) n = 'param'
  if (/^\d/.test(n)) n = '_' + n
  return n.slice(0, 23)
}

/** 避免重名；PID 前缀还要避免和它生成出来的 `_kp` 撞 */
export function uniqueBindingName(base: string, bindings: VofaBinding[], ignoreId?: string): string {
  const root = sanitizeBindingName(base)
  const used = new Set(
    bindings.filter((b) => b.id !== ignoreId).flatMap((b) => [b.name, `${b.name}_kp`])
  )
  let name = root
  let i = 2
  while (used.has(name) || used.has(`${name}_kp`)) {
    name = `${root}_${i++}`.slice(0, 23)
  }
  return name
}

/**
 * 把一个扫描出来的符号变成一条映射。
 * @param access 用户点的是「只看」还是「可调」
 */
export function bindingFromSymbol(
  node: SymbolNode,
  access: VofaBindingAccess,
  existing: VofaBinding[],
  name?: string
): VofaBinding {
  const base = name ?? node.name
  return {
    id: `${node.id}:${access}`,
    name: uniqueBindingName(base, existing),
    expr: node.expr,
    type: node.type,
    valueType: node.valueType,
    access,
    guard: node.guard,
    include: node.include,
    externDecl: node.externDecl,
    source: 'scan',
    pidType: node.pidType,
    fields: node.fields,
    symbolPath: node.path,
    file: node.file,
    line: node.line
  }
}

// --------------------------------------------------------------------------
// 映射表 → 生成层输入
// --------------------------------------------------------------------------

/**
 * 把映射表转成 packInstaller 认识的 PackBindings。
 *
 * 分流规则：
 *   tune + PID 组        → pids（vofa_reg_pid_std/gimbal）
 *   tune + float 单值    → params（vofa_reg_param）
 *   watch + float        → channels（直接注册）
 *   watch + 非 float     → channels 的 mirrorFrom（生成 static fp32 镜像）
 *
 * 非 float 的 tune 不会走到这里 —— 界面已经禁掉，C 端的注册表也只收 float*。
 */
export function mapToPackBindings(map: VofaMap): PackBindings {
  const pids: PidBinding[] = []
  const channels: ChannelBinding[] = []
  const params: ParamBinding[] = []

  for (const b of map.bindings) {
    if (b.access === 'tune') {
      if (b.pidType) {
        pids.push({
          prefix: b.name,
          pidType: b.pidType,
          expr: b.expr,
          guard: b.guard,
          include: b.include,
          externDecl: b.externDecl
        })
      } else if (isFloatType(b.type) || b.valueType === 'float') {
        params.push({
          name: b.name,
          expr: b.expr,
          guard: b.guard,
          include: b.include,
          externDecl: b.externDecl
        })
      }
      continue
    }

    if (isFloatType(b.type) || b.valueType === 'float') {
      channels.push({
        name: b.name,
        expr: b.expr,
        guard: b.guard,
        include: b.include,
        externDecl: b.externDecl
      })
    } else {
      channels.push({
        name: b.name,
        mirrorFrom: b.expr,
        guard: b.guard,
        include: b.include,
        externDecl: b.externDecl
      })
    }
  }

  return { pids, channels, params }
}
