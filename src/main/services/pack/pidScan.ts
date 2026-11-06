/**
 * 扫工程里能一键注册的 PID 结构体（`pid_type_def` / `gimbal_PID_t`）。
 *
 * 顺带猜出「该传什么表达式」和提示文案 —— 这些只是给界面填默认值，
 * 用户在界面上可以改，猜错不影响安装。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PidCandidate } from '@shared/packTypes'
import { SKIP_CONTENT, SKIP_DIR, rel } from './facts'

const PID_TYPE_RE = /(pid_type_def|gimbal_PID_t)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/g

/**
 * 找出工程里所有 `pid_type_def` / `gimbal_PID_t` 的声明。
 *
 * 关键点：**大部分不是全局变量，而是结构体成员**
 * （`gimbal_motor_t` 里的 `gimbal_motor_gyro_pid` 这种），注册时要通过实例访问，
 * 例如 `&yaw->gimbal_motor_gyro_pid`。所以这里要区分「是不是成员」并给出所属结构体名，
 * 界面才好提示用户填实例表达式。
 *
 * 判定办法：先用正则把每个 `typedef struct { ... } Name;` 的行号范围找出来，
 * 再看每个 PID 声明落在哪个范围里。简单但够用（这些工程里没有深层嵌套结构体）。
 */
export function scanPidStructs(root: string): PidCandidate[] {
  const out: PidCandidate[] = []
  /**
   * 类型名 → 工程里**真实存在**的全局实例名（来自 `extern Type name;`）。
   * 早期版本对 chassis_move_t 直接编了个 "chassis_move"，生成代码报 undeclared ——
   * 这个变量工程里压根没有，而且猜错了不编译根本发现不了。
   */
  const instanceByType = new Map<string, string>()
  /** 工程里声明过的函数名，用来确认访问器真的存在 */
  const declaredFns = new Set<string>()

  const walk = (dir: string, depth: number): void => {
    if (depth > 10) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || SKIP_CONTENT.test(full)) continue
        walk(full, depth + 1)
        continue
      }
      if (!/\.(c|h)$/i.test(e.name)) continue

      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }

      // 0) 收集全局实例与已声明的函数（要给候选拼表达式用）
      for (const m of text.matchAll(/\bextern\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;/g)) {
        if (!instanceByType.has(m[1])) instanceByType.set(m[1], m[2])
      }
      for (const m of text.matchAll(/\bextern\s+[A-Za-z_][\w \t*]*?\b([A-Za-z_]\w*)\s*\(/g)) {
        declaredFns.add(m[1])
      }

      // 1) 找出所有 typedef struct 块的行号范围
      const structs: Array<{ start: number; end: number; name: string }> = []
      for (const m of text.matchAll(/typedef\s+struct[^;{]*\{([\s\S]*?)\}\s*([A-Za-z_]\w*)\s*;/g)) {
        const idx = m.index ?? 0
        const start = text.slice(0, idx).split('\n').length
        const end = text.slice(0, idx + m[0].length).split('\n').length
        structs.push({ start, end, name: m[2] })
      }

      // 2) 找 PID 声明，看落在哪个结构体里
      const relPath = rel(root, full)
      for (const m of text.matchAll(PID_TYPE_RE)) {
        const idx = m.index ?? 0
        const line = text.slice(0, idx).split('\n').length
        const name = m[2]
        const owner = structs.find((s) => line >= s.start && line <= s.end) ?? null
        out.push({
          id: `${relPath}:${line}:${name}`,
          name,
          pidType: m[1] as PidCandidate['pidType'],
          isMember: Boolean(owner),
          ownerType: owner?.name ?? null,
          isArray: Boolean(m[3]),
          file: relPath,
          line,
          hint: owner ? suggestHint(owner.name) : '全局变量',
          ...suggestExpr(owner?.name ?? null, name, instanceByType, declaredFns)
        })
      }
    }
  }
  walk(root, 0)

  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/** 给界面显示的一句提示 */
function suggestHint(typeName: string): string {
  if (/gimbal_motor/i.test(typeName)) return 'yaw-> 或 pitch->（预填的是 yaw，要调 pitch 就改一下）'
  return '要填「实例.字段」，实例名得工程里真实存在'
}

/**
 * 猜一个**可以直接用**的表达式。
 *
 * 为什么不是只给一句「yaw-> 或 pitch->」：那样用户还得自己拼完整表达式，
 * 等于变相手输。这里按结构体名猜一个常用访问方式，预填进去，用户最多改个 yaw/pitch。
 *
 * 判空也跟着一起给：`get_xxx_point()` 在模块初始化前可能返回 NULL，
 * 原实现里是判过空的，生成代码不能丢这一步。
 */
function suggestExpr(
  ownerType: string | null,
  field: string,
  instanceByType: Map<string, string>,
  declaredFns: Set<string>
): {
  suggestedExpr: string
  suggestedGuard: string
  needsInstance?: boolean
} {
  if (!ownerType) return { suggestedExpr: field, suggestedGuard: '' }

  // 云台：有配套访问器就用它，顺带给出判空表达式（原实现里也判过空）
  if (/gimbal_motor/i.test(ownerType) && declaredFns.has('get_yaw_motor_point')) {
    return {
      suggestedExpr: `get_yaw_motor_point()->${field}`,
      suggestedGuard: 'get_yaw_motor_point()'
    }
  }

  // 其它类型：只在工程里**确实存在**该类型的全局实例时才敢拼。
  // 早期版本对 chassis_move_t 直接编了个 "chassis_move"，结果生成代码报
  // 'chassis_move' undeclared —— 这个变量工程里压根没有，而且猜错了不编译发现不了。
  const inst = instanceByType.get(ownerType)
  if (inst) return { suggestedExpr: `${inst}.${field}`, suggestedGuard: '' }

  // 查不到就**留空**并标记出来，让界面提示用户先填实例
  return { suggestedExpr: '', suggestedGuard: '', needsInstance: true }
}