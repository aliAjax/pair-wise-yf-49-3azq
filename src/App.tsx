import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline, Tooltip } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useGetCourtStateQuery, useSaveCourtStateMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { addObjection, completeEvidence, confirmConflict, dismissMergeError, hydrate, publicOfflineEdit, reorder, resolveObjection, restore, selectEvidence, setDevice, setMode, setOnline, setPhase, showEvidence, snapshot, supplementUnmatched, tick, toggleSensitive } from "./store/courtSlice";
import { describeChange, describeValue, deviceName, isPublicFrozen } from "./store/sync";
import type { ConflictField, Evidence, SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

const fieldLabel: Record<ConflictField, string> = { order: "证据顺序", sensitive: "敏感遮罩", status: "展示状态", display: "当前展示", objection: "异议裁定" };

function SyncPanel() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  const frozen = isPublicFrozen(state.sync);
  const pendingConflicts = state.sync.conflicts.filter((entry) => !entry.resolution);
  return <Card title="双屏同步" className="sync-card" extra={<Tag color={state.online ? "green" : "orange"}>{state.online ? "协作在线" : "离线记录中"}</Tag>}>
    <div className="sync-meta">
      <span>场次 <b>{state.sync.sessionId}</b></span>
      <span>基线 <b>rev{state.sync.revision}</b></span>
      <span>操作屏基线 <b>rev{state.sync.perDeviceRev.operator}</b></span>
      <span>公开屏基线 <b>rev{state.sync.perDeviceRev.public}</b></span>
    </div>
    {frozen && <Alert type="warning" content={`${pendingConflicts.length} 处双方都动过，公开屏已冻结，确认后才恢复展示`} style={{ margin: "10px 0" }} />}
    {state.mergeError && <Alert type="error" title="合并失败" content={<span>已确认内容已保住：{state.mergeError} <Button size="mini" onClick={() => dispatch(dismissMergeError())}>知道了</Button></span>} style={{ margin: "10px 0" }} />}
    {!state.online && <div className="public-sim">
      <small>模拟公开屏断网时的本地动作（与操作屏互不知情，恢复时合并）</small>
      <Space wrap>
        <Button size="small" onClick={() => dispatch(publicOfflineEdit("revert-order"))}>公开屏改回旧顺序</Button>
        <Button size="small" onClick={() => dispatch(publicOfflineEdit("toggle-mask"))}>公开屏切换遮罩</Button>
        <Button size="small" onClick={() => dispatch(publicOfflineEdit("switch-display"))}>公开屏切换展示</Button>
      </Space>
    </div>}
    <div className="sync-stats">
      <Tag color="arcoblue">待发改动 {state.sync.outbox.length}</Tag>
      <Tag color="red">待确认冲突 {pendingConflicts.length}</Tag>
      <Tag color="orange">未对上 {state.sync.unmatched.length}</Tag>
    </div>
  </Card>;
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const frozen = isPublicFrozen(state.sync);
  // 确认前公开屏先不动：冻结时预览的是上一确认基线，而不是操作屏实时状态
  const liveCurrent = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
  const frozenCurrent = state.sync.confirmed.evidence.find((item) => item.id === state.sync.confirmed.currentEvidenceId);
  const current = frozen && mode === "预览" ? frozenCurrent : liveCurrent;
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);
  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };

  return <div className="court-grid">
    <Card className="operator" title={`证据操作台 · ${deviceName(state.sync.device)}`} extra={<Space><Tag color={state.online ? "green" : "red"}>{state.online ? "本地审计在线" : "离线恢复模式"}</Tag><Button size="small" onClick={() => dispatch(snapshot("手动存档"))}>保存快照</Button></Space>}>
      <div className="evidence-list">{state.evidence.map((item, index) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData("text/plain")); const items = [...state.evidence]; const [moved] = items.splice(from, 1); items.splice(index, 0, moved); dispatch(reorder(items)); }} className={current?.id === item.id ? "active" : ""}>
        <span>{index + 1}</span><div><b>{item.exhibitNo} · {item.title}</b><small>{item.type} · {item.presenter} · {item.duration}分钟 · 来源{deviceName(item.sourceDevice ?? "operator")}/rev{item.sourceRev ?? 0}</small></div><Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : "gray"}>{item.status}</Tag><Button size="mini" onClick={() => dispatch(selectEvidence(item.id))}>选中</Button>
      </article>)}</div>
      <div className="control-strip"><Button type="primary" onClick={() => dispatch(showEvidence())} disabled={!current}>开始展示</Button><Button onClick={() => dispatch(completeEvidence())} disabled={!current}>完成并切换下一条</Button><Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current}>提出异议</Button><Button onClick={() => dispatch(toggleSensitive(current?.id ?? ""))} disabled={!current}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button></div>
    </Card>
    <div className="side-stack">
      <SyncPanel />
      <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { setLocalMode(value as "控制" | "预览"); dispatch(setMode(value === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{ value: "控制", label: "控制者视图" }, { value: "预览", label: "公开屏" }]} />} className="preview-card">
        <div className="public-screen">
          {frozen && <div className="freeze-banner">⛔ {state.sync.conflicts.filter((entry) => !entry.resolution).length} 处冲突待确认，公开屏保持上一确认内容（基线 rev{state.sync.revision}），计时暂停</div>}
          {mode === "预览" ? <><small>公开展示{frozen ? "（已冻结）" : ""}</small><h2>{current?.exhibitNo ?? "暂无证据"}</h2><h3>{current?.title ?? "庭审进行中"}</h3>{current?.sensitive ? <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div> : <p>{current?.note}</p>}<footer>计时 {frozen ? "--:--（冻结）" : formatTime(state.session.timerSeconds)} · {frozen ? state.sync.confirmed.phase : state.session.phase}</footer></> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{liveCurrent?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag></>}
        </div>
      </Card>
      <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><Space><Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))}>支持并跳过</Button><Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))}>驳回继续</Button></Space></div>)}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
    </div>
    <Modal title="提出证据异议" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}><Form layout="vertical"><Form.Item label="异议类型"><Controller name="ground" control={control} render={({ field }) => <Select {...field} options={[{ value: "关联性异议", label: "关联性异议" }, { value: "真实性异议", label: "真实性异议" }, { value: "合法性异议", label: "合法性异议" }]} />} /></Form.Item><Form.Item label="异议说明"><Controller name="explanation" control={control} render={({ field }) => <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />} /></Form.Item></Form></Modal>
    <Card title="庭审阶段" className="phase-card"><Radio.Group value={state.session.phase} onChange={(value) => dispatch(setPhase(value as SessionPhase))}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group></Card>
  </div>;
}

function ConflictList() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  const open = state.sync.conflicts.filter((entry) => !entry.resolution);
  return <Card title="待确认冲突（同一处双方都动过，保留两份）" extra={<Tag color="red">{open.length}</Tag>}>
    {!open.length && <p>没有待确认冲突，公开屏同步正常。</p>}
    {open.map((entry) => {
      const evidence = state.evidence.find((item) => item.id === entry.evidenceId);
      return <div className="conflict" key={entry.id}>
        <div className="conflict-head"><b>{fieldLabel[entry.field]}</b><span>{entry.evidenceId ? `${evidence?.exhibitNo ?? entry.evidenceId} · ${evidence?.title ?? ""}` : "全场顺序"}</span><Tag>{new Date(entry.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</Tag></div>
        <div className="conflict-options">
          <button onClick={() => dispatch(confirmConflict({ id: entry.id, choice: "operator" }))}><Tag color="arcoblue">操作屏</Tag>{describeValue(entry.field, entry.operatorValue)}</button>
          <button onClick={() => dispatch(confirmConflict({ id: entry.id, choice: "public" }))}><Tag color="purple">公开屏</Tag>{describeValue(entry.field, entry.publicValue)}</button>
        </div>
      </div>;
    })}
  </Card>;
}

function SyncPage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <div className="sync-grid">
    <ConflictList />
    <Card title="未对上的改动（合并失败后只补这些，已确认内容不动）" extra={<Space><Tag color="orange">{state.sync.unmatched.length}</Tag><Button size="mini" type="primary" disabled={!state.sync.unmatched.length} onClick={() => dispatch(supplementUnmatched())}>只补未对上的</Button></Space>}>
      {!state.sync.unmatched.length && <p>所有改动都已对上快照。</p>}
      {state.sync.unmatched.map((item, index) => <div className="outbox-row" key={`${item.change.id}-${index}`}><Tag color={deviceName(item.change.device) === "操作屏" ? "arcoblue" : "purple"}>{deviceName(item.change.device)}</Tag><span>{describeChange(item.change)}</span><small>{item.reason} · 基线 rev{item.change.baselineRev}</small></div>)}
    </Card>
    <Card title="待发改动（离线时记录设备 / 场次 / 基线）" extra={<Tag>{state.sync.outbox.length}</Tag>}>
      {!state.sync.outbox.length && <p>没有待发改动。</p>}
      {state.sync.outbox.map((change) => <div className="outbox-row" key={change.id}><Tag color={change.device === "operator" ? "arcoblue" : "purple"}>{deviceName(change.device)}</Tag><span>{describeChange(change)}</span><small>{change.sessionId} · 基线 rev{change.baselineRev} · {new Date(change.at).toLocaleTimeString("zh-CN", { hour12: false })}</small></div>)}
    </Card>
    <Card title="合并记录" className="report-card">{state.sync.reports.map((report) => <div className="report" key={report.id}><div><b>{report.reason === "reconnect" ? "重连合并" : report.reason === "retry" ? "补合并" : report.reason === "confirm" ? "冲突确认" : "升级合并"} → rev{report.newRev}</b><small>{new Date(report.at).toLocaleString("zh-CN")}</small></div><Space wrap><Tag color="green">应用 {report.applied}</Tag><Tag color="red">冲突 {report.conflicts}</Tag><Tag color="orange">未对上 {report.unmatched}</Tag>{report.recalced && <Tag color="pink">已重算展示/计时/异议</Tag>}</Space>{report.notes.map((note) => <p key={note}>{note}</p>)}</div>)}{!state.sync.reports.length && <p>尚无合并记录。</p>}</Card>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <div className="timeline-grid"><Card title="庭审时间线"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card><Card title="本地恢复点"><p>每次手动存档或关键操作都会保留当前证据顺序和阶段；恢复动作在离线时也按条目记录，重连时合并，不会整体覆盖。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small><Button size="mini" onClick={() => dispatch(restore(item.id))}>恢复</Button></div>)}</Card></div>;
}

function EvidencePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <Card title="证据目录与公开属性"><div className="catalog">{state.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title}</b><p>{item.note}</p><Tooltip content={`来源：${deviceName(item.sourceDevice ?? "operator")} · 基线 rev${item.sourceRev ?? 0} · ${item.sessionId ?? state.sync.sessionId}`}><Tag size="small">{deviceName(item.sourceDevice ?? "operator")}/rev{item.sourceRev ?? 0}</Tag></Tooltip></div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩</span><Switch checked={item.sensitive} onChange={() => dispatch(toggleSensitive(item.id))} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { data } = useGetCourtStateQuery();
  const [save] = useSaveCourtStateMutation();
  const { t, i18n } = useTranslation();
  useEffect(() => { dispatch(hydrate(data ?? {})); }, [data, dispatch]);
  useEffect(() => {
    if (!state.initialized) return;
    const timer = window.setTimeout(() => {
      void save({ evidence: state.evidence, objections: state.objections, sync: state.sync });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [state.evidence, state.objections, state.sync, state.initialized, save]);
  const metrics = useMemo(() => ({ shown: state.evidence.filter((item) => item.status === "已展示").length, sensitive: state.evidence.filter((item) => item.sensitive).length, objections: state.objections.length }), [state]);
  const frozen = isPublicFrozen(state.sync);
  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/sync">{t("sync")}</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav><Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside><main><header><div><small>案件号 2026-民初-1084 · 场次 {state.sync.sessionId} · 全流程审计开启</small><h1>{t("title")}</h1></div><div className="top-tools"><label>当前设备 <Select size="small" value={state.sync.device} onChange={(value) => dispatch(setDevice(value as "operator" | "public"))} options={[{ value: "operator", label: "操作屏" }, { value: "public", label: "公开屏" }]} style={{ width: 110 }} /></label><label>网络 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><Tag color={state.online ? "green" : "orange"}>{state.online ? "协作同步" : "离线操作"}</Tag>{frozen && <Tag color="red">公开屏冻结</Tag>}</div></header><section className="metrics"><Card><Statistic title="证据总数" value={state.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card><Card><Statistic title="异议记录" value={metrics.objections} /></Card></section><Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/sync" element={<SyncPage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}
