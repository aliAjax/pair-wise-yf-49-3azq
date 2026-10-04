import { createSlice, current, isDraft, type Draft, type PayloadAction } from "@reduxjs/toolkit";
import type { BaselineSnapshot, ChangeRecord, ConflictItem, DeviceId, Evidence, Objection, SessionPhase, SessionState, TimelineEntry, UnmatchedChange } from "../types";

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定" },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩" },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45" }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

const DEFAULT_SESSION_ID = "session-001";
const DEFAULT_BASELINE_ID = "baseline-001";

const FIELD_LABELS: Record<string, string> = {
  exhibitNo: "证据编号",
  title: "标题",
  type: "证据类型",
  duration: "时长",
  presenter: "举证方",
  sensitive: "敏感遮罩",
  status: "展示状态",
  note: "备注",
  order: "证据顺序",
  __remove__: "证据删除",
  __snapshot__: "快照恢复"
};

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  online: boolean;
  // —— 离线同步 ——
  sessionId: string;
  baseline: BaselineSnapshot;
  operatorChanges: ChangeRecord[];
  publicChanges: ChangeRecord[];
  conflicts: ConflictItem[];
  unmatched: UnmatchedChange[];
  lastConfirmed: Evidence[];
  mergeStatus: "idle" | "merging" | "conflict" | "failed" | "synced";
  publicFrozen: boolean;
  invalidated: { status: boolean; timer: boolean; objections: boolean };
}

function buildBaseline(evidence: Evidence[], sessionId: string, id = `baseline-${Date.now()}`): BaselineSnapshot {
  return { id, sessionId, time: new Date().toISOString(), evidence: deepClone(evidence) };
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [],
  session: seedSession,
  online: true,
  sessionId: DEFAULT_SESSION_ID,
  baseline: buildBaseline(seedEvidence, DEFAULT_SESSION_ID, DEFAULT_BASELINE_ID),
  operatorChanges: [],
  publicChanges: [],
  conflicts: [],
  unmatched: [],
  lastConfirmed: deepClone(seedEvidence),
  mergeStatus: "idle",
  publicFrozen: false,
  invalidated: { status: false, timer: false, objections: false }
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** structuredClone 无法直接克隆 Immer 草稿，先 current() 取普通副本 */
function deepClone<T>(value: T): T {
  if (isDraft(value)) return structuredClone(current(value as Draft<T>));
  return structuredClone(value);
}

/** 记下一次离线改动：设备、场次、基线 */
function recordChange(state: State, device: DeviceId, evidenceId: string, field: string, before: unknown, after: unknown) {
  const change: ChangeRecord = {
    id: crypto.randomUUID(),
    device,
    sessionId: state.sessionId,
    baselineId: state.baseline.id,
    evidenceId,
    field,
    before,
    after,
    time: new Date().toISOString()
  };
  if (device === "操作屏") state.operatorChanges.push(change);
  else state.publicChanges.push(change);
}

/** 在基线上回放某一侧的改动，得到该侧版本；对不上快照的改动记入 unmatched */
function applyChanges(baseline: Evidence[], changes: ChangeRecord[], device: DeviceId, unmatched: UnmatchedChange[]): Evidence[] {
  const result = deepClone(baseline);
  for (const change of changes) {
    if (change.field === "__snapshot__") {
      // 快照恢复：整体替换
      result.splice(0, result.length, ...deepClone(change.after as Evidence[]));
      continue;
    }
    if (change.field === "order") {
      const ids = change.after as string[];
      result.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      continue;
    }
    const item = result.find((entry) => entry.id === change.evidenceId);
    if (!item) {
      unmatched.push({ changeId: change.id, device, evidenceId: change.evidenceId, field: change.field, reason: "证据条目在基线中不存在" });
      continue;
    }
    if (!(change.field in item)) {
      unmatched.push({ changeId: change.id, device, evidenceId: change.evidenceId, field: change.field, reason: "字段在基线证据上不存在" });
      continue;
    }
    if (!equal((item as unknown as Record<string, unknown>)[change.field], change.before)) {
      unmatched.push({ changeId: change.id, device, evidenceId: change.evidenceId, field: change.field, reason: "改动前值与当前状态不一致（基线已过期）" });
      continue;
    }
    (item as unknown as Record<string, unknown>)[change.field] = change.after;
  }
  return result;
}

/** 按证据条目三方合并；同一处双方都动过且不一致 → 冲突待确认 */
function mergeThreeWay(
  baseline: Evidence[],
  operatorChanges: ChangeRecord[],
  publicChanges: ChangeRecord[]
): { merged: Evidence[]; conflicts: ConflictItem[]; unmatched: UnmatchedChange[] } {
  const conflicts: ConflictItem[] = [];
  const unmatched: UnmatchedChange[] = [];
  const operatorVersion = applyChanges(baseline, operatorChanges, "操作屏", unmatched);
  const publicVersion = applyChanges(baseline, publicChanges, "公开屏", unmatched);

  const merged: Evidence[] = [];
  const allIds = new Set<string>([...baseline.map((e) => e.id), ...operatorVersion.map((e) => e.id), ...publicVersion.map((e) => e.id)]);
  const fields = ["exhibitNo", "title", "type", "duration", "presenter", "sensitive", "status", "note"] as const;

  for (const id of allIds) {
    const b = baseline.find((e) => e.id === id);
    const o = operatorVersion.find((e) => e.id === id);
    const p = publicVersion.find((e) => e.id === id);

    if (!b) {
      // 离线新增：证据不能丢，保留；双方新增同一 id 且内容一致则合并，否则冲突
      if (o && p) {
        if (equal(o, p)) merged.push(deepClone(o));
        else {
          conflicts.push({ id: crypto.randomUUID(), evidenceId: id, field: "__remove__", label: "新增证据", baselineValue: null, operatorValue: deepClone(o), publicValue: deepClone(p), detectedAt: new Date().toISOString() });
          merged.push(deepClone(o));
        }
      } else if (o) merged.push(deepClone(o));
      else if (p) merged.push(deepClone(p));
      continue;
    }

    if (!o && !p) { merged.push(deepClone(b)); continue; }
    if (!o || !p) {
      // 一侧删除、一侧仍保留 → 冲突，保留基线待确认
      const kept = o ?? p!;
      conflicts.push({ id: crypto.randomUUID(), evidenceId: id, field: "__remove__", label: "证据删除", baselineValue: deepClone(b), operatorValue: o ? null : deepClone(kept), publicValue: p ? null : deepClone(kept), detectedAt: new Date().toISOString() });
      merged.push(deepClone(b));
      continue;
    }

    const mergedItem = deepClone(b);
    for (const field of fields) {
      const bv = (b as unknown as Record<string, unknown>)[field];
      const ov = (o as unknown as Record<string, unknown>)[field];
      const pv = (p as unknown as Record<string, unknown>)[field];
      const oChanged = !equal(bv, ov);
      const pChanged = !equal(bv, pv);
      if (oChanged && pChanged) {
        if (equal(ov, pv)) (mergedItem as unknown as Record<string, unknown>)[field] = ov;
        else {
          conflicts.push({ id: crypto.randomUUID(), evidenceId: id, field, label: FIELD_LABELS[field] ?? field, baselineValue: bv, operatorValue: ov, publicValue: pv, detectedAt: new Date().toISOString() });
          (mergedItem as unknown as Record<string, unknown>)[field] = bv; // 确认前先停在基线
        }
      } else if (oChanged) {
        (mergedItem as unknown as Record<string, unknown>)[field] = ov;
      } else if (pChanged) {
        (mergedItem as unknown as Record<string, unknown>)[field] = pv;
      }
    }
    merged.push(mergedItem);
  }

  // 顺序合并
  const bOrder = baseline.map((e) => e.id);
  const oOrder = operatorVersion.map((e) => e.id);
  const pOrder = publicVersion.map((e) => e.id);
  const oOrderChanged = !equal(bOrder, oOrder);
  const pOrderChanged = !equal(bOrder, pOrder);
  let finalOrder = bOrder;
  if (oOrderChanged && pOrderChanged) {
    if (equal(oOrder, pOrder)) finalOrder = oOrder;
    else {
      conflicts.push({ id: crypto.randomUUID(), evidenceId: "__list__", field: "order", label: FIELD_LABELS.order, baselineValue: bOrder, operatorValue: oOrder, publicValue: pOrder, detectedAt: new Date().toISOString() });
      finalOrder = bOrder;
    }
  } else if (oOrderChanged) finalOrder = oOrder;
  else if (pOrderChanged) finalOrder = pOrder;
  merged.sort((a, b) => finalOrder.indexOf(a.id) - finalOrder.indexOf(b.id));

  return { merged, conflicts, unmatched };
}

/** 快照失配：展示状态、计时和异议失效并重算 */
function invalidate(state: State) {
  state.invalidated = { status: true, timer: true, objections: true };
  state.evidence.forEach((entry) => { entry.status = "待展示"; });
  state.session.currentEvidenceId = state.evidence[0]?.id ?? null;
  state.session.timerSeconds = (state.evidence[0]?.duration ?? 0) * 60;
  state.objections.forEach((o) => { if (!state.evidence.some((e) => e.id === o.evidenceId)) o.invalid = true; });
  addEntry(state, "书记员", "快照失配", "展示状态、计时与异议已失效并重算");
}

/** 重算失效项 */
function recompute(state: State) {
  state.evidence.forEach((entry) => { entry.status = "待展示"; });
  state.session.currentEvidenceId = state.evidence[0]?.id ?? null;
  state.session.timerSeconds = (state.evidence[0]?.duration ?? 0) * 60;
  state.objections = state.objections.filter((o) => !o.invalid);
  state.invalidated = { status: false, timer: false, objections: false };
}

/** 合并后校验会话指向 */
function validateSession(state: State) {
  if (!state.evidence.some((e) => e.id === state.session.currentEvidenceId)) {
    state.session.currentEvidenceId = state.evidence[0]?.id ?? null;
  }
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<Evidence[]>) {
      if (!state.initialized) {
        let loaded = action.payload.length ? action.payload : seedEvidence;
        // 旧数据缺少设备和基线，升级时补来源，证据不能丢
        loaded = loaded.map((entry) => ({
          ...entry,
          device: entry.device ?? "操作屏",
          sessionId: entry.sessionId ?? state.sessionId,
          baselineId: entry.baselineId ?? state.baseline.id
        }));
        state.evidence = loaded;
        state.baseline = buildBaseline(loaded, state.sessionId);
        state.lastConfirmed = deepClone(loaded);
        state.operatorChanges = [];
        state.publicChanges = [];
        state.conflicts = [];
        state.unmatched = [];
        state.initialized = true;
      }
    },
    setOnline(state, action: PayloadAction<boolean>) {
      const goingOnline = action.payload;
      state.online = goingOnline;
      if (goingOnline) {
        state.mergeStatus = "merging";
        try {
          const { merged, conflicts, unmatched } = mergeThreeWay(state.baseline.evidence, state.operatorChanges, state.publicChanges);
          state.evidence = merged;
          // 保留未确认的旧冲突：新合并无冲突时不清空，避免离线/在线循环吞掉待确认项
          state.conflicts = conflicts.length ? conflicts : state.conflicts;
          state.unmatched = unmatched;
          if (unmatched.length > 0) invalidate(state);
          validateSession(state);
          state.baseline = buildBaseline(merged, state.sessionId);
          state.operatorChanges = [];
          state.publicChanges = [];
          state.lastConfirmed = deepClone(merged);
          state.mergeStatus = state.conflicts.length ? "conflict" : "synced";
          state.publicFrozen = state.conflicts.length > 0;
          addEntry(state, "书记员", "重连合并", `合并完成：${state.conflicts.length} 项待确认，${unmatched.length} 项未匹配`);
        } catch {
          // 合并失败：保住已确认内容，之后只补没对上的
          state.evidence = deepClone(state.lastConfirmed);
          state.mergeStatus = "failed";
          state.publicFrozen = true;
          addEntry(state, "书记员", "合并失败", "已保留已确认内容，未匹配改动稍后补入");
        }
      } else {
        // 断网前：把在线期间已同步的改动收入基线与已确认内容，避免重连合并时丢失
        state.baseline = buildBaseline(state.evidence, state.sessionId);
        state.lastConfirmed = deepClone(state.evidence);
        state.publicFrozen = true;
        addEntry(state, "书记员", "离线操作", "公开屏已冻结，改动将在重连后合并");
      }
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) {
      const before = state.evidence.map((e) => e.id);
      state.evidence = action.payload;
      if (!state.online) recordChange(state, "操作屏", "__list__", "order", before, action.payload.map((e) => e.id));
      addEntry(state, "书记员", "调整证据顺序", "已更新举证顺序");
    },
    selectEvidence(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.session.currentEvidenceId = item.id;
      state.session.timerSeconds = item.duration * 60;
      addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`);
    },
    showEvidence(state) {
      const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!item) return;
      const before = item.status;
      item.status = "展示中";
      if (!state.online) recordChange(state, "操作屏", item.id, "status", before, "展示中");
      state.session.phase = "质证";
      addEntry(state, item.presenter, "开始展示", item.title);
    },
    completeEvidence(state) {
      const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!item) return;
      const before = item.status;
      item.status = "已展示";
      if (!state.online) recordChange(state, "操作屏", item.id, "status", before, "已展示");
      const next = state.evidence.find((entry) => entry.status === "待展示");
      state.session.currentEvidenceId = next?.id ?? null;
      state.session.timerSeconds = (next?.duration ?? 0) * 60;
      state.session.phase = next ? "举证" : "休庭";
      addEntry(state, "审判庭", "完成质证", item.title);
    },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      const before = item.sensitive;
      item.sensitive = !item.sensitive;
      if (!state.online) recordChange(state, "操作屏", item.id, "sensitive", before, item.sensitive);
      addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title);
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId);
      state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: new Date().toISOString() });
      state.session.phase = "质证";
      addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`);
    },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection) return;
      objection.status = action.payload.status;
      const item = state.evidence.find((entry) => entry.id === objection.evidenceId);
      if (action.payload.status === "支持" && item) {
        const before = item.status;
        item.status = "已跳过";
        if (!state.online) recordChange(state, "操作屏", item.id, "status", before, "已跳过");
        addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`);
      } else {
        addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证");
      }
    },
    snapshot(state, action: PayloadAction<string>) {
      state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(), evidence: deepClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId });
      state.snapshots = state.snapshots.slice(0, 10);
    },
    restore(state, action: PayloadAction<string>) {
      const snapshot = state.snapshots.find((entry) => entry.id === action.payload);
      if (!snapshot) return;
      const before = deepClone(state.evidence);
      state.evidence = deepClone(snapshot.evidence);
      state.session.phase = snapshot.phase;
      state.session.currentEvidenceId = snapshot.currentEvidenceId;
      if (!state.online) {
        recordChange(state, "操作屏", "__list__", "__snapshot__", before, deepClone(snapshot.evidence));
      } else {
        state.baseline = buildBaseline(snapshot.evidence, state.sessionId);
        state.lastConfirmed = deepClone(snapshot.evidence);
      }
      addEntry(state, "审判庭", "恢复庭审快照", snapshot.label);
    },
    tick(state) { if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1; },
    setPhase(state, action: PayloadAction<SessionPhase>) { state.session.phase = action.payload; addEntry(state, "审判庭", "切换庭审阶段", action.payload); },

    // —— 公开屏离线改动模拟（演示用）：公开屏断网期间各自改动，重连后合并 ——
    publicReorder(state) {
      const ids = state.baseline.evidence.map((e) => e.id);
      if (ids.length < 2) return;
      const next = [...ids.slice(1), ids[0]];
      recordChange(state, "公开屏", "__list__", "order", ids, next);
    },
    publicToggleSensitive(state, action: PayloadAction<string>) {
      const item = state.baseline.evidence.find((e) => e.id === action.payload);
      if (!item) return;
      recordChange(state, "公开屏", item.id, "sensitive", item.sensitive, !item.sensitive);
    },
    publicChangeStatus(state, action: PayloadAction<{ evidenceId: string; status: Evidence["status"] }>) {
      const item = state.baseline.evidence.find((e) => e.id === action.payload.evidenceId);
      if (!item) return;
      recordChange(state, "公开屏", item.id, "status", item.status, action.payload.status);
    },

    // —— 冲突确认：同一处双方都动过，保留两份，确认后公开屏才动 ——
    confirmConflict(state, action: PayloadAction<{ id: string; side: DeviceId }>) {
      const conflict = state.conflicts.find((entry) => entry.id === action.payload.id);
      if (!conflict) return;
      const value = action.payload.side === "操作屏" ? conflict.operatorValue : conflict.publicValue;
      if (conflict.field === "order") {
        const ids = value as string[];
        state.evidence.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      } else if (conflict.field === "__remove__") {
        if (value) {
          const idx = state.evidence.findIndex((e) => e.id === conflict.evidenceId);
          if (idx !== -1) state.evidence[idx] = deepClone(value as Evidence);
        }
      } else {
        const item = state.evidence.find((e) => e.id === conflict.evidenceId);
        if (item) (item as unknown as Record<string, unknown>)[conflict.field] = value;
      }
      state.conflicts = state.conflicts.filter((entry) => entry.id !== conflict.id);
      if (state.conflicts.length === 0) {
        state.publicFrozen = false;
        state.baseline = buildBaseline(state.evidence, state.sessionId);
        state.lastConfirmed = deepClone(state.evidence);
        state.mergeStatus = "synced";
      }
      addEntry(state, "书记员", "确认合并", `${conflict.label} 已确认采用${action.payload.side}版本`);
    },

    // —— 重算失效项 ——
    recomputeInvalidated(state) {
      recompute(state);
      validateSession(state);
      state.baseline = buildBaseline(state.evidence, state.sessionId);
      state.lastConfirmed = deepClone(state.evidence);
      state.unmatched = [];
      state.mergeStatus = state.conflicts.length ? "conflict" : "synced";
      state.publicFrozen = state.conflicts.length > 0;
      addEntry(state, "书记员", "重算完成", "已按当前证据目录重算展示状态、计时与异议");
    },

    // —— 合并失败后：只补没对上的 ——
    supplementUnmatched(state) {
      const allChanges = [...state.operatorChanges, ...state.publicChanges];
      const result = deepClone(state.lastConfirmed);
      let applied = 0;
      const leftover: UnmatchedChange[] = [];
      for (const unmatched of state.unmatched) {
        const change = allChanges.find((c) => c.id === unmatched.changeId);
        if (!change) continue;
        if (change.field === "order") {
          const ids = change.after as string[];
          result.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          applied += 1;
          continue;
        }
        const item = result.find((e) => e.id === change.evidenceId);
        if (!item || !(change.field in item)) { leftover.push(unmatched); continue; }
        (item as unknown as Record<string, unknown>)[change.field] = change.after;
        applied += 1;
      }
      state.evidence = result;
      state.lastConfirmed = deepClone(result);
      state.unmatched = leftover;
      state.mergeStatus = leftover.length ? "failed" : "synced";
      state.publicFrozen = leftover.length > 0;
      addEntry(state, "书记员", "补入未匹配改动", `已补入 ${applied} 项，剩余 ${leftover.length} 项仍未匹配`);
    },

    dismissMergeFailure(state) {
      state.mergeStatus = "idle";
    }
  }
});

export const {
  initialize, setOnline, setMode, reorder, selectEvidence, showEvidence, completeEvidence, toggleSensitive,
  addObjection, resolveObjection, snapshot, restore, tick, setPhase,
  publicReorder, publicToggleSensitive, publicChangeStatus,
  confirmConflict, recomputeInvalidated, supplementUnmatched, dismissMergeFailure
} = slice.actions;
export default slice.reducer;
