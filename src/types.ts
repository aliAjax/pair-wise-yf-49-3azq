export type Party = "原告" | "被告" | "审判庭";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";
export type DeviceId = "operator" | "public";

/** 来源标记：旧数据升级时补齐，证据不能丢 */
export interface SourceMeta {
  sourceDevice?: DeviceId | "legacy";
  sourceRev?: number;
  sessionId?: string;
}

export interface Evidence extends SourceMeta {
  id: string;
  exhibitNo: string;
  title: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  sensitive: boolean;
  status: EvidenceStatus;
  note: string;
}

export interface Objection extends SourceMeta {
  id: string;
  evidenceId: string;
  ground: string;
  explanation: string;
  status: "待裁定" | "支持" | "驳回" | "失效";
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Party | "书记员" | "系统";
  action: string;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}

/** 离线改动：每次改动都记下设备、场次和基线 */
export interface ChangeMeta {
  id: string;
  device: DeviceId;
  sessionId: string;
  baselineRev: number;
  /** ISO 时间 */
  at: string;
  /** 同批次内的单调序号，保证重放顺序 */
  seq: number;
}

export type OfflineChange = ChangeMeta &
  (
    | { kind: "order"; fromOrder: string[]; order: string[] }
    | { kind: "sensitive"; evidenceId: string; from: boolean; to: boolean }
    | { kind: "status"; evidenceId: string; from: EvidenceStatus; to: EvidenceStatus }
    | { kind: "select"; evidenceId: string; fromId: string | null }
    | { kind: "phase"; from: SessionPhase; to: SessionPhase }
    | { kind: "objectionAdd"; evidenceId: string; objection: Objection }
    | { kind: "objectionResolve"; evidenceId: string; objectionId: string; from: Objection["status"]; to: "支持" | "驳回" }
  );

export type ConflictField = "order" | "sensitive" | "status" | "display" | "objection";

/** 同一处双方都动过：保留两份待确认 */
export interface ConflictEntry {
  id: string;
  evidenceId: string;
  field: ConflictField;
  operatorChangeId: string;
  publicChangeId: string;
  operatorValue: string | number | boolean;
  publicValue: string | number | boolean;
  /** 两份原始改动都保留，确认时按所选的一份并入 */
  operatorChange?: OfflineChange;
  publicChange?: OfflineChange;
  createdAt: string;
  resolution?: { choice: DeviceId; at: string };
}

export interface MergeReport {
  id: string;
  at: string;
  reason: "reconnect" | "confirm" | "retry" | "legacy";
  newRev: number;
  applied: number;
  conflicts: number;
  unmatched: number;
  recalced: boolean;
  notes: string[];
}

export interface UnmatchedChange {
  change: OfflineChange;
  reason: string;
  at: string;
}

/** 每个基线版本的轻量快照，用来判断改动对不对得上快照 */
export interface RevisionSnapshot {
  rev: number;
  at: string;
  currentEvidenceId: string | null;
  phase: SessionPhase;
  order: string[];
  items: Record<string, { orderIndex: number; sensitive: boolean; status: EvidenceStatus }>;
  objections: Record<string, Objection["status"]>;
}

/** 已确认（公开屏可展示）的权威内容 */
export interface ConfirmedState {
  evidence: Evidence[];
  objections: Objection[];
  currentEvidenceId: string | null;
  phase: SessionPhase;
}

export interface SyncState {
  device: DeviceId;
  sessionId: string;
  revision: number;
  perDeviceRev: Record<DeviceId, number>;
  history: RevisionSnapshot[];
  confirmed: ConfirmedState;
  outbox: OfflineChange[];
  conflicts: ConflictEntry[];
  reports: MergeReport[];
  unmatched: UnmatchedChange[];
  lastMergeAt: string | null;
}
