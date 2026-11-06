/**
 * 模块包（Pack）的装载 + 工程探测 + 兼容性判断 + PID 扫描 —— **门面**。
 *
 * 以前这四件事挤在一个 722 行的文件里，改一处得先弄清自己在哪一段。
 * 现在按「读的还是判的」切开：
 *
 * | 文件 | 职责 |
 * | --- | --- |
 * | `catalog.ts` | 找 packs 目录、读 pack.json、读包里的文件 |
 * | `facts.ts`   | 探工程里有什么（不看包，不做判断） |
 * | `compat.ts`  | 拿事实判断这个包能不能装、要适配什么 |
 * | `pidScan.ts` | 扫 PID 结构体，给界面填默认值 |
 *
 * 对外只认这个文件，所以所有 `from './packStore'` 的引用一行都没改。
 */

export * from './catalog'
export * from './facts'
export * from './compat'
export * from './pidScan'
