/**
 * 语义版本比较。
 *
 * 放在 shared 里是为了能被自检脚本直接引用 —— `updateChecker.ts`
 * 依赖 electron，而自检跑在纯 node 里，一 import 就崩。
 */

/**
 * 按语义版本逐段比较。
 *
 * 只看数字段（忽略 `-beta` 之类的预发布后缀）：
 *   2.0.10 vs 2.0.9   →  2.0.10 更新
 *   2.0.0  vs 2.0.0   →  相同
 *   v2.1.0 vs 2.0.0   →  v2.1.0 更新（v 前缀会被忽略）
 *
 * **不能直接比字符串**：'2.0.10' < '2.0.9' 在字符串比较下是 true，
 * 但版本号上 2.0.10 明明更新。
 *
 * @returns 正数表示 a 比 b 新，0 相同，负数表示 a 比 b 旧
 */
export function compareVersion(a: string, b: string): number {
  const norm = (s: string): number[] =>
    s
      .replace(/^v/i, '')
      .split('-')[0] // 丢掉预发布后缀
      .split('.')
      .map((x) => parseInt(x, 10) || 0)

  const pa = norm(a)
  const pb = norm(b)
  const len = Math.max(pa.length, pb.length)

  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}
