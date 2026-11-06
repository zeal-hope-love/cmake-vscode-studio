/**
 * 模块包相关类型的**转出层**。
 *
 * 真正的定义在 `shared/packTypes.ts` 和 `shared/vofaMap.ts`（它们各自有
 * 自己的解析/序列化逻辑，放一起会长得更大）。这里只是把它们和两个
 * IPC 入参/出参放一处，方便界面统一从 `@shared/types` import。
 */


// --------------------------------------------------------------------------
// 模块包（Pack）—— 类型定义在 packTypes.ts，这里转出去方便渲染进程用
// --------------------------------------------------------------------------

export type {
  ChannelBinding,
  PackApplyResult,
  PackBindings,
  PackChangeAction,
  PackCheck,
  PackCheckLevel,
  PackCompatReport,
  PackFeature,
  PackFileChange,
  PackManifest,
  PackParam,
  PackPatchSpec,
  PackPlan,
  PidBinding,
  PidCandidate,
  ParamBinding,
  PackUartOption
} from '../packTypes'

export type {
  SymbolNode,
  SymbolScanResult,
  SymbolValueType,
  SymbolAccess,
  VofaBinding,
  VofaBindingAccess,
  VofaMap
} from '../vofaMap'

/** packInspect 的返回：兼容性报告 + 可一键注册的 PID 候选 + 工程里已有的 vofa 文件 */
export interface PackInspectResult {
  report: import('../packTypes').PackCompatReport
  pidCandidates: import('../packTypes').PidCandidate[]
  existingFiles: string[]
  /** 符号名 → 声明它的头文件。生成 #include 要用（例如遥控器访问器） */
  symbolHeaders: Array<{ symbol: string; file: string }>
  /** 信号目录：全局变量 / 结构体成员 / 数组元素 / PID 组 */
  symbols: import('../vofaMap').SymbolScanResult
  /** 工程里已保存的映射表（application/vofa/vofa_map.json），没有则 null */
  savedMap: import('../vofaMap').VofaMap | null
}

/** packPlan / packApply 的入参 */
export interface PackPlanOptions {
  packId: string
  root: string
  params: Record<string, string | number | boolean>
  bindings: import('../packTypes').PackBindings
  /** 原始映射表；有的话会同时生成 application/vofa/vofa_map.json */
  map?: import('../vofaMap').VofaMap
  /** 工程里有旧版平铺的 vofa 文件时，是否顺手删掉（否则会重复定义符号） */
  removeLegacy?: boolean
  /** 覆盖包声明的「写完后跑不跑 CubeMX」（界面的勾选框直接透传） */
  runCubeMx?: boolean
}
