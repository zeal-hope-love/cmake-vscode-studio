/**
 * 「模块包（Pack）」的类型定义。
 *
 * 一个 pack 就是「往工程里装一坨代码 + 打几个补丁」的声明式描述。
 * vofa 是第一个包；以后想加 RTT 日志、简易 shell，塞一个新的 packs/<id>/ 就行。
 *
 * 三层分工（这是整个功能的关键）：
 *   ① files/      固定文件 —— 装一次就不动了（模块本体）
 *   ② *.tpl       工具生成 —— 参数变了、勾选变了就重新渲染（vofa_config.h / vofa_bind.c）
 *   ③ patches     对**工程已有文件**的改动 —— 只做一次，幂等
 */

export type PackParamType = 'enum' | 'number' | 'bool' | 'text'

export interface PackParam {
  key: string
  label: string
  type: PackParamType
  default: string | number | boolean
  options?: string[]
  /**
   * 枚举值 → 界面显示的中文。
   *
   * 不写就显示原值（`circular`）。技术词（`it` / `dma`）留着原样反而好认，
   * 但 `circular` / `normal` 这种光看单词猜不出「循环 / 单次」的，必须给标签。
   */
  optionLabels?: Record<string, string>
  /** 选项来自工程探测结果（目前支持 'uarts'：工程里的串口列表） */
  optionsFrom?: 'uarts'
  /**
   * 只在另一个参数等于某值时显示。
   *
   * 用了它，参数面板不会出现「接收方式选了逐字节中断，底下还挂着一个 DMA 模式」
   * 这种自相矛盾的组合 —— 不显示就不会被误以为生效了。
   */
  showIf?: { key: string; equals: string | number | boolean }
  /**
   * 依赖另一个参数：不满足时**置灰**而不是隐藏。
   *
   * 和 `showIf` 的区别是「用户还看不看得见」。
   * 「DMA 模式」就属于这种：接收方式没选 dma 时它确实不生效，
   * 但直接藏起来会让人以为这功能不存在（v1.4.1 就踩过这个坑 ——
   * 用户翻遍参数面板都说「没什么变化」）。置灰 + 一句「先把 X 选成 Y」
   * 才既不自相矛盾、又能被找到。
   */
  enableIf?: { key: string; equals: string | number | boolean }
  /** number / text 的约束，界面用 */
  min?: number
  max?: number
  step?: number
  hint?: string
}

export interface PackFileSpec {
  from: string
  to: string
  /** 给人看的说明：这个文件是干什么的、为什么要替换 */
  note?: string
}

/**
 * 生成文件用哪个渲染器。
 *
 * 以前这里是隐式的：代码里 `template.includes('config')` 猜，猜错就把
 * 变量表塞进绑定的模板，生成一堆语法错误的 .c。现在改为**包里必须写明**，
 * 猜不出来就直接拦在计划阶段，不落盘。
 */
export type PackRenderKind = 'config' | 'bind'

export interface PackGeneratedSpec {
  template: string
  to: string
  /** 用哪个渲染器渲染这个模板；不写会被 planPackInstall 判为清单错误 */
  render: PackRenderKind
  /** 改动清单里给这个文件加一句说明；不写按 render 给默认文案 */
  note?: string
}

export type PackPatchAction = 'add-sources' | 'insert-task' | 'define' | 'comment-out-handler'

export interface PackPatchSpec {
  file: string
  action: PackPatchAction
  /** add-sources 用 */
  sources?: string[]
  /** insert-task 用 */
  anchor?: string
  /** define 用 */
  name?: string
  value?: string
  /** comment-out-handler 用 */
  handler?: string
  /** 找不到目标就跳过（不报错） */
  optional?: boolean
  note?: string
}

// --------------------------------------------------------------------------
// VT13 这类「移植包」才用得上的扩展字段
//
// 之所以不放进 PackManifest 主体，是因为常规包（比如 vofa）只需要
// files + generated + patches。移植包要动的东西多得多：业务文件的字段替换、
// 状态机重写、.ioc 语义修改。这些字段对常规包是噪音，所以做成可选。
// --------------------------------------------------------------------------

/** 业务文件的字段替换（不整文件覆盖，只改访问遥控数据的表达式） */
export interface PackTransformSpec {
  file: string
  note?: string
}

/** 需要改状态机的文件（目前只有 shoot.c 用到） */
export interface PackStateMachineSpec {
  file: string
  /** 旧代码里的状态变量 */
  oldStateFields: string[]
  /** 新代码要维护的状态变量 */
  newStateFields: string[]
  note?: string
}

/** `.ioc` 的语义化修改 */
export interface PackIocChanges {
  usart?: Record<string, string | number>
  ipParameters?: string
  nvic?: string
  dma?: {
    ident: string
    streamCandidates?: string[]
    channel?: string
    modeNote?: string
  }
  note?: string
}

export interface PackRequires {
  headers?: string[]
  optionalHeaders?: string[]
  symbols?: string[]
}

/**
 * 模块包提供的能力。
 *
 * 之前那些卡片（④ 在线调参、⑤ 监看通道）是**无条件显示**的，
 * 于是「遥控模块 VT13」下面也冒出「调参目标」「监看通道」—— 那两样是
 * VOFA+ 特有的，VT13 根本用不上，纯属误导。
 *
 * 现在由每个包在 pack.json 里声明自己有什么，页面按声明渲染。
 * 没声明的包一个都不显示 —— 宁可少显示，也不要让人以为选错了模块。
 */
export type PackFeature = 'onlineTuning' | 'waveform'

export interface PackManifest {
  id: string
  name: string
  summary: string
  version: string
  icon?: string
  params: PackParam[]
  files: PackFileSpec[]
  generated: PackGeneratedSpec[]
  requires: PackRequires
  patches: PackPatchSpec[]
  manualSteps: string[]

  /** 这个包提供哪些可选能力；不写等于都没有 */
  features?: PackFeature[]

  /** 包里自带的默认模板；用户另存的模板与它们并列显示 */
  defaultPresets?: import('./templateFormat').PackDefaultPreset[]

  // ---- 移植包专属（可选）----
  /** 业务文件的字段替换 */
  transform?: PackTransformSpec[]
  /** 需要改状态机的文件 */
  stateMachine?: PackStateMachineSpec
  /** `.ioc` 的语义化修改 */
  iocChanges?: PackIocChanges
  /**
   * 按**参数**改 `.ioc`（串口 / 波特率 / 中断 / RX DMA），走常规包的流程：
   * 算进改动清单 → 一起落盘 → 可选地跑一遍 CubeMX。
   *
   * 和上面的 `iocChanges` 二选一：那个是写死的常量（VT13 固定 USART1 + 921600），
   * 这个是跟着用户在界面里选的参数走。
   */
  iocSetup?: PackIocSetup

  /** 包所在目录（绝对路径），运行时补上 */
  dir?: string
}

// --------------------------------------------------------------------------
// 兼容性检查
// --------------------------------------------------------------------------

export type PackCheckLevel = 'ok' | 'warn' | 'err' | 'info'

export interface PackCheck {
  level: PackCheckLevel
  label: string
  detail: string
  /** 工具替你做了什么适配 */
  adapted?: string
}

/** 工程里探测到的一个串口，界面用它生成「用哪个串口」的下拉选项 */
export interface PackUartOption {
  name: string
  irq: string
  handler: string
  txDma: string | null
  rxDma: string | null
  /**
   * `.ioc` 里 RX DMA 的实际工作模式。
   *
   * 这一项**只能从 .ioc 读**，源码里看不出来（`hdma_usart1_rx` 这个名字
   * 在 NORMAL / CIRCULAR 下完全一样）。没有 RX DMA 就是 null。
   */
  rxDmaMode: 'circular' | 'normal' | null
  handlerDefined: boolean
  /** 可能占用它的文件（从文件名猜的） */
  usedBy: string[]
}

export interface PackCompatReport {
  packId: string
  root: string
  /** 有没有致命问题（有就不能装） */
  blocked: boolean
  checks: PackCheck[]
  /** 根据探测结果推出来的参数默认值，会覆盖 pack.json 里的默认 */
  derived: Record<string, string | number | boolean>
  /** 工程里已经存在同名模块（说明装过或手工装过） */
  existingModule: boolean
  /** 工程里探测到的串口；界面用 optionsFrom: 'uarts' 生成下拉 */
  uarts: PackUartOption[]
}

// --------------------------------------------------------------------------
// 工程里的 PID 候选
// --------------------------------------------------------------------------

export interface PidCandidate {
  /** 唯一 id：`文件:行:名字` */
  id: string
  /** 字段/变量名 */
  name: string
  /** PID 结构体类型 */
  pidType: 'pid_type_def' | 'gimbal_PID_t'
  /** 是不是结构体成员（是的话注册时要给实例表达式） */
  isMember: boolean
  /** 所属结构体类型名（成员才有） */
  ownerType: string | null
  isArray: boolean
  /** 相对工程根的路径 */
  file: string
  line: number
  /** 给界面显示的一句提示，例如「yaw-> 或 pitch->」 */
  hint: string
  /**
   * 点「用这个」时预填的**完整表达式**。
   * 这是猜的，用户可以直接改 —— 但多数情况下改一下 yaw/pitch 就能用。
   */
  suggestedExpr: string
  /** 配套的判空表达式；为空表示不需要判空（例如 '.' 访问全局对象） */
  suggestedGuard: string
  /**
   * true = 工程里查不到这个类型对应的全局实例，表达式没法自动拼，
   * suggestedExpr 会留空，要用户自己填。**不猜** —— 猜错要编译才发现。
   */
  needsInstance?: boolean
}

// --------------------------------------------------------------------------
// 绑定项（用户在界面上勾出来的）
// --------------------------------------------------------------------------

export interface PidBinding {
  /** 参数前缀，生成 yaw_spd_kp / yaw_spd_ki ... */
  prefix: string
  pidType: 'pid_type_def' | 'gimbal_PID_t'
  /**
   * **完整的**访问表达式，例如 `get_yaw_motor_point()->gimbal_motor_gyro_pid`。
   *
   * 为什么不是「实例 + 字段」两段：那样生成代码就得知道实例的**类型**才能声明局部变量。
   * 直接写完整表达式的话，`get_yaw_motor_point()->字段` 本身就是合法 C，不需要类型。
   */
  expr: string
  /**
   * 可选的判空表达式。填了就会在它外面包一层 `if (guard != NULL)`。
   * 例如 `get_yaw_motor_point()` —— 原实现里就有这个判空，不能丢。
   * 用 `.` 访问全局对象时留空（对非指针判空是编译错误）。
   */
  guard?: string
  /** 声明这个字段的头文件（相对工程根）。界面从扫到的候选带过来，生成 #include 用 */
  include?: string
  /** 同 ChannelBinding.externDecl */
  externDecl?: string
}

export interface ChannelBinding {
  /** 通道名（回显用） */
  name: string
  /**
   * 直接注册的表达式，例如 `get_yaw_motor_point()->absolute_angle`。
   * 要求类型是 fp32（或能直接当 fp32 读的浮点量）。和 mirrorFrom 二选一。
   */
  expr?: string
  /**
   * 需要**镜像**的源表达式。填了就自动生成一个 static fp32 镜像变量，
   * 注册镜像的地址、并在每个周期把源值拷进去。
   *
   * 什么时候要用：源的类型不是 fp32 —— 最典型的是遥控器 `int16_t ch[5]`，
   * vofa_reg_channel 收的是 `const fp32 *`，类型对不上，只能镜像。
   */
  mirrorFrom?: string
  /** 同 PidBinding.guard */
  guard?: string
  /** 表达式里用到的符号声明在哪个头文件（例如 get_remote_control_point → remote_control.h） */
  include?: string
  /** 变量只在 .c 里定义、头文件没写 extern 时，生成器自己补的一行声明 */
  externDecl?: string
}

/** 单值可调参数：直接注册成 `vofa_reg_param("name", &(expr))` */
export interface ParamBinding {
  name: string
  expr: string
  guard?: string
  include?: string
  /** 同 ChannelBinding.externDecl */
  externDecl?: string
}

export interface PackBindings {
  pids: PidBinding[]
  channels: ChannelBinding[]
  /** 单值可调参数（float）。老代码不传也兼容 */
  params?: ParamBinding[]
}

// --------------------------------------------------------------------------
// 改动清单
// --------------------------------------------------------------------------

export type PackChangeAction = 'create' | 'overwrite' | 'patch' | 'delete' | 'skip'

export interface PackFileChange {
  /** 相对工程根 */
  path: string
  action: PackChangeAction
  /** 改动前内容；新建时为 null */
  before: string | null
  /** 改动后内容；skip 时为 null */
  after: string | null
  /** 这个文件是干什么的（给界面显示） */
  note: string
  /** 为什么跳过 */
  skipReason?: string
}

/**
 * 常规包里「直接改 .ioc 并让 CubeMX 重新生成」的声明。
 *
 * 为什么要做成声明而不是写死在代码里：不是每个包都需要动外设。
 * vofa 需要（波特率、RX DMA 只能在 .ioc 里配），换个纯软件的包就不该有这一步。
 */
export interface PackIocSetup {
  /** 参数名：哪个参数是串口（huart1） */
  uartParam: string
  /** 参数名：哪个参数是波特率 */
  baudParam: string
  /** 参数名：接收方式 it / dma */
  rxModeParam?: string
  /** 参数名：RX DMA 工作模式 circular / normal（只在 rxMode = dma 时有意义） */
  dmaModeParam?: string
  /** 参数名：是否由模块自己开中断 */
  builtinIrqParam?: string
  /** 参数名：中断优先级 */
  irqPriorityParam?: string
  /** 参数名：写完后跑不跑 CubeMX（bool 参数，和别的参数一起显示在面板上） */
  cubeMxParam?: string
  /** 没声明 cubeMxParam 时的默认值 */
  runCubeMx?: boolean
}

export interface PackPlan {
  packId: string
  root: string
  params: Record<string, string | number | boolean>
  bindings: PackBindings
  changes: PackFileChange[]
  /** 装完之后要用户自己做的手动步骤 */
  manualSteps: string[]
  /** 有没有致命问题 */
  blocked: boolean
  /** 真正会写几个文件 */
  writeCount: number
  /**
   * 这次的 `.ioc` 那一步。没有就是不改 .ioc。
   *
   * 和 `changes` 里的那一条 .ioc 记录不是重复：`changes` 是给 diff 看的，
   * 这里是给「写完要不要跑 CubeMX」用的。
   */
  ioc?: PackPlanIoc
}

export interface PackPlanIoc {
  /** 相对工程根 */
  relPath: string
  /** 改了哪几个键（人话） */
  notes: string[]
  warnings: string[]
  /** 这次要不要跑 CubeMX */
  runCubeMx: boolean
  /** 本机有没有装 CubeMX —— 没装就只能改 .ioc，代码得用户自己生成 */
  cubeMxFound: boolean
  /** HAL 句柄名，事后核对波特率用 */
  handle: string
  baud: number
}

/** 写入过程中的一步（界面拿它画进度） */
export interface PackApplyStep {
  id: 'write' | 'cubemx' | 'baud'
  label: string
  status: 'running' | 'ok' | 'warn' | 'err' | 'skip'
  detail?: string
}

export interface PackApplyResult {
  ok: boolean
  written: string[]
  skipped: string[]
  errors: string[]
  snapshotId: string | null
  /** CubeMX 那一步的结果；没跑就是 undefined */
  cubeMx?: {
    ok: boolean
    skipped: boolean
    detail: string
    changedFiles: string[]
    /** 最后几行日志，失败时给用户看 */
    log: string[]
  }
  /** 代码里实际的波特率核对结果（.ioc 改了但没重新生成时会对不上） */
  baudCheck?: { actual: number | null; match: boolean; detail: string }
}

// --------------------------------------------------------------------------
// 移植包（VT13 这类需要调外部程序的包）
// --------------------------------------------------------------------------

export interface PackPortPreflightItem {
  label: string
  level: 'ok' | 'warn' | 'err'
  detail: string
}

export interface PackPortPreflightResult {
  ok: boolean
  items: PackPortPreflightItem[]
  /** 找到的 .ioc 绝对路径 */
  iocPath: string | null
}

export interface PackPortStep {
  id: string
  label: string
  status: 'running' | 'ok' | 'warn' | 'err' | 'skip'
  detail?: string
}

export interface PackPortAcceptanceItem {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface PackPortResult {
  ok: boolean
  preflight: PackPortPreflightResult
  steps: PackPortStep[]
  acceptance: PackPortAcceptanceItem[]
  snapshotId: string | null
  errors: string[]
  warnings: string[]
}
