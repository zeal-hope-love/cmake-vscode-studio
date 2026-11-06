/**
 * 主进程与渲染进程共享的类型定义 —— 也就是整个 IPC 的契约。
 *
 * 约定：所有跨进程传递的对象都必须是可结构化克隆的纯数据（不能有 Date、
 * class 实例、函数），因此这里全部用 string / number / boolean / null / 数组 / 对象。
 * 路径统一用 Windows 原生反斜杠字符串；写进 VSCode 配置时再转成正斜杠。
 *
 * ## 为什么拆成目录
 *
 * 原来是一个 1216 行的 `types.ts`，三端都 import 它 —— 改一个字段会让
 * 整个工程重编，读代码也很难定位。现在按域拆开，**对外路径不变**：
 * 所有地方继续写 `from '@shared/types'`，解析到这里。
 *
 * | 文件 | 装什么 |
 * | --- | --- |
 * | `project.ts`  | 工程探测结果（CMake 事实 / 芯片 / .vscode 现状 / 问题列表） |
 * | `tools.ts`    | 工具链路径与版本 |
 * | `debug.ts`    | 生成的 .vscode 配置形状（launch / tasks / c_cpp_properties） |
 * | `generate.ts` | 生成选项、待写文件、写入结果、快照 |
 * | `runtime.ts`  | 批量套用、进程运行与输出流 |
 * | `app.ts`      | 应用信息、模板、清理、写入历史 |
 * | `settings.ts` | 应用设置 + 默认值 |
 * | `cmake.ts`    | 构建目标与源文件页的契约 |
 * | `ipc.ts`      | 通道常量、StudioApi、Window 全局声明 |
 * | `pack.ts`     | 模块包类型的转出层 |
 *
 * 加新类型时先想「它属于哪个域」，别又往 index 里堆 —— 这个文件只做转发。
 */

export * from './project'
export * from './tools'
export * from './debug'
export * from './generate'
export * from './runtime'
export * from './app'
export * from './settings'
export * from './cmake'
export * from './ipc'
export * from './pack'
