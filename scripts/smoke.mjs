// 合并引擎冒烟测试：node scripts/smoke.mjs
import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";

const result = await build({
  entryPoints: ["src/store/sync.ts"],
  bundle: true,
  format: "esm",
  write: false,
  platform: "node",
  logLevel: "silent",
});
mkdirSync("scripts/.tmp", { recursive: true });
writeFileSync("scripts/.tmp/sync.mjs", result.outputFiles[0].text);
const sync = await import("./.tmp/sync.mjs");

const ev = (id, overrides = {}) => ({
  id, exhibitNo: id, title: id, type: "书证", duration: 8, presenter: "原告",
  sensitive: false, status: "待展示", note: "", sourceDevice: "operator", sourceRev: 0, sessionId: sync.SESSION_ID, ...overrides,
});
const mkState = () => {
  const evidence = [ev("e1"), ev("e2", { sensitive: true }), ev("e3")];
  const objections = [];
  const s = sync.createInitialSync({ evidence, objections, currentEvidenceId: "e1", phase: "举证" });
  return {
    sync: s,
    evidence: structuredClone(evidence),
    objections: structuredClone(objections),
    session: { phase: "举证", currentEvidenceId: "e1", timerSeconds: 480, operatorMode: "庭审控制" },
  };
};

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

// 场景1：操作屏改顺序，公开屏断网改回旧顺序 → 冲突，公开屏冻结
{
  console.log("场景1 顺序冲突 → 待确认两份，公开屏冻结");
  const d = mkState();
  // 公开屏先断网（其设备基线停留在 rev0）
  d.sync.perDeviceRev.public = 0;
  // 在线时操作屏把顺序改成 e2,e1,e3（新基线 rev1，公开屏不知道）
  d.evidence = [d.evidence[1], d.evidence[0], d.evidence[2]];
  sync.commitOnlineRevision(d.sync, d.evidence, d.objections, d.session);
  // 断网：操作屏离线再改成 e2,e3,e1
  d.sync.outbox.push(sync.makeChange(d.sync, "operator", { kind: "order", fromOrder: ["e2", "e1", "e3"], order: ["e2", "e3", "e1"] }));
  // 公开屏在自己的旧基线 rev0 上改回更旧的顺序 e1,e2,e3
  const pub = sync.simulatePublicChange(d.sync, "revert-order");
  check("公开屏改动基线停留在 rev0", pub.baselineRev === 0, `got rev${pub.baselineRev}`);
  const r = sync.reconcile(d, "reconnect");
  check("产生 1 个冲突", r.conflictsAdded === 1, `got ${r.conflictsAdded}`);
  check("冻结公开屏", sync.isPublicFrozen(d.sync));
  check("两份顺序都保留", d.sync.conflicts[0].operatorValue.includes("e3") && d.sync.conflicts[0].publicValue === JSON.stringify(["e1", "e2", "e3"]));
  check("挂起改动仍在 outbox", d.sync.outbox.length === 2);
  // 确认保留操作屏版本
  sync.resolveConflict(d, d.sync.conflicts[0].id, "operator");
  check("确认后解冻", !sync.isPublicFrozen(d.sync));
  check("顺序为操作屏版本", d.evidence.map((x) => x.id).join() === "e2,e3,e1", d.evidence.map((x) => x.id).join());
  check("挂起改动已出队", d.sync.outbox.length === 0);
  check("证据一条没丢", new Set(d.evidence.map((x) => x.id)).size === 3);
}

// 场景2：不同条目各自修改 → 自动合并，无冲突
{
  console.log("场景2 双方动不同处 → 自动合并");
  const d = mkState();
  d.sync.outbox.push(sync.makeChange(d.sync, "operator", { kind: "sensitive", evidenceId: "e1", from: false, to: true }));
  d.sync.outbox.push(sync.makeChange(d.sync, "public", { kind: "sensitive", evidenceId: "e3", from: false, to: true }));
  const r = sync.reconcile(d, "reconnect");
  check("无冲突", r.conflictsAdded === 0, `got ${r.conflictsAdded}`);
  check("两处都应用", d.evidence.find((x) => x.id === "e1").sensitive && d.evidence.find((x) => x.id === "e3").sensitive);
  check("不冻结", !sync.isPublicFrozen(d.sync));
  check("来源标记更新", d.evidence.find((x) => x.id === "e3").sourceDevice === "public");
}

// 场景3：同设备连续改同一处 → 不应误判快照对不上
{
  console.log("场景3 同设备连续改动 → 不产生未对上/冲突");
  const d = mkState();
  d.sync.outbox.push(sync.makeChange(d.sync, "operator", { kind: "sensitive", evidenceId: "e1", from: false, to: true }));
  d.sync.outbox.push(sync.makeChange(d.sync, "operator", { kind: "sensitive", evidenceId: "e1", from: true, to: false }));
  const r = sync.reconcile(d, "reconnect");
  check("最终改动被应用（旧改动被取代）", r.applied === 1, `applied ${r.applied}`);
  check("没有未对上", r.unmatchedAdded === 0, `unmatched ${r.unmatchedAdded}`);
  check("没有冲突", r.conflictsAdded === 0);
  check("最终值为 false", d.evidence.find((x) => x.id === "e1").sensitive === false);
}

// 场景4：改动对不上快照（基线不存在/from 不一致）→ 未对上留待只补
{
  console.log("场景4 对不上快照 → 未对上保留，已确认内容不丢");
  const d = mkState();
  const bad = sync.makeChange(d.sync, "operator", { kind: "sensitive", evidenceId: "e-missing", from: false, to: true });
  bad.baselineRev = 99;
  d.sync.outbox.push(bad);
  const r = sync.reconcile(d, "reconnect");
  check("进入未对上", r.unmatchedAdded === 1, `got ${r.unmatchedAdded}`);
  check("outbox 已清空该条", !d.sync.outbox.some((c) => c.id === bad.id));
  check("未对上列表保留", d.sync.unmatched.length === 1);
  check("已确认证据仍在", d.evidence.length === 3);
  // 只补：基线仍没有 → 仍未对上，已确认不动，且不会重复堆积
  const beforeUnmatched = d.sync.unmatched.length;
  const r2 = sync.retryUnmatched(d);
  check("只补不会冲掉已确认", d.evidence.length === 3);
  check("仍报告未对上", r2.unmatchedAdded === 1, `got ${r2.unmatchedAdded}`);
  check("未对上条目不重复堆积", d.sync.unmatched.length === beforeUnmatched, `len=${d.sync.unmatched.length}`);
}

// 场景5：异议随证据跳过而失效并重算
{
  console.log("场景5 异议失效重算");
  const d = mkState();
  d.objections.push({ id: "o9", evidenceId: "e1", ground: "关联性异议", explanation: "测试异议，需要足够长的说明", status: "待裁定", createdAt: new Date().toISOString(), sourceDevice: "operator", sourceRev: 0, sessionId: sync.SESSION_ID });
  d.sync = sync.createInitialSync({ evidence: d.evidence, objections: d.objections, currentEvidenceId: "e1", phase: "举证" });
  // 对不上快照的状态改动（from 与基线不符）→ 触发重算；基线 e1=待展示，谎称 from=展示中
  d.sync.outbox.push(sync.makeChange(d.sync, "public", { kind: "status", evidenceId: "e1", from: "展示中", to: "已跳过" }));
  const r = sync.reconcile(d, "reconnect");
  check("触发重算", r.recalced);
  check("e1 已跳过", d.evidence.find((x) => x.id === "e1").status === "已跳过");
  check("异议标记失效", d.objections.find((x) => x.id === "o9").status === "失效");
}

// 场景6：旧数据升级补来源，证据不丢
{
  console.log("场景6 旧数据升级");
  const legacy = [ev("L1"), ev("L2")].map(({ sourceDevice, sourceRev, sessionId, ...rest }) => rest);
  check("旧数据缺字段", legacy[0].sourceDevice === undefined);
  const migrated = sync.migrateLegacy(legacy);
  check("补了来源设备", migrated[0].sourceDevice === "legacy");
  check("补了基线", migrated[0].sourceRev === 0);
  check("补了场次", !!migrated[0].sessionId);
  check("证据数量不变", migrated.length === 2);
}

// 场景7：多个冲突逐条确认，后确认的不能冲掉先前已确认内容
{
  console.log("场景7 多冲突逐条确认不互相覆盖");
  const d = mkState();
  // e1 遮罩冲突
  d.sync.outbox.push(sync.makeChange(d.sync, "operator", { kind: "sensitive", evidenceId: "e1", from: false, to: true }));
  d.sync.outbox.push(sync.makeChange(d.sync, "public", { kind: "sensitive", evidenceId: "e1", from: false, to: false }));
  // 顺序冲突（操作屏 e2,e1,e3；公开屏旧序 e1,e2,e3）
  d.sync.outbox.push(sync.makeChange(d.sync, "operator", { kind: "order", fromOrder: ["e1", "e2", "e3"], order: ["e2", "e1", "e3"] }));
  d.sync.outbox.push(sync.makeChange(d.sync, "public", { kind: "order", fromOrder: ["e1", "e2", "e3"], order: ["e1", "e3", "e2"] }));
  const r = sync.reconcile(d, "reconnect");
  check("产生 2 个冲突", r.conflictsAdded === 2, `got ${r.conflictsAdded}`);
  const orderConflict = d.sync.conflicts.find((c) => c.field === "order");
  const maskConflict = d.sync.conflicts.find((c) => c.field === "sensitive");
  sync.resolveConflict(d, orderConflict.id, "operator");
  check("确认顺序后仍是冻结", sync.isPublicFrozen(d.sync));
  check("顺序已生效", d.evidence.map((x) => x.id).join() === "e2,e1,e3");
  sync.resolveConflict(d, maskConflict.id, "operator");
  check("全部确认后解冻", !sync.isPublicFrozen(d.sync));
  check("顺序确认没有被遮罩确认冲掉", d.evidence.map((x) => x.id).join() === "e2,e1,e3", d.evidence.map((x) => x.id).join());
  check("e1 遮罩生效", d.evidence.find((x) => x.id === "e1").sensitive === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
