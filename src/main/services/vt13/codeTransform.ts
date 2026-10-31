/**
 * 业务层字段替换引擎：SBUS 的 `RC_ctrl_t` 写法 → VT13 的 `remote_data_t` 写法。
 *
 * ## 为什么这是整个移植里最容易出错的一步
 *
 * 10 个业务文件里散落着 `rc.ch[0]`、`rc.s[MODE_CHANNEL]`、`key.v` 这类访问，
 * 每个都要换成新的字段名。**换错一个不会报编译错误**（类型都是整型），
 * 只会表现为「摇杆方向反了」「开关不起作用」—— 上车才能发现，而那时候人已经在了。
 *
 * 需求文档给出的映射表里有两个坑，这里都做了显式处理：
 *
 *   ① `rc.ch[0]` → `Right_y`，**不是** `Right_x`。文档特意标了「前后，不是 Right_x」。
 *      凭直觉写会把前后和横移搞反。
 *   ② `rc.ch[CHASSIS_WZ_CHANNEL]` 是**通道 → 开关**的特例：它原本是个模拟通道，
 *      VT13 里对应的语义变成了 `mode_sw` 开关。这类跨类型映射不能靠批量正则。
 */

export interface TransformNote {
  /** 命中的原文，例如 `->rc.ch[0]` */
  from: string
  /** 替换成什么 */
  to: string
  /** 命中次数 */
  count: number
}

export interface TransformResult {
  text: string
  notes: TransformNote[]
  /** 还剩多少旧写法 —— 验收要它归零 */
  residue: Array<{ pattern: string; count: number }>
}

/**
 * 通道宏 → VT13 字段。
 *
 * | 旧通道 | VT13 字段 | 含义 |
 * |---|---|---|
 * | CHASSIS_X_CHANNEL | Right_y | 前后（**不是 Right_x**） |
 * | CHASSIS_Y_CHANNEL | Right_x | 横移 |
 * | CHASSIS_WZ_CHANNEL | mode_sw | 转向上，VT13 改成了开关 |
 * | YAW_CHANNEL | Left_x | 云台 yaw |
 * | PITCH_CHANNEL | Left_y | 云台 pitch |
 * | 数字 0..3 | 同上 | 模板工程里也有直接写数字的 |
 */
const CHANNEL_MAP: Record<string, string> = {
  CHASSIS_X_CHANNEL: 'Right_y',
  CHASSIS_Y_CHANNEL: 'Right_x',
  CHASSIS_WZ_CHANNEL: 'mode_sw',
  YAW_CHANNEL: 'Left_x',
  PITCH_CHANNEL: 'Left_y',
  '0': 'Right_y',
  '1': 'Right_x',
  '2': 'Left_y',
  '3': 'Left_x'
}

/** 旧写法里必须归零的残留检查（验收项 [1]） */
const RESIDUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'rc.ch[', re: /->\s*rc\s*\.\s*ch\s*\[/g },
  { name: 'rc.s[', re: /->\s*rc\s*\.\s*s\s*\[/g },
  { name: 'key.v', re: /->\s*key\s*\.\s*v\b/g },
  { name: 'RC_ctrl_t', re: /\bRC_ctrl_t\b/g }
]

/**
 * 把一段 C 代码从 SBUS 写法换成 VT13 写法。
 *
 * 刻意**只做文本替换、不做语法分析** —— 这些工程是模板化的，写法很规整；
 * 引入 C 解析器的成本远大于收益，而且解析失败时的降级行为更难解释。
 *
 * @param text 源文件内容
 * @param opts 可选：是否替换开关宏（默认替换）
 */
export function transformRcCode(
  text: string,
  opts: { replaceSwitchMacros?: boolean } = {}
): TransformResult {
  const notes: TransformNote[] = []
  let out = text

  /** 统一执行一次替换并记录 */
  const apply = (label: string, re: RegExp, repl: string | ((m: string) => string)): void => {
    const matches = out.match(re)
    if (!matches || matches.length === 0) return
    const count = matches.length
    const before = out
    out = out.replace(re, repl as string)
    // 记录一条（同一模式只记一次，count 是总次数）
    const sample = before.match(re)?.[0] ?? label
    const replaced = typeof repl === 'string' ? sample.replace(re, repl) : repl(sample)
    notes.push({ from: sample, to: replaced, count })
  }

  // ① 通道 → 字段。用 `->rc.ch[X]` 整体匹配，保留前面的 `->`
  //
  //    注意顺序：先匹配宏名（长的），再匹配数字。
  //    如果先跑数字那轮，`CHASSIS_X_CHANNEL` 里的字符不会被误伤（因为要求 ch[ 后
  //    紧跟数字），但为了可读性还是按「宏 → 数字」的顺序写。
  for (const [macro, field] of Object.entries(CHANNEL_MAP)) {
    const re = new RegExp(`->\\s*rc\\s*\\.\\s*ch\\s*\\[\\s*${macro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'g')
    apply(`rc.ch[${macro}]`, re, `->${field}`)
  }

  // ② 开关 `->rc.s[N]` → `->mode_sw`
  apply('rc.s[N]', /->\s*rc\s*\.\s*s\s*\[\s*\w+\s*\]/g, '->mode_sw')

  // ③ 键盘 `->key.v` → `->key`
  apply('key.v', /->\s*key\s*\.\s*v\b/g, '->key')

  // ④ 鼠标轴：`->mouse.x` → `->mouse_x`
  for (const axis of ['x', 'y', 'z']) {
    apply(
      `mouse.${axis}`,
      new RegExp(`->\\s*mouse\\s*\\.\\s*${axis}\\b`, 'g'),
      `->mouse_${axis}`
    )
  }

  // ⑤ 鼠标键：`->mouse.press_l` → `->mouse_left`
  for (const [from, to] of [
    ['press_l', 'mouse_left'],
    ['press_r', 'mouse_right']
  ] as const) {
    apply(`mouse.${from}`, new RegExp(`->\\s*mouse\\s*\\.\\s*${from}\\b`, 'g'), `->${to}`)
  }

  // ⑥ 类型名 `RC_ctrl_t` → `remote_data_t`
  apply('RC_ctrl_t', /\bRC_ctrl_t\b/g, 'remote_data_t')

  // ⑦ 开关宏：上 → 右，下 → 左
  //
  //    VT13 只有三档 LEFT/MID/RIGHT，SBUS 的「上/下」在物理位置上是反的：
  //    老遥控器向上拨 = 新遥控器向右拨。这条对应关系是需求文档 §9.1 明确给出的。
  if (opts.replaceSwitchMacros !== false) {
    apply('switch_is_up', /\bswitch_is_up\s*\(/g, 'switch_is_right(')
    apply('switch_is_down', /\bswitch_is_down\s*\(/g, 'switch_is_left(')
  }

  // 残留统计（注释里的不算 —— 文档里的验收是「代码中 0 匹配」，但保留注释说明
  // 对读代码的人有价值，所以这里只统计非注释行）
  const codeLines = stripComments(out)
  const residue = RESIDUE_PATTERNS.map(({ name, re }) => ({
    pattern: name,
    count: (codeLines.match(new RegExp(re.source, 'g')) ?? []).length
  })).filter((r) => r.count > 0)

  return { text: out, notes, residue }
}

/**
 * 去掉 C 注释（`//` 和 `/* *\/`），保留行号结构。
 *
 * 简单实现就够：这些文件里没有嵌套的古怪注释。字符串字面量里出现的 `//`
 * 理论上会被误删，但这些文件里没有含 `//` 的字符串。
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
    } else {
      out += c
      i++
    }
  }
  return out
}

/** 保留原文件的换行符：CRLF 的文件写回去还得是 CRLF */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}