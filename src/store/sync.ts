import type {
  ConflictEntry,
  ConfirmedState,
  DeviceId,
  Evidence,
  EvidenceStatus,
  Objection,
  OfflineChange,
  RevisionSnapshot,
  SessionPhase,
  SessionState,
  SyncState,
  UnmatchedChange,
} from "../types";

export const SESSION_ID = "S2026-民初-1084";
const HISTORY_LIMIT = 30;

let seqSource = 0;
export function nextSeq() {
  seqSource += 1;
  return seqSource;
}

export function deviceName(device: DeviceId | "legacy") {
  if (device === "operator") return "操作屏";
  if (device === "public") return "公开屏";
  return "旧数据";
}

/** 旧数据缺少设备和基线，升级时补来源，证据不能丢 */
export function migrateLegacy<T extends { sourceDevice?: string; sourceRev?: number; sessionId?: string }>(items: T[]): T[] {
  return items.map((item) =>
    item.sourceDevice
      ? item
      : { ...item, sourceDevice: "legacy" as const, sourceRev: 0, sessionId: SESSION_ID }
  );
}

export function snapshotFrom(rev: number, evidence: Evidence[], objections: Objection[], currentEvidenceId: string | null, phase: SessionPhase, at: string): RevisionSnapshot {
  return {
    rev,
    at,
    currentEvidenceId,
    phase,
    order: evidence.map((item) => item.id),
    items: Object.fromEntries(evidence.map((item, index) => [item.id, { orderIndex: index, sensitive: item.sensitive, status: item.status }])),
    objections: Object.fromEntries(objections.map((item) => [item.id, item.status])),
  };
}

export function createInitialSync(input: { evidence: Evidence[]; objections: Objection[]; currentEvidenceId: string | null; phase: SessionPhase; sessionId?: string }): SyncState {
  const sessionId = input.sessionId ?? SESSION_ID;
  const now = new Date().toISOString();
  const confirmed: ConfirmedState = {
    evidence: structuredClone(input.evidence),
    objections: structuredClone(input.objections),
    currentEvidenceId: input.currentEvidenceId,
    phase: input.phase,
  };
  return {
    device: "operator",
    sessionId,
    revision: 0,
    perDeviceRev: { operator: 0, public: 0 },
    history: [snapshotFrom(0, confirmed.evidence, confirmed.objections, confirmed.currentEvidenceId, confirmed.phase, now)],
    confirmed,
    outbox: [],
    conflicts: [],
    reports: [],
    unmatched: [],
    lastMergeAt: null,
  };
}

/**
 * 在线改动直接产生新基线。
 * 只推进操作屏自己的设备基线；公开屏的基线停在它最后确认的 rev，
 * 这样公开屏断网后重连，其改动才会被识别为基于旧基线。
 */
export function commitOnlineRevision(sync: SyncState, evidence: Evidence[], objections: Objection[], session: SessionState) {
  sync.revision += 1;
  sync.history.push(snapshotFrom(sync.revision, evidence, objections, session.currentEvidenceId, session.phase, new Date().toISOString()));
  if (sync.history.length > HISTORY_LIMIT) sync.history = historySlice(sync.history);
  sync.perDeviceRev.operator = sync.revision;
  sync.confirmed = {
    evidence: structuredClone(evidence),
    objections: structuredClone(objections),
    currentEvidenceId: session.currentEvidenceId,
    phase: session.phase,
  };
}

function historySlice(history: RevisionSnapshot[]) {
  return history.slice(-HISTORY_LIMIT);
}

export function tagSource<T extends { sourceDevice?: DeviceId | "legacy"; sourceRev?: number; sessionId?: string }>(item: T, device: DeviceId, rev: number, sessionId: string): T {
  return { ...item, sourceDevice: device, sourceRev: rev, sessionId };
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type ChangeBody = DistributiveOmit<OfflineChange, keyof { id: string; device: DeviceId; sessionId: string; baselineRev: number; at: string; seq: number }>;

export function makeChange(sync: SyncState, device: DeviceId, body: ChangeBody): OfflineChange {
  return {
    id: crypto.randomUUID(),
    device,
    sessionId: sync.sessionId,
    baselineRev: sync.perDeviceRev[device],
    at: new Date().toISOString(),
    seq: nextSeq(),
    ...body
  };
}

export function describeChange(change: OfflineChange): string {
  switch (change.kind) {
    case "order":
      return `调整证据顺序（${change.order.join(" → ")}）`;
    case "sensitive":
      return `${change.evidenceId} 敏感遮罩：${change.to ? "遮罩" : "公开"}`;
    case "status":
      return `${change.evidenceId} 展示状态改为「${change.to}」`;
    case "select":
      return `切换展示证据为 ${change.evidenceId}`;
    case "phase":
      return `庭审阶段切换为「${change.to}」`;
    case "objectionAdd":
      return `对 ${change.evidenceId} 提出${change.objection.ground}`;
    case "objectionResolve":
      return `异议 ${change.objectionId} 裁定为「${change.to}」`;
  }
}

export function describeValue(field: ConflictEntry["field"], value: string | number | boolean): string {
  if (field === "order") {
    try {
      return `顺序 ${(JSON.parse(String(value)) as string[]).join(" → ")}`;
    } catch {
      return String(value);
    }
  }
  if (field === "sensitive") return value ? "遮罩" : "公开";
  return String(value);
}

/** 公开屏未确认冲突未处理完前，公开屏先不动 */
export function isPublicFrozen(sync: SyncState): boolean {
  return sync.conflicts.some((entry) => !entry.resolution);
}

function targetKey(change: OfflineChange): string | null {
  switch (change.kind) {
    case "order":
      return "order";
    case "sensitive":
      return `sensitive:${change.evidenceId}`;
    case "status":
      return `status:${change.evidenceId}`;
    case "select":
      return "display";
    case "objectionResolve":
      return `obj:${change.objectionId}`;
    default:
      return null;
  }
}

function latestValue(change: OfflineChange): string | number | boolean {
  switch (change.kind) {
    case "order":
      return JSON.stringify(change.order);
    case "sensitive":
      return change.to;
    case "status":
      return change.to;
    case "select":
      return change.evidenceId;
    case "objectionResolve":
      return change.to;
    case "phase":
      return change.to;
    case "objectionAdd":
      return change.objection.id;
  }
}

/** 改动对不上快照：返回原因；对得上返回 null */
function mismatchReason(change: OfflineChange, snap: RevisionSnapshot | undefined): string | null {
  if (!snap) return "基线快照已不存在";
  switch (change.kind) {
    case "order":
      return JSON.stringify(change.fromOrder) === JSON.stringify(snap.order) ? null : "顺序与基线快照不一致";
    case "sensitive": {
      const item = snap.items[change.evidenceId];
      if (!item) return "证据在基线中不存在";
      return item.sensitive === change.from ? null : "遮罩状态与基线快照不一致";
    }
    case "status": {
      const item = snap.items[change.evidenceId];
      if (!item) return "证据在基线中不存在";
      return item.status === change.from ? null : "展示状态与基线快照不一致";
    }
    case "select":
      return snap.currentEvidenceId === change.fromId ? null : "当前展示与基线快照不一致";
    case "phase":
      return snap.phase === change.from ? null : "庭审阶段与基线快照不一致";
    case "objectionAdd": {
      const item = snap.items[change.evidenceId];
      if (!item) return "证据在基线中不存在";
      return null;
    }
    case "objectionResolve": {
      const status = snap.objections[change.objectionId];
      if (!status) return "异议在基线中不存在";
      return status === change.from ? null : "异议状态与基线快照不一致";
    }
  }
}

export interface ReconcileResult {
  applied: number;
  conflictsAdded: number;
  unmatchedAdded: number;
  recalced: boolean;
  newRev: number | null;
  notes: string[];
}

interface ReconcileDraft {
  evidence: Evidence[];
  objections: Objection[];
  session: SessionState;
  sync: SyncState;
}

/**
 * 重连后按证据条目合并：
 * - 双方都动过同一处 → 保留两份待确认，确认前公开屏不动
 * - 改动对不上快照 → 展示状态、计时和异议失效并重算
 * - 对不上的改动留待只补；已确认内容始终保住
 */
export function reconcile(draft: ReconcileDraft, reason: "reconnect" | "retry" | "legacy"): ReconcileResult {
  const notes: string[] = [];
  const sync = draft.sync;
  const now = new Date().toISOString();

  // 以已确认内容为底座，避免两边互相覆盖
  const work: ConfirmedState = {
    evidence: structuredClone(sync.confirmed.evidence),
    objections: structuredClone(sync.confirmed.objections),
    currentEvidenceId: sync.confirmed.currentEvidenceId,
    phase: sync.confirmed.phase,
  };

  const changes = [...sync.outbox].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
  const unmatched: UnmatchedChange[] = [];
  const valid: OfflineChange[] = [];
  let mismatched = false;

  // 每个设备从自己的基线出发，把自己此前的离线改动依次推演上去，
  // 再判断下一条改动对不对得上（同设备连续改同一条目不应被误判）
  const tip = new Map<DeviceId, RevisionSnapshot>();
  function snapshotFor(change: OfflineChange): RevisionSnapshot | undefined {
    const own = tip.get(change.device);
    if (own) return own;
    return sync.history.find((entry) => entry.rev === change.baselineRev);
  }
  function advanceTip(change: OfflineChange) {
    const current = snapshotFor(change);
    if (!current) return;
    const next: RevisionSnapshot = structuredClone(current);
    switch (change.kind) {
      case "order":
        next.order = [...change.order];
        next.order.forEach((id, index) => { if (next.items[id]) next.items[id].orderIndex = index; });
        break;
      case "sensitive":
        if (next.items[change.evidenceId]) next.items[change.evidenceId].sensitive = change.to;
        break;
      case "status":
        if (next.items[change.evidenceId]) next.items[change.evidenceId].status = change.to;
        break;
      case "select":
        next.currentEvidenceId = change.evidenceId;
        break;
      case "phase":
        next.phase = change.to;
        break;
      case "objectionResolve":
        if (next.objections[change.objectionId]) next.objections[change.objectionId] = change.to;
        break;
      case "objectionAdd":
        next.objections[change.objection.id] = "待裁定";
        break;
    }
    tip.set(change.device, next);
  }

  for (const change of changes) {
    if (change.sessionId !== sync.sessionId) {
      unmatched.push({ change, reason: `场次不一致（改动属于 ${change.sessionId}）`, at: now });
      continue;
    }
    const mismatch = mismatchReason(change, snapshotFor(change));
    if (mismatch?.startsWith("基线快照") || mismatch?.endsWith("不存在")) {
      // 对不上的改动立即出队，只在「未对上」列表中保留，等之后只补
      unmatched.push({ change, reason: mismatch, at: now });
      continue;
    }
    if (mismatch) {
      mismatched = true;
      notes.push(`${deviceName(change.device)}的「${describeChange(change)}」${mismatch}`);
    }
    valid.push(change);
    advanceTip(change);
  }

  // 未对上的改动从 outbox 移除（不参与本次重放，也不重复堆积）
  const unmatchedIds = new Set(unmatched.map((entry) => entry.change.id));
  if (unmatchedIds.size) sync.outbox = sync.outbox.filter((change) => !unmatchedIds.has(change.id));

  // 按条目找出双方都动过的同一处（每个设备只看该设备对该处的最后一次改动）
  const latest = new Map<string, { operator?: { change: OfflineChange; value: string | number | boolean }; public?: { change: OfflineChange; value: string | number | boolean } }>();
  for (const change of valid) {
    const key = targetKey(change);
    if (!key) continue;
    const bucket = latest.get(key) ?? {};
    bucket[change.device] = { change, value: latestValue(change) };
    latest.set(key, bucket);
  }

  const heldIds = new Set<string>();
  const supersededIds = new Set<string>();
  const newConflicts: ConflictEntry[] = [];

  for (const [key, bucket] of latest) {
    const field: ConflictEntry["field"] = key.startsWith("sensitive:") ? "sensitive" : key.startsWith("status:") ? "status" : key.startsWith("obj:") ? "objection" : key === "display" ? "display" : "order";
    const evidenceId = key.startsWith("sensitive:") || key.startsWith("status:")
      ? key.slice(key.indexOf(":") + 1)
      : bucket.operator?.change.kind === "select"
        ? String(bucket.operator.value)
        : bucket.public?.change.kind === "select"
          ? String(bucket.public.value)
          : field === "order"
            ? ""
            : bucket.operator?.change.kind === "objectionResolve"
              ? bucket.operator.change.evidenceId
              : "";

    if (bucket.operator && bucket.public) {
      if (bucket.operator.value !== bucket.public.value) {
        // 同一处双方都动过且不一致：保留两份待确认
        heldIds.add(bucket.operator.change.id);
        heldIds.add(bucket.public.change.id);
        newConflicts.push({
          id: crypto.randomUUID(),
          evidenceId,
          field,
          operatorChangeId: bucket.operator.change.id,
          publicChangeId: bucket.public.change.id,
          operatorValue: bucket.operator.value,
          publicValue: bucket.public.value,
          operatorChange: bucket.operator.change,
          publicChange: bucket.public.change,
          createdAt: now,
        });
      } else if (bucket.operator.change.at < bucket.public.change.at || (bucket.operator.change.at === bucket.public.change.at && bucket.operator.change.seq <= bucket.public.change.seq)) {
        // 双方改成同值：不冲突，保留先到的一条
        supersededIds.add(bucket.public.change.id);
      } else {
        supersededIds.add(bucket.operator.change.id);
      }
    }
    // 同一条目的旧改动被最新改动取代
    for (const change of valid) {
      if (targetKey(change) === key && change.id !== bucket.operator?.change.id && change.id !== bucket.public?.change.id) {
        supersededIds.add(change.id);
      }
    }
  }

  // 重放没有分歧的改动
  let applied = 0;
  let currentChanged = false;
  for (const change of valid) {
    if (heldIds.has(change.id) || supersededIds.has(change.id)) continue;
    applyChange(work, change);
    applied += 1;
    if (change.kind === "select") currentChanged = true;
    if (change.kind === "sensitive" || change.kind === "status") {
      const index = work.evidence.findIndex((entry) => entry.id === change.evidenceId);
      if (index >= 0) work.evidence[index] = tagSource(work.evidence[index], change.device, change.baselineRev, change.sessionId);
    }
  }

  // 被挂起的双方改动保留在 outbox 中，确认前公开屏先不动；
  // 被最新改动取代的旧改动（且未挂起）从 outbox 移除
  sync.outbox = sync.outbox.filter((change) => !supersededIds.has(change.id) || heldIds.has(change.id));

  // 对不上快照：展示状态、计时和异议失效并重算
  let recalced = false;
  if (mismatched) {
    const invalidated = recalc(work);
    recalced = true;
    currentChanged = true;
    if (invalidated.length) notes.push(`以下异议因证据已跳过/不存在而失效：${invalidated.join("、")}`);
    notes.push("已按合并后目录重算展示状态与计时");
  } else if (currentChanged) {
    const current = work.evidence.find((item) => item.id === work.currentEvidenceId);
    work.currentEvidenceId = current?.id ?? null;
  }

  // 未对上的改动按条目去重后保留，等待之后只补
  const knownUnmatched = new Set(sync.unmatched.map((entry) => entry.change.id));
  for (const entry of unmatched) {
    if (!knownUnmatched.has(entry.change.id)) sync.unmatched.push(entry);
  }
  sync.unmatched = sync.unmatched.slice(0, 50);
  sync.conflicts = [...newConflicts, ...sync.conflicts];

  let newRev: number | null = null;
  if (applied > 0 || newConflicts.length > 0) {
    newRev = sync.revision + 1;
    sync.revision = newRev;
    sync.history.push(snapshotFrom(newRev, work.evidence, work.objections, work.currentEvidenceId, work.phase, now));
    if (sync.history.length > HISTORY_LIMIT) sync.history = sync.history.slice(-HISTORY_LIMIT);
    const participants = new Set(
      valid
        .filter((change) => !heldIds.has(change.id) && !supersededIds.has(change.id))
        .map((change) => change.device)
    );
    for (const device of participants) sync.perDeviceRev[device] = newRev;
  }

  sync.confirmed = work;
  draft.evidence = work.evidence;
  draft.objections = work.objections;
  draft.session.currentEvidenceId = work.currentEvidenceId;
  draft.session.phase = work.phase;
  draft.session.timerSeconds = currentChanged ? (work.evidence.find((item) => item.id === work.currentEvidenceId)?.duration ?? 0) * 60 : draft.session.timerSeconds;
  sync.lastMergeAt = now;

  const report = {
    id: crypto.randomUUID(),
    at: now,
    reason,
    newRev: newRev ?? sync.revision,
    applied,
    conflicts: newConflicts.length,
    unmatched: unmatched.length,
    recalced,
    notes,
  };
  sync.reports = [report, ...sync.reports].slice(0, 10);

  return { applied, conflictsAdded: newConflicts.length, unmatchedAdded: unmatched.length, recalced, newRev, notes };
}

function applyOrder(list: Evidence[], order: string[]): Evidence[] {
  const byId = new Map(list.map((item) => [item.id, item]));
  const known = order.filter((id) => byId.has(id));
  const missing = list.filter((item) => !order.includes(item.id)); // 证据不能丢
  return [...known.map((id) => byId.get(id)!), ...missing];
}

function applyChange(work: ConfirmedState, change: OfflineChange) {
  switch (change.kind) {
    case "order":
      work.evidence = applyOrder(work.evidence, change.order);
      break;
    case "sensitive": {
      const item = work.evidence.find((entry) => entry.id === change.evidenceId);
      if (item) item.sensitive = change.to;
      break;
    }
    case "status": {
      const item = work.evidence.find((entry) => entry.id === change.evidenceId);
      if (item) item.status = change.to;
      break;
    }
    case "select": {
      if (work.evidence.some((entry) => entry.id === change.evidenceId)) work.currentEvidenceId = change.evidenceId;
      break;
    }
    case "phase":
      work.phase = change.to;
      break;
    case "objectionAdd":
      if (!work.objections.some((entry) => entry.id === change.objection.id)) {
        work.objections.unshift(tagSource(structuredClone(change.objection), change.device, change.baselineRev, change.sessionId));
      }
      break;
    case "objectionResolve": {
      const objection = work.objections.find((entry) => entry.id === change.objectionId);
      if (objection) {
        objection.status = change.to;
        if (change.to === "支持") {
          const item = work.evidence.find((entry) => entry.id === change.evidenceId);
          if (item) item.status = "已跳过";
        }
      }
      break;
    }
  }
}

/** 展示状态、计时和异议重算，返回失效异议描述 */
function recalc(work: ConfirmedState): string[] {
  const showing = work.evidence.filter((item) => item.status === "展示中");
  if (showing.length > 1) {
    const keep = work.currentEvidenceId;
    for (const item of showing) {
      if (item.id !== keep) item.status = "已展示";
    }
  }
  if (work.currentEvidenceId && !work.evidence.some((item) => item.id === work.currentEvidenceId)) {
    work.currentEvidenceId = null;
  }

  const invalidated: string[] = [];
  for (const objection of work.objections) {
    if (objection.status !== "待裁定") continue;
    const item = work.evidence.find((entry) => entry.id === objection.evidenceId);
    if (!item) {
      objection.status = "失效";
      invalidated.push(`${objection.id}（证据已不存在）`);
    } else if (item.status === "已跳过") {
      objection.status = "失效";
      invalidated.push(`${objection.ground}（${item.exhibitNo} 已跳过）`);
    }
  }
  return invalidated;
}

/** 确认冲突：把所选一方的内容并入已确认基线；多个冲突按同一底座串行确认 */
export function resolveConflict(draft: ReconcileDraft, conflictId: string, choice: DeviceId): boolean {
  const conflict = draft.sync.conflicts.find((entry) => entry.id === conflictId);
  if (!conflict || conflict.resolution) return false;
  const chosen = choice === "operator" ? conflict.operatorChange : conflict.publicChange;
  if (chosen) {
    applyChange(draft.sync.confirmed, chosen);
  } else {
    applyResolutionValue(draft, conflict, choice);
  }
  conflict.resolution = { choice, at: new Date().toISOString() };

  // 这一处的两份改动都已处理完
  draft.sync.outbox = draft.sync.outbox.filter((entry) => entry.id !== conflict.operatorChangeId && entry.id !== conflict.publicChangeId);

  // 视图始终从已确认底座派生，避免多个冲突确认后互相覆盖
  draft.evidence = structuredClone(draft.sync.confirmed.evidence);
  draft.objections = structuredClone(draft.sync.confirmed.objections);
  draft.session.currentEvidenceId = draft.sync.confirmed.currentEvidenceId;
  draft.session.phase = draft.sync.confirmed.phase;

  const now = conflict.resolution.at;
  draft.sync.revision += 1;
  draft.sync.history.push(snapshotFrom(draft.sync.revision, draft.evidence, draft.objections, draft.session.currentEvidenceId, draft.session.phase, now));
  if (draft.sync.history.length > HISTORY_LIMIT) draft.sync.history = draft.sync.history.slice(-HISTORY_LIMIT);
  draft.sync.perDeviceRev.operator = draft.sync.revision;
  draft.sync.perDeviceRev.public = draft.sync.revision;
  if (conflict.field === "display" || conflict.field === "order") {
    draft.session.timerSeconds = (draft.evidence.find((item) => item.id === draft.session.currentEvidenceId)?.duration ?? 0) * 60;
  }
  const remaining = draft.sync.conflicts.filter((entry) => !entry.resolution).length;
  draft.sync.reports = [{
    id: crypto.randomUUID(),
    at: now,
    reason: "confirm" as const,
    newRev: draft.sync.revision,
    applied: 1,
    conflicts: remaining,
    unmatched: draft.sync.unmatched.length,
    recalced: false,
    notes: [remaining === 0 ? "全部冲突已确认，公开屏恢复同步" : `还有 ${remaining} 处冲突待确认，公开屏保持冻结`],
  }, ...draft.sync.reports].slice(0, 10);
  return remaining === 0;
}

// 冲突条目已保存两份原始改动；万一旧数据没有保存，则按保留值直接套用
function applyResolutionValue(draft: ReconcileDraft, conflict: ConflictEntry, choice: DeviceId) {
  const value = choice === "operator" ? conflict.operatorValue : conflict.publicValue;
  switch (conflict.field) {
    case "order":
      draft.evidence = applyOrder(draft.evidence, JSON.parse(String(value)) as string[]);
      break;
    case "sensitive": {
      const item = draft.evidence.find((entry) => entry.id === conflict.evidenceId);
      if (item) item.sensitive = Boolean(value);
      break;
    }
    case "status": {
      const item = draft.evidence.find((entry) => entry.id === conflict.evidenceId);
      if (item) item.status = value as EvidenceStatus;
      break;
    }
    case "display":
      if (draft.evidence.some((item) => item.id === String(value))) draft.session.currentEvidenceId = String(value);
      break;
    case "objection": {
      const objection = draft.objections.find((entry) => entry.evidenceId === conflict.evidenceId && (entry.status === "待裁定"));
      if (objection) objection.status = value as "支持" | "驳回";
      break;
    }
  }
}

/** 合并失败后只补没对上的：把未对上的改动重新放入 outbox 再合并 */
export function retryUnmatched(draft: ReconcileDraft): ReconcileResult {
  const pending = draft.sync.unmatched;
  if (!pending.length) {
    return { applied: 0, conflictsAdded: 0, unmatchedAdded: 0, recalced: false, newRev: null, notes: ["没有待补的改动"] };
  }
  draft.sync.unmatched = [];
  draft.sync.outbox.push(...pending.map((entry) => entry.change));
  return reconcile(draft, "retry");
}

/** 公开屏断网期间的本地动作（不直接改动操作屏 live 状态，重连时再合并） */
export function simulatePublicChange(sync: SyncState, action: "revert-order" | "toggle-mask" | "switch-display"): OfflineChange | null {
  // 公开屏最后同步到的基线（rev 之后操作屏可能又产生了新基线）
  const snap = sync.history.find((entry) => entry.rev === sync.perDeviceRev.public) ?? sync.history[0];
  if (!snap) return null;
  let change: OfflineChange | null = null;
  if (action === "revert-order") {
    const oldest = sync.history[0];
    // 公开屏本地改回旧顺序：它只知道自己的基线，from 对得上自己的快照即可
    change = makeChange(sync, "public", { kind: "order", fromOrder: snap.order, order: oldest.order });
  } else if (action === "toggle-mask") {
    const targetId = snap.order.find((id) => snap.items[id]) ?? snap.order[0];
    const from = snap.items[targetId]?.sensitive ?? false;
    change = makeChange(sync, "public", { kind: "sensitive", evidenceId: targetId, from, to: !from });
  } else {
    const targetId = snap.order.find((id) => id !== snap.currentEvidenceId) ?? snap.order[0];
    change = makeChange(sync, "public", { kind: "select", evidenceId: targetId, fromId: snap.currentEvidenceId });
  }
  if (change) sync.outbox.push(change);
  return change;
}
