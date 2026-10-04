import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Evidence, EvidenceStatus, Objection, SessionPhase, SessionState, SyncState, TimelineEntry } from "../types";
import { commitOnlineRevision, createInitialSync, describeChange, deviceName, isPublicFrozen, makeChange, migrateLegacy, reconcile, resolveConflict as resolveEngine, retryUnmatched, simulatePublicChange, type ChangeBody, SESSION_ID } from "./sync";

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定", sourceDevice: "operator", sourceRev: 0, sessionId: SESSION_ID },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩", sourceDevice: "operator", sourceRev: 0, sessionId: SESSION_ID },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45", sourceDevice: "operator", sourceRev: 0, sessionId: SESSION_ID }
];
const seedObjection: Objection = { id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString(), sourceDevice: "operator", sourceRev: 0, sessionId: SESSION_ID };
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

export interface HydrationBlob {
  evidence?: Evidence[];
  objections?: Objection[];
  sync?: SyncState;
}

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  online: boolean;
  sync: SyncState;
  mergeError: string | null;
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [seedObjection],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [], session: seedSession, online: true,
  sync: createInitialSync({ evidence: seedEvidence, objections: [seedObjection], currentEvidenceId: seedSession.currentEvidenceId, phase: seedSession.phase }),
  mergeError: null
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

type ChangeBodyLocal = ChangeBody;
function recordChange(state: State, body: ChangeBodyLocal) {
  state.sync.outbox.push(makeChange(state.sync, "operator", body));
}

function commit(state: State) {
  if (state.online) commitOnlineRevision(state.sync, state.evidence, state.objections, state.session);
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    hydrate(state, action: PayloadAction<HydrationBlob>) {
      if (state.initialized) return;
      const payload = action.payload;
      let evidence = migrateLegacy(payload.evidence?.length ? structuredClone(payload.evidence) : seedEvidence);
      let objections = migrateLegacy(payload.objections?.length ? structuredClone(payload.objections) : [seedObjection]);
      if (payload.sync && payload.sync.confirmed && payload.sync.history?.length) {
        state.sync = payload.sync;
        evidence = structuredClone(payload.sync.confirmed.evidence);
        objections = structuredClone(payload.sync.confirmed.objections);
        state.session.phase = payload.sync.confirmed.phase;
        state.session.currentEvidenceId = payload.sync.confirmed.currentEvidenceId;
        addEntry(state, "系统", "载入本地数据", "按已确认基线恢复，设备与来源标记已补齐");
      } else {
        state.sync = createInitialSync({ evidence, objections, currentEvidenceId: state.session.currentEvidenceId, phase: state.session.phase });
        addEntry(state, "系统", "载入本地数据", "旧数据升级：已补来源设备与基线，证据全部保留");
      }
      state.evidence = evidence;
      state.objections = objections;
      const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
      state.session.timerSeconds = (current?.duration ?? 0) * 60;
      state.initialized = true;
      addEntry(state, "系统", "载入本地数据", payload.sync ? "按已确认基线恢复，设备与来源标记已补齐" : "旧数据升级：已补来源设备与基线，证据全部保留");
    },
    setOnline(state, action: PayloadAction<boolean>) {
      if (action.payload === state.online) return;
      if (action.payload) {
        if (!state.sync.outbox.length) {
          state.online = true;
          state.mergeError = null;
          return;
        }
        // 重连后按证据条目合并；合并失败也要保住已确认内容
        try {
          const result = reconcile(state, "reconnect");
          state.online = true;
          state.mergeError = null;
          addEntry(state, "系统", "重连合并完成", `应用 ${result.applied} 处改动，冲突 ${result.conflictsAdded} 处待确认，未对上 ${result.unmatchedAdded} 处${result.recalced ? "，已重算展示状态、计时与异议" : ""}`);
          if (result.conflictsAdded > 0) addEntry(state, "系统", "公开屏冻结", `${result.conflictsAdded} 处双方都动过，保留两份待确认，确认前公开屏不动`);
          for (const note of result.notes) addEntry(state, "系统", "合并提示", note);
        } catch (error) {
          state.mergeError = error instanceof Error ? error.message : String(error);
          addEntry(state, "系统", "合并失败", "已确认内容保持不变，未对上的改动可稍后只补");
        }
      } else {
        state.online = false;
        addEntry(state, "系统", "进入离线模式", `设备：操作屏，场次：${state.sync.sessionId}，基线 rev${state.sync.perDeviceRev.operator}，改动将逐条记录`);
      }
    },
    setDevice(state, action: PayloadAction<SyncState["device"]>) { state.sync.device = action.payload; },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) {
      const fromOrder = state.evidence.map((item) => item.id);
      state.evidence = action.payload;
      const order = action.payload.map((item) => item.id);
      if (fromOrder.join() !== order.join()) {
        if (state.online) commit(state);
        else recordChange(state, { kind: "order", fromOrder, order });
        addEntry(state, "书记员", "调整证据顺序", `基线 rev${state.sync.perDeviceRev.operator}：${order.join(" → ")}`);
      }
    },
    selectEvidence(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      const fromId = state.session.currentEvidenceId;
      state.session.currentEvidenceId = item.id;
      state.session.timerSeconds = item.duration * 60;
      if (state.online) commit(state);
      else recordChange(state, { kind: "select", evidenceId: item.id, fromId });
      addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`);
    },
    showEvidence(state) {
      const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!item) return;
      const from: EvidenceStatus = item.status;
      item.status = "展示中";
      const phaseFrom = state.session.phase;
      state.session.phase = "质证";
      if (state.online) commit(state);
      else {
        recordChange(state, { kind: "status", evidenceId: item.id, from, to: "展示中" });
        if (phaseFrom !== "质证") recordChange(state, { kind: "phase", from: phaseFrom, to: "质证" });
      }
      addEntry(state, item.presenter, "开始展示", item.title);
    },
    completeEvidence(state) {
      const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!item) return;
      const from: EvidenceStatus = item.status;
      item.status = "已展示";
      const next = state.evidence.find((entry) => entry.status === "待展示");
      if (state.online) commit(state);
      else recordChange(state, { kind: "status", evidenceId: item.id, from, to: "已展示" });
      if (next) {
        const fromId = state.session.currentEvidenceId;
        state.session.currentEvidenceId = next.id;
        state.session.timerSeconds = next.duration * 60;
        state.session.phase = "举证";
        if (state.online) commit(state);
        else recordChange(state, { kind: "select", evidenceId: next.id, fromId });
      } else {
        state.session.phase = "休庭";
        if (state.online) commit(state);
        else recordChange(state, { kind: "phase", from: "质证", to: "休庭" });
      }
      addEntry(state, "审判庭", "完成质证", item.title);
    },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      const from = item.sensitive;
      item.sensitive = !item.sensitive;
      item.sourceDevice = "operator";
      item.sourceRev = state.sync.revision;
      if (state.online) commit(state);
      else recordChange(state, { kind: "sensitive", evidenceId: item.id, from, to: item.sensitive });
      addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title);
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId);
      const objection: Objection = { ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: new Date().toISOString(), sourceDevice: "operator", sourceRev: state.sync.revision, sessionId: state.sync.sessionId };
      state.objections.unshift(objection);
      const phaseFrom = state.session.phase;
      state.session.phase = "质证";
      if (state.online) commit(state);
      else {
        recordChange(state, { kind: "objectionAdd", evidenceId: objection.evidenceId, objection: structuredClone(objection) });
        if (phaseFrom !== "质证") recordChange(state, { kind: "phase", from: phaseFrom, to: "质证" });
      }
      addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`);
    },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection || objection.status === "失效") return;
      const from = objection.status;
      objection.status = action.payload.status;
      const item = state.evidence.find((entry) => entry.id === objection.evidenceId);
      let itemFrom: EvidenceStatus | undefined;
      if (action.payload.status === "支持" && item) {
        itemFrom = item.status;
        item.status = "已跳过";
      }
      if (state.online) commit(state);
      else recordChange(state, { kind: "objectionResolve", evidenceId: objection.evidenceId, objectionId: objection.id, from: from as Objection["status"], to: action.payload.status });
      if (action.payload.status === "支持" && item && itemFrom) {
        addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`);
      } else {
        addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证");
      }
    },
    snapshot(state, action: PayloadAction<string>) {
      state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId });
      state.snapshots = state.snapshots.slice(0, 10);
    },
    restore(state, action: PayloadAction<string>) {
      const point = state.snapshots.find((entry) => entry.id === action.payload);
      if (!point) return;
      // 恢复本身也是一次离线改动：与已确认基线比对后逐条记录
      const oldOrder = state.evidence.map((item) => item.id);
      const newOrder = point.evidence.map((item) => item.id);
      for (const restored of point.evidence) {
        const current = state.evidence.find((item) => item.id === restored.id);
        if (!current) { state.evidence.push(structuredClone(restored)); continue; }
        if (current.sensitive !== restored.sensitive) recordChange(state, { kind: "sensitive", evidenceId: current.id, from: current.sensitive, to: restored.sensitive });
        if (current.status !== restored.status) recordChange(state, { kind: "status", evidenceId: current.id, from: current.status, to: restored.status });
        current.sensitive = restored.sensitive;
        current.status = restored.status;
      }
      if (oldOrder.join() !== newOrder.join()) recordChange(state, { kind: "order", fromOrder: oldOrder, order: newOrder });
      state.evidence = newOrder.map((id) => state.evidence.find((item) => item.id === id)!).filter(Boolean);
      const fromId = state.session.currentEvidenceId;
      if (point.currentEvidenceId !== fromId && point.currentEvidenceId) recordChange(state, { kind: "select", evidenceId: point.currentEvidenceId, fromId });
      state.session.phase = point.phase;
      state.session.currentEvidenceId = point.currentEvidenceId;
      if (state.online && state.sync.outbox.length === 0) commit(state);
      addEntry(state, "审判庭", "恢复庭审快照", point.label);
    },
    tick(state) {
      // 冲突确认前公开屏先不动：冻结计时，确认后由基线重算
      if (isPublicFrozen(state.sync)) return;
      if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1;
    },
    setPhase(state, action: PayloadAction<SessionPhase>) {
      const from = state.session.phase;
      state.session.phase = action.payload;
      if (state.online) commit(state);
      else if (from !== action.payload) recordChange(state, { kind: "phase", from, to: action.payload });
      addEntry(state, "审判庭", "切换庭审阶段", action.payload);
    },
    // 模拟公开屏断网期间的本地改动（恢复旧顺序/改遮罩/切展示）
    publicOfflineEdit(state, action: PayloadAction<"revert-order" | "toggle-mask" | "switch-display">) {
      const change = simulatePublicChange(state.sync, action.payload);
      if (change) addEntry(state, "书记员", "公开屏离线改动", `${deviceName("public")}（基线 rev${change.baselineRev}）：${describeChange(change)}`);
    },
    // 确认冲突：保留两份中选定的一份并入基线
    confirmConflict(state, action: PayloadAction<{ id: string; choice: "operator" | "public" }>) {
      const allResolved = resolveEngine(state, action.payload.id, action.payload.choice);
      const conflict = state.sync.conflicts.find((entry) => entry.id === action.payload.id);
      addEntry(state, "审判庭", "确认冲突", `按${deviceName(action.payload.choice)}保留（${conflict?.field ?? ""}），${allResolved ? "公开屏恢复同步" : "其余冲突确认前公开屏仍冻结"}`);
    },
    // 合并失败后：保住已确认内容，只补没对上的
    supplementUnmatched(state) {
      if (!state.sync.unmatched.length) return;
      try {
        const result = retryUnmatched(state);
        addEntry(state, "系统", "补合并完成", `补应用 ${result.applied} 处，仍未对上 ${result.unmatchedAdded} 处，冲突 ${result.conflictsAdded} 处${result.recalced ? "，已重算" : ""}`);
        for (const note of result.notes) addEntry(state, "系统", "补合并提示", note);
      } catch (error) {
        state.mergeError = error instanceof Error ? error.message : String(error);
        addEntry(state, "系统", "补合并失败", "已确认内容保持不变，未对上的改动继续保留待补");
      }
    },
    dismissMergeError(state) { state.mergeError = null; }
  }
});

export const { hydrate, setOnline, setDevice, setMode, reorder, selectEvidence, showEvidence, completeEvidence, toggleSensitive, addObjection, resolveObjection, snapshot, restore, tick, setPhase, publicOfflineEdit, confirmConflict, supplementUnmatched, dismissMergeError } = slice.actions;
export default slice.reducer;
