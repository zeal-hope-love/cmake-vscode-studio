/**
 * 任务与配置的 label 常量。
 *
 * 为什么单独抽一个 shared 文件：这些字符串必须**逐字**对上——
 *   · launch.json 的 `preLaunchTask` 要等于 tasks.json 里某个 task 的 `label`，
 *     差一个字 VSCode 就报「找不到 preLaunchTask」，调试直接起不来
 *   · 渲染进程（调试配置页）也要显示/生成同一个名字
 * 主进程和渲染进程各写一遍，漂移只是时间问题。
 */

/** 构建任务的 label；launch.json 的 preLaunchTask 用的就是它 */
export function buildTaskLabel(kind: 'debug' | 'release'): string {
  return kind === 'debug' ? '构建 Debug' : '构建 Release'
}

/** 烧录任务的 label */
export function flashTaskLabel(kind: 'debug' | 'release'): string {
  return kind === 'debug' ? '烧录并运行 Debug 固件' : '烧录并运行 Release 固件'
}
