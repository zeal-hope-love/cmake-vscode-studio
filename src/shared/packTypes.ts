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
  hint?: string
}

export interface PackFileSpec {
  from: string
  to: string
}

export interface PackGeneratedSpec {
  template: string
  to: string
}

export type PackPatchAction = 'add-sources' | 'insert-task' | 'define'

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
  /** 找不到目标就跳过（不报错） */
  optional?: boolean
  note?: string
}

export interface PackRequires {
  headers?: string[]
  optionalHeaders?: string[]
  symbols?: string[]
}

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
}

export interface PackBindings {
  pids: PidBinding[]
  channels: ChannelBinding[]
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
}

export interface PackApplyResult {
  ok: boolean
  written: string[]
  skipped: string[]
  errors: string[]
  snapshotId: string | null
}
