/**
 * 把模块包装进工程：渲染文件 → 生成补丁 → 出改动清单 → 落盘。
 *
 * 流程刻意分成两步：
 *   planPackInstall()  只算不写，返回每个文件的「改前 / 改后」全文，交给界面做 diff
 *   applyPackInstall() 落盘。**先存快照**，历史页能一键还原
 *
 * 补丁分三种，都尽量复用已有能力：
 *   · CMakeLists.txt 加源文件 → 复用「构建目标与源文件」那套编辑引擎（就地插入 + 可逆）
 *   · freertos.c 建任务       → 锚点插入，找不到锚点就跳过并说明
 *   · remote_control.c 加宏   → 在文件头 include 之后插一行，已存在则不重复加
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import type {
  PackApplyResult,
  PackBindings,
  PackFileChange,
  PackManifest,
  PackPlan
} from '@shared/packTypes'
import { buildCmakeModel } from './cmakeModel'
import { planSourceEdit } from './cmakeEdit'
import { inspectProject, listPacks, loadPack, readPackFile, type ProjectFacts } from './packStore'
import { captureSnapshot } from './snapshotStore'
import { recordWrite } from './historyStore'

// --------------------------------------------------------------------------
// 渲染
// --------------------------------------------------------------------------

function now(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fillTemplate(tpl: string, vars: Record<string, string | number | boolean>): string {
  return tpl.replace(/\$\{([A-Z_0-9]+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m))
}

/** 生成 vofa_config.h */
export function renderConfig(
  pack: PackManifest,
  params: Record<string, string | number | boolean>,
  facts: ProjectFacts
): string {
  const tpl = readPackFile(pack.id, 'vofa_config.h.tpl')
  if (tpl === null) throw new Error('包里找不到 vofa_config.h.tpl')

  const uart = String(params.uart ?? 'huart1')
  const n = uart.replace('huart', '')
  const txFn = 'usart1_tx_dma_enable'
  const txHeader = facts.symbolHeaders.get(txFn) ?? 'bsp_usart.h'

  return fillTemplate(tpl, {
    GENERATED_AT: now(),
    HAS_STRUCT_TYPEDEF: params.hasStructTypedef ?? (facts.hasStructTypedef ? 1 : 0),
    // 只用文件名（basename）：这两个宏会被写成 #include "xxx.h"，带目录反而找不到
    UART_HEADER: posix.basename(facts.headers.get('usart.h') ?? 'usart.h'),
    TX_HEADER: posix.basename(txHeader),
    UART: uart,
    IRQ: `USART${n}_IRQn`,
    IRQ_HANDLER: `USART${n}_IRQHandler`,
    IRQ_PRIORITY: 5,
    TX_DMA: `hdma_usart${n}_tx`,
    TX_FN: txFn,
    RX_MODE: params.rxMode === 'dma' ? 1 : 2,
    RX_DMA: `hdma_usart${n}_rx`,
    BUILTIN_IRQ: params.builtinIrq === false || params.builtinIrq === 'false' ? 0 : 1,
    SEND_HZ: Number(params.sendHz ?? 50)
  })
}

/** 生成 vofa_bind.c —— 你在界面上勾的东西全落在这一份文件里 */
export function renderBind(pack: PackManifest, bindings: PackBindings, facts: ProjectFacts): string {
  const tpl = readPackFile(pack.id, 'vofa_bind.c.tpl')
  if (tpl === null) throw new Error('包里找不到 vofa_bind.c.tpl')

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
  // 只用文件名：头文件由 -I 路径找，写成 "Inc/usart.h" 反而解析不到
  const extraIncludes = [...incs].map((h) => `#include "${posix.basename(h)}"`).join('\n')

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
  if (!bindings.pids.length && !bindings.channels.length) {
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

  const body = fillTemplate(tpl, {
    GENERATED_AT: now(),
    EXTRA_INCLUDES: extraIncludes,
    PID_HELPERS: helpers.join('\n\n'),
    MIRROR_DECL: mirrorDecl,
    BIND_BODY: lines.join('\n'),
    TICK_BODY: tickBody
  })
  return body
}

// --------------------------------------------------------------------------
// 补丁
// --------------------------------------------------------------------------

/** CMakeLists.txt 加源文件 —— 复用「构建目标与源文件」的编辑引擎 */
function patchCmake(
  root: string,
  sources: string[]
): { before: string; after: string; note: string } | null {
  const file = join(root, 'CMakeLists.txt')
  if (!existsSync(file)) return null
  const model = buildCmakeModel(file, root)
  const target = model.targets.find((t) => t.kind === 'executable') ?? model.targets[0]
  if (!target) return null
  const plan = planSourceEdit(model, { targetName: target.name, add: sources })
  return {
    before: plan.before,
    after: plan.after,
    note: `在目标 ${target.name} 里加 ${plan.added.length} 个源文件：${plan.notes.join('；')}`
  }
}

/** freertos.c 里建任务 */
function patchFreertos(
  root: string,
  facts: ProjectFacts
): { before: string; after: string; note: string } | null {
  const rel = facts.headers.get('freertos.c') ?? 'Src/freertos.c'
  const file = join(root, rel.split(posix.sep).join('\\'))
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  if (/vofa_task\s*\(/.test(text)) {
    return { before: text, after: text, note: 'freertos.c 里已经有 vofa_task 的创建代码，跳过' }
  }
  const anchor = '/* USER CODE END Header */'
  const i = text.indexOf(anchor)
  if (i < 0) return null

  const snippet = [
    '',
    '  /* --- vofa 在线调参任务（由 CMake / VSCode 工程配置器添加）--- */',
    '  osThreadDef(vofa, vofa_task, osPriorityNormal, 0, 512);',
    '  osThreadCreate(osThread(vofa), NULL);'
  ].join('\n')
  const at = i + anchor.length
  const after = `${text.slice(0, at)}\n${snippet}\n${text.slice(at)}`
  return { before: text, after, note: `在 ${rel} 的「${anchor}」之后插入 osThreadDef + osThreadCreate` }
}

/** 加一个宏（例如关掉 SBUS 往 USART1 的转发） */
function patchDefine(
  root: string,
  facts: ProjectFacts,
  name: string,
  value: string
): { before: string; after: string; note: string } | null {
  const rel = [...facts.headers.values()].find((v) => /remote_control\.c$/i.test(v))
  if (!rel) return null
  const file = join(root, rel.split(posix.sep).join('\\'))
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  // 已经定义过这个宏：要看**值**对不对，不能只看「存在就当没事」。
  // 例如工程里写的是 `#define SBUS_FORWARD_TO_USART1 1`（还开着转发），
  // 我们的目的是把它关掉，跳过等于没干活，USART1 照样被占用。
  const defined = new RegExp(`(^[ \\t]*#[ \\t]*define[ \\t]+${name}[ \\t]+)(\\S+)`, 'm').exec(text)
  if (defined) {
    if (defined[2] === value) {
      return { before: text, after: text, note: `${rel} 里 ${name} 已经是 ${value}，跳过` }
    }
    const after =
      text.slice(0, defined.index) + defined[1] + value + text.slice(defined.index + defined[0].length)
    return { before: text, after, note: `${rel} 里把 ${name} 从 ${defined[2]} 改成 ${value}` }
  }
  const block = [
    '',
    '/* 由 CMake / VSCode 工程配置器添加：关掉 SBUS 往 USART1 的转发，',
    '   把 USART1 的 TX 让给 vofa 波形用。想恢复改成 1 即可。 */',
    `#define ${name} ${value}`
  ].join('\n')
  // 插在第一个 #include 之后
  const m = /^#include[^\n]*\n/m.exec(text)
  if (!m) return null
  const at = (m.index ?? 0) + m[0].length
  return {
    before: text,
    after: `${text.slice(0, at)}${block}\n${text.slice(at)}`,
    note: `在 ${rel} 里加 #define ${name} ${value}`
  }
}

// --------------------------------------------------------------------------
// 预览
// --------------------------------------------------------------------------

export interface PlanOptions {
  packId: string
  root: string
  params: Record<string, string | number | boolean>
  bindings: PackBindings
  /** 工程里有旧版平铺的 vofa 文件时，是否顺手删掉（否则会重复定义符号） */
  removeLegacy?: boolean
}

export function planPackInstall(opts: PlanOptions, factsIn?: ProjectFacts): PackPlan {
  const pack = loadPack(opts.packId)
  if (!pack) {
    return {
      packId: opts.packId,
      root: opts.root,
      params: opts.params,
      bindings: opts.bindings,
      changes: [],
      manualSteps: [],
      blocked: true,
      writeCount: 0
    }
  }
  const facts = factsIn ?? inspectProject(opts.root)
  const changes: PackFileChange[] = []

  // ---- 固定文件 ----
  for (const spec of pack.files) {
    const content = readPackFile(pack.id, spec.from)
    if (content === null) continue
    const abs = join(opts.root, spec.to.split('/').join('\\'))
    const has = existsSync(abs)
    changes.push({
      path: spec.to,
      action: has ? 'overwrite' : 'create',
      before: has ? readFileSync(abs, 'utf8') : null,
      after: content,
      note: has ? '覆盖已存在的模块文件' : '新增模块文件'
    })
  }

  // ---- 生成文件 ----
  for (const spec of pack.generated) {
    let content: string
    if (spec.template.includes('config')) content = renderConfig(pack, opts.params, facts)
    else content = renderBind(pack, opts.bindings, facts)
    const abs = join(opts.root, spec.to.split('/').join('\\'))
    const has = existsSync(abs)
    changes.push({
      path: spec.to,
      action: has ? 'overwrite' : 'create',
      before: has ? readFileSync(abs, 'utf8') : null,
      after: content,
      note: spec.template.includes('config') ? '生成：串口 / 频率 / 开关' : '生成：调哪些变量'
    })
  }

  // ---- 旧版平铺文件 ----
  const legacy = facts.existingVofa.filter(
    (p) => /vofa_task\.[ch]$/i.test(p) && !p.startsWith('application/vofa/')
  )
  for (const p of [...new Set(legacy)]) {
    changes.push({
      path: p,
      action: opts.removeLegacy ? 'delete' : 'skip',
      before: readFileSync(join(opts.root, p.split(posix.sep).join('\\')), 'utf8'),
      after: null,
      note: '旧版平铺布局的 vofa 文件',
      skipReason: opts.removeLegacy
        ? undefined
        : `还在原地。装到 application/vofa/ 会和它**重复定义符号**，必须先删掉（或勾上「顺手删掉旧文件」）`
    })
  }

  // ---- 补丁 ----
  for (const spec of pack.patches) {
    let r: { before: string; after: string; note: string } | null = null
    if (spec.action === 'add-sources' && spec.sources) {
      r = patchCmake(opts.root, spec.sources)
    } else if (spec.action === 'insert-task') {
      r = patchFreertos(opts.root, facts)
    } else if (spec.action === 'define' && spec.name) {
      r = patchDefine(opts.root, facts, spec.name, spec.value ?? '0')
    }
    if (!r) {
      if (!spec.optional) {
        changes.push({
          path: spec.file,
          action: 'skip',
          before: null,
          after: null,
          note: spec.note ?? spec.action,
          skipReason: `找不到可改的位置（${spec.file}）—— 需要你手动处理`
        })
      }
      continue
    }
    changes.push({
      path: spec.file,
      action: r.before === r.after ? 'skip' : 'patch',
      before: r.before,
      after: r.after,
      note: r.note,
      skipReason: r.before === r.after ? '已经是目标状态，无需改动' : undefined
    })
  }

  const blocked = changes.some((c) => c.action === 'skip' && c.skipReason?.includes('重复定义'))

  return {
    packId: pack.id,
    root: opts.root,
    params: opts.params,
    bindings: opts.bindings,
    changes,
    manualSteps: pack.manualSteps ?? [],
    blocked,
    writeCount: changes.filter((c) => c.action !== 'skip').length
  }
}

// --------------------------------------------------------------------------
// 落盘
// --------------------------------------------------------------------------

export function applyPackInstall(plan: PackPlan): PackApplyResult {
  const res: PackApplyResult = { ok: false, written: [], skipped: [], errors: [], snapshotId: null }
  const todo = plan.changes.filter((c) => c.action !== 'skip')
  if (!todo.length) {
    res.ok = true
    return res
  }

  // 1) 快照必须在写之前 —— 新建的文件 previous 记 null，还原时会把它删掉
  try {
    res.snapshotId = captureSnapshot(
      plan.root,
      todo.map((c) => ({ relativePath: c.path, previous: c.before }))
    )
  } catch (err) {
    res.errors.push(`存快照失败，已中止：${(err as Error).message}`)
    return res
  }
  // captureSnapshot 存不下时会**吞掉异常返回 null**。这里必须当成失败处理：
  // 这一页给用户的承诺就是「先存快照，可一键还原」，没有快照还照写，
  // 等于把「改坏了能回去」变成一句空话。
  if (!res.snapshotId) {
    res.errors.push('没能存下快照，为避免改坏了无法还原，已中止写入（一个文件都没动）')
    return res
  }

  // 2) 写
  for (const c of todo) {
    const abs = join(plan.root, c.path.split(posix.sep).join('\\'))
    try {
      if (c.action === 'delete') {
        rmSync(abs, { force: true })
        res.written.push(`（删除）${c.path}`)
      } else if (c.after !== null) {
        // 目标目录可能还不存在（application/vofa/ 就是新建的）。
        // writeFileSync 不会替你建父目录 —— 漏了这步会抛 ENOENT，
        // 而且补丁那几步照样成功，留下「改了 CMakeLists 但没有源文件」的半成品。
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, c.after, 'utf8')
        res.written.push(c.path)
      }
    } catch (err) {
      res.errors.push(`${c.path}：${(err as Error).message}`)
    }
  }
  for (const c of plan.changes.filter((x) => x.action === 'skip')) res.skipped.push(c.path)

  // 3) 记历史
  try {
    const name = listPacks().find((p) => p.id === plan.packId)?.name ?? plan.packId
    recordWrite(
      plan.root,
      [`安装调试模块「${name}」（${res.written.length} 个文件）`],
      res.errors,
      res.snapshotId
    )
  } catch {
    /* 历史记不上不影响主流程 */
  }

  res.ok = res.errors.length === 0
  return res
}
