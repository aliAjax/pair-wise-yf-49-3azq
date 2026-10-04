export type Party = "原告" | "被告" | "审判庭";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";
export type DeviceId = "操作屏" | "公开屏";

export interface Evidence {
  id: string;
  exhibitNo: string;
  title: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  sensitive: boolean;
  status: EvidenceStatus;
  note: string;
  /** 最后修改来源设备（升级时补来源，证据不能丢） */
  device?: DeviceId;
  /** 所属场次 */
  sessionId?: string;
  /** 改动所基于的基线快照 id */
  baselineId?: string;
}

export interface Objection {
  id: string;
  evidenceId: string;
  ground: string;
  explanation: string;
  status: "待裁定" | "支持" | "驳回";
  /** 快照失配后失效的异议，重算时清理 */
  invalid?: boolean;
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Party | "书记员";
  action: string;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}

/** 离线改动记录：每次改动记下设备、场次和基线，重连后按证据条目合并 */
export interface ChangeRecord {
  id: string;
  device: DeviceId;
  sessionId: string;
  baselineId: string;
  /** 证据条目 id；顺序改动作用于整个列表时为 __list__ */
  evidenceId: string;
  field: string;
  before: unknown;
  after: unknown;
  time: string;
}

/** 基线快照：重连合并时的三方基准 */
export interface BaselineSnapshot {
  id: string;
  sessionId: string;
  time: string;
  evidence: Evidence[];
}

/** 同一处双方都动过 → 保留两份待确认，确认前公开屏先不动 */
export interface ConflictItem {
  id: string;
  evidenceId: string;
  field: string;
  label: string;
  baselineValue: unknown;
  operatorValue: unknown;
  publicValue: unknown;
  detectedAt: string;
}

/** 对不上快照的改动：展示状态、计时和异议失效并重算 */
export interface UnmatchedChange {
  changeId: string;
  device: DeviceId;
  evidenceId: string;
  field: string;
  reason: string;
}
