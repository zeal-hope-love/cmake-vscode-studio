/**
 * 常规包（声明式包）的安装流水线。
 *
 * 以前是一个 1010 行的 `packInstaller.ts`，四件事挤在一起：
 * 渲染、补丁、算计划、落盘 + CubeMX + 核对。现在按**能不能写盘**切开：
 *
 * | 文件 | 能不能写盘 | 职责 |
 * | --- | --- | --- |
 * | `render.ts`     | 不能（可能 throw） | 模板 + 参数 + 工程事实 → 文件全文 |
 * | `patches.ts`    | 不能 | 往用户已有文件里插东西，返回改前/改后 |
 * | `plan.ts`       | 不能 | 汇总成改动清单，给界面做 diff |
 * | `apply.ts`      | **能** | 快照 → 写 → 记历史 |
 * | `postApply.ts`  | **能**（还会起进程） | 跑 CubeMX、读回真实波特率 |
 *
 * 这个分法的用处：想知道「点安装会不会动我的磁盘」，看 import 就知道 ——
 * 前三个文件里没有写盘函数。改动行为时也不容易漏掉某一段。
 *
 * 对外只认这个文件：`applyPackInstall` 是界面唯一入口（`applyPackCore`
 * 留给自检，因为它不跑 CubeMX、不用等几十秒）。
 */

export { renderConfig, renderBind, renderGenerated, generatedNote } from './render'
export { planPackInstall, type PlanOptions } from './plan'
export { applyPackCore, type ApplyOptions, type ApplyStep } from './apply'
export { applyPackInstall } from './postApply'
