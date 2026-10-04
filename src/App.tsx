import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useSaveEvidenceMutation, useGetEvidenceQuery } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addObjection, completeEvidence, confirmConflict, initialize, publicChangeStatus, publicReorder, publicToggleSensitive,
  reorder, recomputeInvalidated, resolveObjection, restore, selectEvidence, setMode, setOnline, setPhase,
  showEvidence, snapshot, supplementUnmatched, tick, toggleSensitive, dismissMergeFailure
} from "./store/courtSlice";
import type { ConflictItem, Evidence, Party, SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

function formatValue(field: string, value: unknown, evidence: Evidence[]): string {
  if (field === "order") {
    const ids = value as string[];
    return ids.map((id) => evidence.find((e) => e.id === id)?.exhibitNo ?? id).join(" → ");
  }
  if (field === "__remove__") {
    const entry = value as Evidence | null;
    return entry ? `${entry.exhibitNo} ${entry.title}` : "（删除）";
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null || value === undefined) return "—";
  return String(value);
}

function evidenceName(evidence: Evidence[], id: string): string {
  const entry = evidence.find((e) => e.id === id);
  return entry ? `${entry.exhibitNo} ${entry.title}` : id;
}

/** 合并状态横幅 */
function MergeBanner() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  if (state.mergeStatus === "failed") {
    return <Alert className="merge-banner" type="error" title="合并失败：已保住已确认内容" content={<Space wrap><span>已确认内容未受影响，可只补入没对上的改动。</span><Button size="small" type="primary" onClick={() => dispatch(supplementUnmatched())}>补入未匹配改动</Button><Button size="small" onClick={() => dispatch(dismissMergeFailure())}>稍后</Button></Space>} />;
  }
  if (state.mergeStatus === "conflict" && state.conflicts.length) {
    return <Alert className="merge-banner" type="warning" title={`${state.conflicts.length} 处两边都动过，待确认`} content={<span>确认前公开屏保持不动；请在下方逐项选择采用的版本。</span>} />;
  }
  if (state.unmatched.length) {
    return <Alert className="merge-banner" type="info" title={`${state.unmatched.length} 项改动对不上快照`} content={<Space wrap><span>展示状态、计时与异议已失效，需重算。</span><Button size="small" type="primary" onClick={() => dispatch(recomputeInvalidated())}>重算失效项</Button></Space>} />;
  }
  if (state.mergeStatus === "synced") {
    return <Alert className="merge-banner" type="success" title="已同步" content={<span>两边改动已按证据条目合并，公开屏已恢复。</span>} />;
  }
  return null;
}

/** 待确认冲突：同一处双方都动过，保留两份 */
function ConflictPanel() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  if (!state.conflicts.length) return null;
  return <Card className="conflict-card" title="待确认合并项" extra={<Tag color="red">{state.conflicts.length}</Tag>}>
    <div className="conflict-list">
      {state.conflicts.map((conflict: ConflictItem) => (
        <div className="conflict" key={conflict.id}>
          <div className="conflict-head"><b>{conflict.label}</b><Tag>{evidenceName(state.evidence, conflict.evidenceId)}</Tag></div>
          <div className="conflict-versions">
            <div className="version"><small>基线</small><span>{formatValue(conflict.field, conflict.baselineValue, state.evidence)}</span></div>
            <div className="version operator"><small>操作屏</small><span>{formatValue(conflict.field, conflict.operatorValue, state.evidence)}</span></div>
            <div className="version public"><small>公开屏</small><span>{formatValue(conflict.field, conflict.publicValue, state.evidence)}</span></div>
          </div>
          <Space><Button size="mini" type="primary" onClick={() => dispatch(confirmConflict({ id: conflict.id, side: "操作屏" }))}>采用操作屏</Button><Button size="mini" onClick={() => dispatch(confirmConflict({ id: conflict.id, side: "公开屏" }))}>采用公开屏</Button></Space>
        </div>
      ))}
    </div>
  </Card>;
}

/** 未匹配改动明细 */
function UnmatchedPanel() {
  const state = useAppSelector((root) => root.court);
  if (!state.unmatched.length) return null;
  return <Card className="unmatched-card" title="未匹配改动" extra={<Tag color="orange">{state.unmatched.length}</Tag>}>
    {state.unmatched.map((item) => <div className="unmatched" key={item.changeId}><Tag color={item.device === "操作屏" ? "blue" : "purple"}>{item.device}</Tag><b>{evidenceName(state.evidence, item.evidenceId)}</b><span>{item.field}</span><small>{item.reason}</small></div>)}
  </Card>;
}

/** 公开屏离线改动模拟（演示断网期间两边各自改动） */
function PublicSimPanel() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  const ids = state.baseline.evidence.map((e) => e.id);
  return <Card className="sim-card" title="公开屏离线模拟" extra={<Tag color={state.online ? "green" : "orange"}>{state.online ? "在线" : "离线"}</Tag>}>
    <p>断网后公开屏各自改动，重连时按证据条目合并。</p>
    <Space wrap>
      <Button size="small" onClick={() => dispatch(publicReorder())} disabled={state.online}>公开屏调整顺序</Button>
      <Button size="small" onClick={() => ids[0] && dispatch(publicToggleSensitive(ids[0]))} disabled={state.online}>公开屏切换遮罩</Button>
      <Button size="small" onClick={() => ids[0] && dispatch(publicChangeStatus({ evidenceId: ids[0], status: "展示中" }))} disabled={state.online}>公开屏改变状态</Button>
    </Space>
    {state.online && <small>在线时公开屏改动不可模拟，请先断网。</small>}
  </Card>;
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);
  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };

  // 公开屏冻结时展示已确认内容，不回旧顺序
  const publicEvidence = state.publicFrozen ? state.lastConfirmed : state.evidence;
  const publicCurrent = publicEvidence.find((item) => item.id === state.session.currentEvidenceId);

  return <div className="court-grid">
    <div className="court-top"><MergeBanner /></div>
    <Card className="operator" title="证据操作台" extra={<Space><Tag color={state.online ? "green" : "red"}>{state.online ? "本地审计在线" : "离线恢复模式"}</Tag><Button size="small" onClick={() => dispatch(snapshot("手动存档"))}>保存快照</Button></Space>}>
      <div className="evidence-list">{state.evidence.map((item, index) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData("text/plain")); const items = [...state.evidence]; const [moved] = items.splice(from, 1); items.splice(index, 0, moved); dispatch(reorder(items)); }} className={current?.id === item.id ? "active" : ""}>
        <span>{index + 1}</span><div><b>{item.exhibitNo} · {item.title}</b><small>{item.type} · {item.presenter} · {item.duration}分钟{item.sensitive ? " · 已遮罩" : ""}</small></div><Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : "gray"}>{item.status}</Tag><Button size="mini" onClick={() => dispatch(selectEvidence(item.id))}>选中</Button>
      </article>)}</div>
      <div className="control-strip"><Button type="primary" onClick={() => dispatch(showEvidence())} disabled={!current}>开始展示</Button><Button onClick={() => dispatch(completeEvidence())} disabled={!current}>完成并切换下一条</Button><Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current}>提出异议</Button><Button onClick={() => dispatch(toggleSensitive(current?.id ?? ""))} disabled={!current}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button></div>
    </Card>
    <div className="side-stack">
      <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { setLocalMode(value as "控制" | "预览"); dispatch(setMode(value === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{value:"控制",label:"控制者视图"},{value:"预览",label:"公开屏"}]} />} className="preview-card">
        {state.publicFrozen && <Alert className="frozen-banner" type="warning" title="公开屏已冻结" content={state.conflicts.length ? `${state.conflicts.length} 项合并待确认，公开屏保持已确认内容不动。` : "离线期间公开屏保持已确认内容，不回旧顺序。"} />}
        <div className="public-screen">{mode === "预览" ? <><small>公开展示</small><h2>{publicCurrent?.exhibitNo ?? "暂无证据"}</h2><h3>{publicCurrent?.title ?? "庭审进行中"}</h3>{publicCurrent?.sensitive ? <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div> : <p>{publicCurrent?.note}</p>}<footer>计时 {formatTime(state.session.timerSeconds)} · {state.session.phase}</footer></> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag></>}</div>
      </Card>
      <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><Space><Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))}>支持并跳过</Button><Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))}>驳回继续</Button></Space></div>)}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
      <ConflictPanel />
      <UnmatchedPanel />
      <PublicSimPanel />
    </div>
    <Modal title="提出证据异议" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}><Form layout="vertical"><Form.Item label="异议类型"><Controller name="ground" control={control} render={({ field }) => <Select {...field} options={[{value:"关联性异议",label:"关联性异议"},{value:"真实性异议",label:"真实性异议"},{value:"合法性异议",label:"合法性异议"}]} />} /></Form.Item><Form.Item label="异议说明"><Controller name="explanation" control={control} render={({ field }) => <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />} /></Form.Item></Form></Modal>
    <Card title="庭审阶段" className="phase-card"><Radio.Group value={state.session.phase} onChange={(value) => dispatch(setPhase(value as SessionPhase))}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group></Card>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <div className="timeline-grid"><Card title="庭审时间线"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card><Card title="本地恢复点"><p>每次手动存档或关键操作都会保留当前证据顺序和阶段。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small><Button size="mini" onClick={() => dispatch(restore(item.id))}>恢复</Button></div>)}</Card></div>;
}

function EvidencePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <Card title="证据目录与公开属性"><div className="catalog">{state.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title}</b><p>{item.note}</p></div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩</span><Switch checked={item.sensitive} onChange={() => dispatch(toggleSensitive(item.id))} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { data = [] } = useGetEvidenceQuery();
  const [save] = useSaveEvidenceMutation();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);
  useEffect(() => { const timer = window.setTimeout(() => void save(state.evidence), 300); return () => window.clearTimeout(timer); }, [state.evidence, save]);
  const metrics = useMemo(() => ({ shown: state.evidence.filter((item) => item.status === "已展示").length, sensitive: state.evidence.filter((item) => item.sensitive).length, objections: state.objections.length }), [state]);
  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav><Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside><main><header><div><small>案件号 2026-民初-1084 · 全流程审计开启</small><h1>{t("title")}</h1></div><div className="top-tools"><label>本地恢复 <Switch checked={!state.online} onChange={(value) => dispatch(setOnline(!value))} /></label><Tag color={state.online ? "green" : "orange"}>{state.online ? "协作同步" : "离线操作"}</Tag>{state.mergeStatus === "conflict" && <Tag color="red">待确认 {state.conflicts.length}</Tag>}{state.mergeStatus === "failed" && <Tag color="red">合并失败</Tag>}{state.mergeStatus === "synced" && <Tag color="green">已同步</Tag>}</div></header><section className="metrics"><Card><Statistic title="证据总数" value={state.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card><Card><Statistic title="异议记录" value={metrics.objections} /></Card></section><Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}
