/**
 * 模块包的**渲染**：把模板 + 参数 + 工程事实变成一份完整的 .c/.h 全文。
 *
 * 只做字符串，不碰磁盘（模板从包里读，也是只读）。
 * 唯一的副作用是可能 **throw** —— 见下面 fillTemplate 的说明。
 *
 * ## 这里有两件事，别混
 *
 * 1. **通用**：读模板、填占位符、占位符残留就 throw —— `fillTemplate`
 * 2. **vofa 专用**：哪些参数变成哪些宏、绑定的注册体长什么样
 *
 * 第 2 类**不可能通用**：换一个包，参数叫什么都不一样，硬做成「配置驱动的
 * 模板引擎」只会发明一门新语言。所以路线是显式的 —— pack.json 的
 * `generated[].render` 声明用哪个渲染器（`config` / `bind`），
 * 代码里按声明查（`RENDERERS`），不做任何猜测。
 *
 * 以前是靠 `template.includes('config')` 猜的：模板一改名就猜错，
 * 变量表塞进绑定模板，写出一份编译不过的 .c，而报错指向的是
 * 「expected '=' before '{'」，完全看不出根因。
 */

import { posix } from 'node:path'
import type { PackBindings, PackGeneratedSpec, PackManifest, PackRenderKind } from '@shared/packTypes'
import { readPackFile, type ProjectFacts } from './packStore'
import { peripheralOf } from '../ioc/uart'

function now(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 把模板里的 ${X} 换掉，并**保证换得干净**。
 *
 * 残留占位符是最贵的一种错：生成的 .c 里会留一行 `${EXTERN_DECLS}`，
 * gcc 报的是「expected '=', ',', ';' … before '{' token」——完全指不到真原因。
 * 实际踩过一次：改了 packs/ 里的模板，但界面上跑的还是**旧的主进程**
 * （packs 是运行时从磁盘读的，主进程代码却还是老的），于是模板更新、变量没跟上。
 *
 * 所以这里宁可报错让写入中止，也不能写出编译不过的代码 ——
 * planPackInstall 会把异常变成 blocked，一个文件都不落盘。
 */
function fillTemplate(tpl: string, vars: Record<string, string | number | boolean>): string {
  const out = tpl.replace(/\$\{([A-Z_0-9]+)\}/g, (m, key: string) =>
    key in vars ? String(vars[key]) : m
  )
  const left = [...new Set(out.match(/\$\{[A-Z_0-9]+\}/g) ?? [])]
  if (left.length) {
    throw new Error(
      `模板里的 ${left.join('、')} 没有被替换 —— 当前运行的版本比 packs/ 里的模板旧。` +
        '重启工具（或用新版本覆盖安装）后再生成。为避免写出编译不过的代码，本次已中止，一个文件都没动。'
    )
  }
  return out
}

/** 生成配置文件（串口 / 频率 / 中断这些开关） */
export function renderConfig(
  pack: PackManifest,
  template: string,
  params: Record<string, string | number | boolean>,
  facts: ProjectFacts
): string {
  const tpl = readPackFile(pack.id, template)
  if (tpl === null) throw new Error(`包里找不到 ${template}`)

  const uart = String(params.uart ?? 'huart1').trim()
  // 用 peripheralOf 而不是拼 USART${n}：huart4/5/7/8 在芯片里叫 UART4…，
  // 拼出来 USART4_IRQn 这个名字根本不存在，编译期就找不到。
  const peripheral = peripheralOf(uart)
  if (!peripheral) throw new Error(`串口参数必须是 huartN（当前是 "${uart}"）`)
  const n = uart.replace(/^huart/i, '')

  const sendHz = Number(params.sendHz ?? 50)
  if (!Number.isInteger(sendHz) || sendHz < 1 || sendHz > 500) {
    throw new Error('波形发送频率必须是 1~500 的整数')
  }

  const irqPriority = Number(params.irqPriority ?? 5)
  if (!Number.isInteger(irqPriority) || irqPriority < 0 || irqPriority > 15) {
    throw new Error('中断优先级必须是 0~15 的整数')
  }

  const txFn = String(params.txFn ?? 'usart1_tx_dma_enable').trim()
  if (!/^[A-Za-z_]\w*$/.test(txFn)) throw new Error(`TX 发送函数名不合法："${txFn}"`)

  const txHeaderRaw = String(params.txHeader ?? '').trim()
  const txHeader = txHeaderRaw || facts.symbolHeaders.get(txFn) || 'bsp_usart.h'
  if (/[;"']/.test(txHeader) || txHeader.includes('..')) {
    throw new Error(`TX 头文件路径不合法："${txHeader}"`)
  }

  return fillTemplate(tpl, {
    GENERATED_AT: now(),
    HAS_STRUCT_TYPEDEF: params.hasStructTypedef ?? (facts.hasStructTypedef ? 1 : 0),
    // 只用文件名（basename）：这两个宏会被写成 #include "xxx.h"，带目录反而找不到
    UART_HEADER: posix.basename(facts.headers.get('usart.h') ?? 'usart.h'),
    TX_HEADER: posix.basename(txHeader),
    UART: uart,
    BAUD: Math.round(Number(params.baud ?? 115200)),
    IRQ: params.irq ? String(params.irq) : `${peripheral}_IRQn`,
    IRQ_HANDLER: params.irqHandler ? String(params.irqHandler) : `${peripheral}_IRQHandler`,
    IRQ_PRIORITY: irqPriority,
    TX_DMA: String(params.txDma ?? `hdma_usart${n}_tx`),
    TX_FN: txFn,
    RX_MODE: params.rxMode === 'dma' ? 1 : 2,
    /*
     * DMA 是循环还是单次 —— 必须和 .ioc 里写的一致。
     *
     * 单次模式下 DMA 每次空闲事件后就停，固件得在回调里重挂；循环模式一直跑，
     * 固件按偏移取增量。两边对不上就是「第一条命令能收到、后面全没反应」。
     */
    RX_DMA_CIRCULAR: String(params.dmaMode ?? 'circular').toLowerCase() === 'normal' ? 0 : 1,
    RX_DMA: `hdma_usart${n}_rx`,
    BUILTIN_IRQ: params.builtinIrq === false || params.builtinIrq === 'false' ? 0 : 1,
    SEND_HZ: sendHz
  })
}

/** 生成绑定文件 —— 你在界面上勾的东西全落在这一份文件里 */
export function renderBind(
  pack: PackManifest,
  template: string,
  bindings: PackBindings,
  facts: ProjectFacts
): string {
  const tpl = readPackFile(pack.id, template)
  if (tpl === null) throw new Error(`包里找不到 ${template}`)

  // ---- 需要哪些头文件 ----
  const incs = new Set<string>()
  if (bindings.pids.some((p) => p.pidType === 'pid_type_def')) {
    const h = facts.headers.get('pid.h')
    if (h) incs.add(h)
  }
  // 每个绑定项都能带 `include` —— 界面从「扫到的候选」把它声明在哪个头文件带过来。
  // 之前只对 gimbal_PID_t 生效，于是引用了 shoot_control / 遥控器访问器的绑定
  // 生成出来就报 undeclared。
  for (const p of bindings.pids) if (p.include) incs.add(p.include)
  for (const c of bindings.channels) if (c.include) incs.add(c.include)
  for (const p of bindings.params ?? []) if (p.include) incs.add(p.include)
  // 只用文件名：头文件由 -I 路径找，写成 "Inc/usart.h" 反而解析不到
  const extraIncludes = [...incs].map((h) => `#include "${posix.basename(h)}"`).join('\n')

  /**
   * 自动补声明：变量定义在 .c 里、头文件没写 extern 的那些。
   *
   * 为什么可以这么做：非 static 的全局变量在链接期是外部符号，
   * 只要有一个**声明**就能取地址。声明写在本文件里完全合法，
   * 于是用户不需要为了「让工具看见」去改自己的源文件。
   *
   * 有 include 的（头文件里已经声明过）不会出现在这里 —— 那些走 include 更干净。
   * static 的也不会（链接期是 local symbol，声明了也链不上）。
   */
  const decls = new Set<string>()
  for (const p of bindings.pids) if (p.externDecl) decls.add(p.externDecl)
  for (const c of bindings.channels) if (c.externDecl) decls.add(c.externDecl)
  for (const p of bindings.params ?? []) if (p.externDecl) decls.add(p.externDecl)
  const externDecls = decls.size
    ? [...decls].sort().join('\n')
    : '/* 没有需要补的声明（用到的变量都已经在头文件里声明过） */'

  // ---- PID 辅助函数：只在用得到的时候生成 ----
  const helpers: string[] = []
  const usesStd = bindings.pids.some((p) => p.pidType === 'pid_type_def')
  const usesGimbal = bindings.pids.some((p) => p.pidType === 'gimbal_PID_t')

  if (usesStd) {
    helpers.push(`/**
  * @brief  一键注册一组 pid_type_def 的 Kp/Ki/Kd/max_out/max_iout
  * @note   用函数而不是宏，是因为要取成员地址，宏里 &p->Kp 和逗号会打架
  */
static bool_t vofa_reg_pid_std(const char *prefix, pid_type_def *p)
{
    char name[VOFA_NAME_LEN_LOCAL];
    bool_t ok = true;

    snprintf(name, sizeof(name), "%s_kp", prefix);      ok = ok && vofa_reg_param(name, &p->Kp);
    snprintf(name, sizeof(name), "%s_ki", prefix);      ok = ok && vofa_reg_param(name, &p->Ki);
    snprintf(name, sizeof(name), "%s_kd", prefix);      ok = ok && vofa_reg_param(name, &p->Kd);
    snprintf(name, sizeof(name), "%s_maxout", prefix);  ok = ok && vofa_reg_param(name, &p->max_out);
    snprintf(name, sizeof(name), "%s_maxiout", prefix); ok = ok && vofa_reg_param(name, &p->max_iout);

    return ok;
}`)
  }
  if (usesGimbal) {
    helpers.push(`/**
  * @brief  一键注册一组 gimbal_PID_t 的 kp/ki/kd/max_out/max_iout
  * @note   这个结构体字段是小写的（kp/ki/kd），和 pid_type_def 不一样，所以单独一个函数
  */
static bool_t vofa_reg_pid_gimbal(const char *prefix, gimbal_PID_t *p)
{
    char name[VOFA_NAME_LEN_LOCAL];
    bool_t ok = true;

    snprintf(name, sizeof(name), "%s_kp", prefix);      ok = ok && vofa_reg_param(name, &p->kp);
    snprintf(name, sizeof(name), "%s_ki", prefix);      ok = ok && vofa_reg_param(name, &p->ki);
    snprintf(name, sizeof(name), "%s_kd", prefix);      ok = ok && vofa_reg_param(name, &p->kd);
    snprintf(name, sizeof(name), "%s_maxout", prefix);  ok = ok && vofa_reg_param(name, &p->max_out);
    snprintf(name, sizeof(name), "%s_maxiout", prefix); ok = ok && vofa_reg_param(name, &p->max_iout);

    return ok;
}`)
  }

  // ---- 绑定体 ----
  const lines: string[] = []
  if (!bindings.pids.length && !bindings.channels.length && !(bindings.params ?? []).length) {
    lines.push('    //（还没勾任何变量）—— 回工具里勾「调参目标」和「监看通道」')
  }
  /**
   * 把「同一个 guard 的若干条注册」合成一个 if 块。
   *
   * 为什么要判空：表达式常常长这样 `get_yaw_motor_point()->xxx`，
   * 而那个 getter 在模块还没初始化时可能返回 NULL。原实现里就判了，
   * 生成代码不能丢掉这一步 —— 启动阶段空指针直接硬件异常，很难查。
   * 用「直接调 getter」而不是「先存局部变量」是为了不需要知道实例的类型。
   */
  const emit = (items: Array<{ guard?: string; code: string }>, indent: string): void => {
    let i = 0
    while (i < items.length) {
      const g = items[i].guard?.trim()
      if (!g) {
        lines.push(indent + items[i].code)
        i += 1
        continue
      }
      // 连续的、guard 相同的合到一个 if 里
      let j = i
      while (j < items.length && items[j].guard?.trim() === g) j += 1
      lines.push(`${indent}if (${g} != NULL)`)
      lines.push(`${indent}{`)
      for (let k = i; k < j; k++) lines.push(`${indent}    ${items[k].code}`)
      lines.push(`${indent}}`)
      i = j
    }
  }

  if (bindings.pids.length) {
    lines.push('    //---- 可调参数（VOFA 里用 set 名字 值 改）----')
    emit(
      bindings.pids.map((p) => ({
        guard: p.guard,
        code:
          p.pidType === 'gimbal_PID_t'
            ? `(void)vofa_reg_pid_gimbal("${p.prefix}", (gimbal_PID_t *)&(${p.expr}));`
            : `(void)vofa_reg_pid_std("${p.prefix}", (pid_type_def *)&(${p.expr}));`
      })),
      '    '
    )
  }
  /**
   * 监看通道分两种：
   *   直接注册 —— 源本来就是 fp32（或能当 fp32 读）
   *   镜像注册 —— 源类型不是 fp32（遥控器 int16_t ch[5] 这种），
   *               先生成一个 static fp32 镜像，注册镜像地址，每个周期拷一次
   */
  const mirrors = bindings.channels.map((c, idx) => ({ c, idx })).filter((x) => x.c.mirrorFrom)

  if (bindings.channels.length) {
    if (bindings.pids.length) lines.push('')
    lines.push('    //---- 监看通道（顺序 = VOFA 里的 ch0、ch1…）----')
    emit(
      bindings.channels.map((c, idx) => ({
        guard: c.guard,
        code: c.mirrorFrom
          ? `(void)vofa_reg_channel("${c.name}", &vofa_mirror_${idx});`
          : `(void)vofa_reg_channel("${c.name}", &(${c.expr ?? c.name}));`
      })),
      '    '
    )
  }

  const params = bindings.params ?? []
  if (params.length) {
    lines.push('')
    lines.push('    //---- 可调参数（单值 float）----')
    emit(
      params.map((p) => ({
        guard: p.guard,
        code: `(void)vofa_reg_param("${p.name}", &(${p.expr}));`
      })),
      '    '
    )
  }

  const mirrorDecl =
    mirrors.length > 0
      ? mirrors
          .map(
            ({ c, idx }) =>
              `/* ${c.name}：源不是 fp32，用这个镜像寄存器注册 */\nstatic fp32 vofa_mirror_${idx};`
          )
          .join('\n')
      : '/* 没有需要镜像的通道 */'

  const tickBody = mirrors.length
    ? (() => {
        const out: string[] = ['    //把源值拷进镜像（类型不是 fp32 的那些通道）']
        let i = 0
        while (i < mirrors.length) {
          const g = mirrors[i].c.guard?.trim()
          const sameGuard = (k: number): boolean => mirrors[k].c.guard?.trim() === g
          if (!g) {
            out.push(`    vofa_mirror_${mirrors[i].idx} = (fp32)(${mirrors[i].c.mirrorFrom});`)
            i += 1
            continue
          }
          let j = i
          while (j < mirrors.length && sameGuard(j)) j += 1
          out.push(`    if (${g} != NULL)`)
          out.push('    {')
          for (let k = i; k < j; k++) {
            out.push(`        vofa_mirror_${mirrors[k].idx} = (fp32)(${mirrors[k].c.mirrorFrom});`)
          }
          out.push('    }')
          i = j
        }
        return out.join('\n')
      })()
    : '    //（没有需要镜像的通道）'

  return fillTemplate(tpl, {
    GENERATED_AT: now(),
    EXTRA_INCLUDES: extraIncludes,
    EXTERN_DECLS: externDecls,
    PID_HELPERS: helpers.join('\n\n'),
    MIRROR_DECL: mirrorDecl,
    BIND_BODY: lines.join('\n'),
    TICK_BODY: tickBody
  })
}

/**
 * 渲染器的登记表。**加新渲染器只改这里和 PackRenderKind**，
 * 调用方（plan.ts）不用动，也不会因为模板改名而走错分支。
 */
const RENDERERS: Record<
  PackRenderKind,
  (
    pack: PackManifest,
    template: string,
    inputs: RenderInputs,
    facts: ProjectFacts
  ) => string
> = {
  config: (pack, template, inputs, facts) => renderConfig(pack, template, inputs.params, facts),
  bind: (pack, template, inputs, facts) => renderBind(pack, template, inputs.bindings, facts)
}

export interface RenderInputs {
  params: Record<string, string | number | boolean>
  bindings: PackBindings
}

/** 一类生成文件在改动清单里显示什么 */
export function generatedNote(kind: PackRenderKind, spec: PackGeneratedSpec): string {
  if (spec.note) return spec.note
  return kind === 'config' ? '生成：串口 / 频率 / 开关' : '生成：调哪些变量'
}

/**
 * 按 pack.json 的声明渲染一份生成文件。
 *
 * `spec.render` 缺失时**直接报错**而不是猜：这条错误会变成计划里的
 * blocked 项，界面上一眼能看见「清单写错了」，而不是生成出一份
 * 编译不过的 .c 让人去猜。
 */
export function renderGenerated(
  pack: PackManifest,
  spec: PackGeneratedSpec,
  inputs: RenderInputs,
  facts: ProjectFacts
): string {
  const kind = spec.render
  if (!kind) {
    throw new Error(
      `pack.json 的 generated 项「${spec.template}」没写 render（config 或 bind）。` +
        '这是清单缺字段，不是模板的问题。'
    )
  }
  const render = RENDERERS[kind]
  if (!render) {
    throw new Error(
      `pack.json 的 generated 项「${spec.template}」声明了未知的 render: "${kind}"。` +
        `可选值：${Object.keys(RENDERERS).join(' / ')}`
    )
  }
  return render(pack, spec.template, inputs, facts)
}
