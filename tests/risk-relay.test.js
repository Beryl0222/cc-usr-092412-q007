import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { AuthorizationError, ConflictError, DomainError, ValidationError } from "../src/errors.js";
import { EventStore } from "../src/store.js";
import { RiskRelayService } from "../src/service.js";
import { replay, suggestTier } from "../src/rules.js";

const NURSE = { staff_id: "N-01", name: "王护士", role: "screening_nurse" };
const DOCTOR = { staff_id: "D-01", name: "李医生", role: "physician" };
const DOCTOR2 = { staff_id: "D-02", name: "赵医生", role: "physician" };
const COORD = { staff_id: "C-01", name: "周协调员", role: "coordinator" };
const COACH = { staff_id: "K-01", name: "陈教练", role: "coach" };
const COACH2 = { staff_id: "K-02", name: "新场地教练", role: "coach" };

const V1 = "V-滨江跑道";
const V2 = "V-体育公园";
const baseLoad = (slots = 8) => ({
  pace_sec_per_km_min: 480,
  pace_sec_per_km_max: 540,
  duration_min: 30,
  max_heart_rate: 120,
  remaining_slots: slots,
});

let dir;
let store;
let svc;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "risk-relay-"));
  store = new EventStore(join(dir, "chain.jsonl"));
  svc = new RiskRelayService(store);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 建一条“已初筛 + 医生签署低风险 + 已开方”的标准链。 */
async function seedReadyParticipant(id = "P-0001", opts = {}) {
  await svc.recordScreening({
    event_id: `scr-${id}`,
    participant_id: id,
    occurred_at: "2026-09-01T09:00:00+08:00",
    venue_id: V1,
    facts: [
      { key: "age", value: 52 },
      { key: "systolic_bp", value: 128 },
      { key: "resting_hr", value: 68 },
    ],
    actor: NURSE,
  });
  await svc.signTier({
    event_id: `tier-${id}`,
    participant_id: id,
    occurred_at: "2026-09-01T10:00:00+08:00",
    tier: "low",
    actor: DOCTOR,
  });
  await svc.approvePlan({
    event_id: `plan-${id}`,
    participant_id: id,
    occurred_at: "2026-09-01T11:00:00+08:00",
    plan_id: `PLAN-${id}-1`,
    venue_id: V1,
    load: baseLoad(opts.slots ?? 8),
    valid_from: "2026-09-01T00:00:00+08:00",
    valid_until: "2026-10-31T23:59:59+08:00",
    actor: DOCTOR,
  });
  return id;
}

test("自动风险分层只提出建议，升级必须由医生签署", async () => {
  const id = "P-AUTO";
  await svc.recordScreening({
    event_id: "scr1",
    participant_id: id,
    occurred_at: "2026-09-01T09:00:00+08:00",
    venue_id: V1,
    facts: [{ key: "age", value: 72 }, { key: "systolic_bp", value: 162 }],
    actor: NURSE,
  });

  const advice = svc.adviseTier(id, "2026-09-01T12:00:00+08:00");
  assert.equal(advice.advised_tier, "high");
  assert.ok(advice.reasons.length >= 2);
  // 建议不落状态：当前签署分层仍为空。
  assert.equal(advice.current_signed_tier, null);

  // 教练 / 协调员不能签署分层。
  await assert.rejects(
    () =>
      svc.signTier({
        event_id: "tier-bad",
        participant_id: id,
        occurred_at: "2026-09-01T12:00:00+08:00",
        tier: "high",
        actor: COORD,
      }),
    AuthorizationError
  );

  await svc.signTier({
    event_id: "tier-ok",
    participant_id: id,
    occurred_at: "2026-09-01T12:30:00+08:00",
    tier: "high",
    actor: DOCTOR,
  });
  assert.equal(svc.adviseTier(id).current_signed_tier, "high");
});

test("纯规则：禁忌与严重观察把建议推到高风险", () => {
  const advice = suggestTier(
    [{ key: "age", value: 40 }],
    [{ code: "UNSTABLE_ANGINA", detail: "..." }],
    [{ symptom: "胸闷", severity: "severe" }]
  );
  assert.equal(advice.advised_tier, "high");
  assert.equal(advice.advice_source, "auto");
});

test("教练只能在当前场地与期限内执行有效处方", async () => {
  const id = await seedReadyParticipant("P-VENUE");

  // 正确场地、有效期内 → 允许。
  const ok = svc.canExecute(id, "PLAN-P-VENUE-1", V1, "2026-09-10T08:00:00+08:00");
  assert.equal(ok.valid, true);

  // 换错场地 → 拒绝。
  const wrongVenue = svc.canExecute(id, "PLAN-P-VENUE-1", V2, "2026-09-10T08:00:00+08:00");
  assert.equal(wrongVenue.valid, false);
  assert.ok(wrongVenue.reasons.join("；").includes(V2));

  // 超出有效期 → 拒绝。
  const expired = svc.canExecute(id, "PLAN-P-VENUE-1", V1, "2026-11-05T08:00:00+08:00");
  assert.equal(expired.valid, false);
  assert.ok(expired.reasons.join("；").includes("有效期"));

  // 教练不能自行开方。
  await assert.rejects(
    () =>
      svc.approvePlan({
        event_id: "plan-coach",
        participant_id: id,
        occurred_at: "2026-09-10T08:00:00+08:00",
        plan_id: "PLAN-X",
        venue_id: V1,
        load: baseLoad(),
        valid_from: "2026-09-10T00:00:00+08:00",
        valid_until: "2026-10-31T23:59:59+08:00",
        actor: COACH,
      }),
    AuthorizationError
  );
});

test("参与者换到新场地后不能沿用旧负荷：场地原子迁移，已完成课程保留", async () => {
  const id = await seedReadyParticipant("P-MOVE", { slots: 6 });

  // 在旧场地先完成 2 次课。
  for (const [i, day] of ["02", "04"].entries()) {
    const r = await svc.recordSession({
      event_id: `s-${id}-${i}`,
      participant_id: id,
      occurred_at: `2026-09-${day}T08:00:00+08:00`,
      plan_id: "PLAN-P-MOVE-1",
      venue_id: V1,
      session_id: `SES-${id}-${i + 1}`,
      actor: COACH,
    });
    assert.equal(r.deduplicated, false);
  }

  // 交接前在新场地不能用旧场地处方训练（旧负荷问题）。
  assert.equal(
    svc.canExecute(id, "PLAN-P-MOVE-1", V2, "2026-09-05T08:00:00+08:00").valid,
    false
  );

  await svc.transferVenue({
    event_id: "tr-1",
    participant_id: id,
    occurred_at: "2026-09-05T18:00:00+08:00",
    plan_id: "PLAN-P-MOVE-1",
    to_venue_id: V2,
    actor: COORD,
  });

  // 交接后：名额 = 6 - 2 = 4 原子迁到新场地；旧场地立即失效。
  const atNew = svc.canExecute(id, "PLAN-P-MOVE-1", V2, "2026-09-06T08:00:00+08:00");
  assert.equal(atNew.valid, true);
  assert.equal(atNew.remaining_slots, 4);
  assert.equal(
    svc.canExecute(id, "PLAN-P-MOVE-1", V1, "2026-09-06T08:00:00+08:00").valid,
    false
  );

  const trail = svc.handoffTrail(id);
  const transfer = trail.find((t) => t.kind === "venue_transfer");
  assert.deepEqual(transfer.retained_completed_sessions.sort(), ["SES-P-MOVE-1", "SES-P-MOVE-2"]);
  assert.equal(transfer.moved_slots, 4);

  // 新场地教练完成一次课，名额变 3；已完成历史仍是 3 次。
  await svc.recordSession({
    event_id: "s-move-3",
    participant_id: id,
    occurred_at: "2026-09-06T08:00:00+08:00",
    plan_id: "PLAN-P-MOVE-1",
    venue_id: V2,
    session_id: "SES-P-MOVE-3",
    actor: COACH2,
  });
  assert.equal(svc.canExecute(id, "PLAN-P-MOVE-1", V2, "2026-09-07T08:00:00+08:00").remaining_slots, 3);
});

test("场地交接必须由协调员执行，且不能重复 / 同场地", async () => {
  const id = await seedReadyParticipant("P-TRAUTH");
  await assert.rejects(
    () =>
      svc.transferVenue({
        event_id: "tr-bad-role",
        participant_id: id,
        occurred_at: "2026-09-05T18:00:00+08:00",
        plan_id: "PLAN-P-TRAUTH-1",
        to_venue_id: V2,
        actor: COACH,
      }),
    AuthorizationError
  );
  await svc.transferVenue({
    event_id: "tr-ok",
    participant_id: id,
    occurred_at: "2026-09-05T18:00:00+08:00",
    plan_id: "PLAN-P-TRAUTH-1",
    to_venue_id: V2,
    actor: COORD,
  });
  await assert.rejects(
    () =>
      svc.transferVenue({
        event_id: "tr-again",
        participant_id: id,
        occurred_at: "2026-09-06T18:00:00+08:00",
        plan_id: "PLAN-P-TRAUTH-1",
        to_venue_id: V2,
        actor: COORD,
      }),
    ConflictError
  );
});

test("补录胸闷事件阻断下一次课程（迟到事实按发生时间入链）", async () => {
  const id = await seedReadyParticipant("P-CHEST");
  // 9-08 完成课程。
  await svc.recordSession({
    event_id: "s-before",
    participant_id: id,
    occurred_at: "2026-09-08T08:00:00+08:00",
    plan_id: "PLAN-P-CHEST-1",
    venue_id: V1,
    session_id: "SES-CHEST-1",
    actor: COACH,
  });

  // 9-09 训练期间出现胸闷，但 9-11 才补录。
  await svc.recordObservation({
    event_id: "obs-late",
    participant_id: id,
    occurred_at: "2026-09-09T08:20:00+08:00",
    observation_id: "OBS-1",
    session_id: "SES-CHEST-2",
    symptom: "胸闷",
    severity: "severe",
    actor: COACH,
  });

  // 协调员依据补录事实发起紧急停止。
  await svc.emergencyStop({
    event_id: "stop-1",
    participant_id: id,
    occurred_at: "2026-09-11T10:00:00+08:00",
    reason: "补录训练中胸闷，启动紧急停止",
    observation_id: "OBS-1",
    actor: COORD,
  });

  // 9-12 的课被阻断：旧处方已作废。
  const verdict = svc.canExecute(id, "PLAN-P-CHEST-1", V1, "2026-09-12T08:00:00+08:00");
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.join("；").includes("紧急停止"));

  await assert.rejects(
    () =>
      svc.recordSession({
        event_id: "s-blocked",
        participant_id: id,
        occurred_at: "2026-09-12T08:00:00+08:00",
        plan_id: "PLAN-P-CHEST-1",
        venue_id: V1,
        session_id: "SES-CHEST-X",
        actor: COACH,
      }),
    (err) => err instanceof ConflictError && /紧急停止|作废/.test(err.message)
  );
});

test("严重观察在医生复核前直接阻断后续课程，复核后不阻断", async () => {
  const id = await seedReadyParticipant("P-GATE");
  await svc.recordObservation({
    event_id: "obs-gate",
    participant_id: id,
    occurred_at: "2026-09-08T08:20:00+08:00",
    observation_id: "OBS-G",
    symptom: "头晕伴黑朦",
    severity: "severe",
    actor: COACH,
  });
  let v = svc.canExecute(id, "PLAN-P-GATE-1", V1, "2026-09-09T08:00:00+08:00");
  assert.equal(v.valid, false);
  assert.ok(v.reasons.join("；").includes("OBS-G"));

  // 中度观察不阻断（只产生升层建议）。
  await seedReadyParticipant("P-GATE2");
  await svc.recordObservation({
    event_id: "obs-mild",
    participant_id: "P-GATE2",
    occurred_at: "2026-09-08T08:20:00+08:00",
    observation_id: "OBS-M",
    symptom: "轻微气喘",
    severity: "moderate",
    actor: COACH,
  });
  v = svc.canExecute("P-GATE2", "PLAN-P-GATE2-1", V1, "2026-09-09T08:00:00+08:00");
  assert.equal(v.valid, true);
  const advice = svc.adviseTier("P-GATE2", "2026-09-09T08:00:00+08:00");
  assert.equal(advice.advised_tier, "moderate");
});

test("紧急停止后恢复必须引用新评估；旧评估不可用", async () => {
  const id = await seedReadyParticipant("P-RES");
  await svc.emergencyStop({
    event_id: "stop-r",
    participant_id: id,
    occurred_at: "2026-09-09T09:00:00+08:00",
    reason: "胸闷",
    actor: COORD,
  });

  // 停止状态下医生不能直接开新处方。
  await assert.rejects(
    () =>
      svc.approvePlan({
        event_id: "plan-during-stop",
        participant_id: id,
        occurred_at: "2026-09-09T15:00:00+08:00",
        plan_id: "PLAN-P-RES-2",
        venue_id: V1,
        load: baseLoad(4),
        valid_from: "2026-09-10T00:00:00+08:00",
        valid_until: "2026-10-31T23:59:59+08:00",
        actor: DOCTOR,
      }),
    ConflictError
  );

  // 教练不能恢复。
  await assert.rejects(
    () =>
      svc.signResumption({
        event_id: "res-coach",
        participant_id: id,
        occurred_at: "2026-09-10T09:00:00+08:00",
        review_id: "REV-1",
        actor: COACH,
      }),
    AuthorizationError
  );

  // 医生完成新评估。
  await svc.completeReview({
    event_id: "rev-1",
    participant_id: id,
    occurred_at: "2026-09-10T11:00:00+08:00",
    review_id: "REV-1",
    assessment_summary: "复查心电图、心肌酶正常，考虑运动相关胸壁不适",
    findings: "ECG 正常",
    actor: DOCTOR,
  });

  // 不能引用不存在的评估恢复。
  await assert.rejects(
    () =>
      svc.signResumption({
        event_id: "res-noexist",
        participant_id: id,
        occurred_at: "2026-09-10T12:00:00+08:00",
        review_id: "REV-404",
        actor: DOCTOR,
      }),
    ConflictError
  );

  // 引用新评估恢复（旧处方仍作废，需重新开方）。
  await svc.signResumption({
    event_id: "res-1",
    participant_id: id,
    occurred_at: "2026-09-10T12:00:00+08:00",
    review_id: "REV-1",
    load_adjustment: "时长减半至 15 分钟，心率上限 110",
    actor: DOCTOR,
  });

  // 恢复后旧处方仍不可执行，待办提示重新开方。
  const oldPlan = svc.canExecute(id, "PLAN-P-RES-1", V1, "2026-09-11T08:00:00+08:00");
  assert.equal(oldPlan.valid, false);
  assert.ok(oldPlan.reasons.join("；").includes("作废"));
  const pending = svc.pendingReviews(id, "2026-09-11T08:00:00+08:00").map((p) => p.code);
  assert.ok(pending.includes("NEW_PLAN_AFTER_EMERGENCY_STOP"));

  // 医生凭新评估开新处方后方可训练。
  await svc.approvePlan({
    event_id: "plan-new",
    participant_id: id,
    occurred_at: "2026-09-11T09:00:00+08:00",
    plan_id: "PLAN-P-RES-2",
    venue_id: V1,
    load: { ...baseLoad(6), duration_min: 15, max_heart_rate: 110 },
    valid_from: "2026-09-11T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
    actor: DOCTOR,
  });
  assert.equal(svc.canExecute(id, "PLAN-P-RES-2", V1, "2026-09-12T08:00:00+08:00").valid, true);
});

test("恢复不能引用停止/暂停之前的旧评估", async () => {
  const id = "P-OLDREV";
  await seedReadyParticipant(id);
  // 先有一次评估（在暂停前）。
  await svc.signPause({
    event_id: "pause-1",
    participant_id: id,
    occurred_at: "2026-09-09T09:00:00+08:00",
    reason: "血压波动，暂停观察",
    actor: DOCTOR,
  });
  await svc.completeReview({
    event_id: "rev-old",
    participant_id: id,
    occurred_at: "2026-09-10T11:00:00+08:00",
    review_id: "REV-OLD",
    assessment_summary: "复测血压回落",
    actor: DOCTOR,
  });
  // 再次紧急停止，旧评估在停止之前。
  await svc.emergencyStop({
    event_id: "stop-2",
    participant_id: id,
    occurred_at: "2026-09-11T09:00:00+08:00",
    reason: "再发胸闷",
    actor: COORD,
  });
  await assert.rejects(
    () =>
      svc.signResumption({
        event_id: "res-old",
        participant_id: id,
        occurred_at: "2026-09-11T15:00:00+08:00",
        review_id: "REV-OLD",
        actor: DOCTOR,
      }),
    /新评估/
  );
});

test("迟到补录不改写历史：回看课程解释与后续处方/训练影响", async () => {
  const id = "P-LATE";
  await seedReadyParticipant(id);
  await svc.recordSession({
    event_id: "s-late-1",
    participant_id: id,
    occurred_at: "2026-09-08T08:00:00+08:00",
    plan_id: "PLAN-P-LATE-1",
    venue_id: V1,
    session_id: "SES-LATE-1",
    actor: COACH,
  });

  // 迟来的禁忌补录：发生时间 9-07，接收时间（链版本）在课程之后。
  await svc.noteContraindication({
    event_id: "ci-late",
    participant_id: id,
    occurred_at: "2026-09-07T12:00:00+08:00",
    code: "UNSTABLE_ANGINA",
    detail: "外院 9-07 诊断，资料 9-10 才送达",
    actor: DOCTOR,
  });

  const impact = svc.lateEventImpact(id, "ci-late");
  // 9-08 的课程在禁忌发生时间之后 → 被标记为受影响。
  const s = impact.affected_sessions.find((x) => x.session_id === "SES-LATE-1");
  assert.ok(s);
  assert.equal(s.retrospective_concern, true);

  // 课程解释：当时为何允许，事后为何应阻断；历史事件本身未被改写。
  const explanation = svc.explainSession(id, "SES-LATE-1");
  assert.equal(explanation.decision_at_time.allowed, true);
  assert.ok(explanation.decision_at_time.reasons.join("；").includes("可训练状态"));
  assert.equal(explanation.late_event_flags[0].event_id, "ci-late");
  assert.match(explanation.late_event_verdict, /不应执行|阻断/);

  const events = store.list(`participant:${id}`);
  const course = events.find((e) => e.event_id === "s-late-1");
  assert.equal(course.occurred_at, "2026-09-08T08:00:00+08:00");
  assert.equal(course.event_type, "SESSION_RECORDED");
});

test("重复设备回执不增加运动量且命令幂等", async () => {
  const id = "P-RECEIPT";
  await seedReadyParticipant(id, { slots: 3 });
  const payload = {
    event_id: "s-rec-1",
    participant_id: id,
    occurred_at: "2026-09-08T08:00:00+08:00",
    plan_id: "PLAN-P-RECEIPT-1",
    venue_id: V1,
    session_id: "SES-RC-1",
    device_receipt_id: "DEV-RCPT-9001",
    actor: COACH,
  };
  const first = await svc.recordSession(payload);
  assert.equal(first.deduplicated, false);

  // 设备网络重试，同一回执再来一次：不新增课程。
  const second = await svc.recordSession({ ...payload, event_id: "s-rec-1-dup" });
  assert.equal(second.deduplicated, true);
  assert.equal(second.existing_event_id, "s-rec-1");

  // 同一 event_id 重放也幂等。
  const replayResult = await svc.recordSession(payload);
  assert.equal(replayResult.deduplicated, false);

  const state = replay(store.list(`participant:${id}`));
  assert.equal(state.sessions.length, 1);
  assert.equal(state.plans.get("PLAN-P-RECEIPT-1").remaining_slots, 2);
  assert.equal(store.findReceipt(`participant:${id}`, "DEV-RCPT-9001").event_id, "s-rec-1");
});

test("教练视图不暴露筛查与禁忌等临床细节", async () => {
  const id = "P-PRIV";
  await seedReadyParticipant(id);
  await svc.noteContraindication({
    event_id: "ci-priv",
    participant_id: id,
    occurred_at: "2026-09-07T12:00:00+08:00",
    code: "HYPERTENSION_CRISIS",
    detail: "收缩压 190，临床细节不应给教练",
    actor: DOCTOR,
  });

  const view = svc.coachView(id, "2026-09-08T08:00:00+08:00");
  const json = JSON.stringify(view);
  assert.ok(!json.includes("HYPERTENSION"));
  assert.ok(!json.includes("190"));
  assert.ok(!json.includes("systolic_bp"));
  assert.ok(!json.includes("detail"));
  // 但教练能看到“为什么今天不能上课”的执行性结论（无临床编码 / 数值 / 症状）。
  const text = JSON.stringify(view.plan.reasons) + JSON.stringify(view.notices);
  assert.ok(/医学限制|不能|暂停/.test(text));

  // 时间线同样脱敏。
  const coachTimeline = svc.timeline(id, COACH);
  assert.ok(!coachTimeline.some((e) => e.event_type === "CONTRAINDICATION_NOTED"));
  assert.ok(!coachTimeline.some((e) => e.event_type === "SCREENING_RECORDED"));
  const docTimeline = svc.timeline(id, DOCTOR);
  assert.ok(docTimeline.some((e) => e.event_type === "CONTRAINDICATION_NOTED"));
});

test("教练时间线不含紧急停止的临床原因", async () => {
  const id = "P-STOPPRIV";
  await seedReadyParticipant(id);
  await svc.emergencyStop({
    event_id: "stop-priv",
    participant_id: id,
    occurred_at: "2026-09-09T09:00:00+08:00",
    reason: "训练中胸闷伴出汗，疑似心绞痛",
    actor: COORD,
  });
  const coachJson = JSON.stringify(svc.timeline(id, COACH));
  assert.ok(!coachJson.includes("胸闷"));
  assert.ok(!coachJson.includes("心绞痛"));
  const docJson = JSON.stringify(svc.timeline(id, DOCTOR));
  assert.ok(docJson.includes("胸闷"));
});

test("协调员可说明某次课程为何允许、谁在何时接手", async () => {
  const id = "P-WHY";
  await seedReadyParticipant(id, { slots: 5 });
  await svc.recordSession({
    event_id: "s-why-1",
    participant_id: id,
    occurred_at: "2026-09-03T08:00:00+08:00",
    plan_id: "PLAN-P-WHY-1",
    venue_id: V1,
    session_id: "SES-WHY-1",
    actor: COACH,
  });
  await svc.transferVenue({
    event_id: "tr-why",
    participant_id: id,
    occurred_at: "2026-09-05T18:00:00+08:00",
    plan_id: "PLAN-P-WHY-1",
    to_venue_id: V2,
    actor: COORD,
  });
  await svc.emergencyStop({
    event_id: "stop-why",
    participant_id: id,
    occurred_at: "2026-09-09T09:00:00+08:00",
    reason: "胸闷",
    actor: COORD,
  });
  await svc.completeReview({
    event_id: "rev-why",
    participant_id: id,
    occurred_at: "2026-09-10T10:00:00+08:00",
    review_id: "REV-WHY",
    assessment_summary: "无异常",
    actor: DOCTOR2,
  });
  await svc.signResumption({
    event_id: "res-why",
    participant_id: id,
    occurred_at: "2026-09-10T11:00:00+08:00",
    review_id: "REV-WHY",
    actor: DOCTOR2,
  });

  const explanation = svc.explainSession(id, "SES-WHY-1");
  assert.equal(explanation.decision_at_time.allowed, true);
  assert.ok(explanation.later_stops.some((s) => s.event_id === "stop-why"));

  const trail = svc.handoffTrail(id);
  assert.deepEqual(
    trail.map((t) => t.kind),
    ["venue_transfer", "emergency_stop", "resumption"]
  );
  assert.equal(trail[0].by.staff_id, COORD.staff_id);
  assert.equal(trail[2].by.staff_id, DOCTOR2.staff_id);
  assert.equal(trail[2].review_id, "REV-WHY");
});

test("服务重启后待复核事项仍可派生", async () => {
  const id = "P-RESTART";
  await seedReadyParticipant(id);
  await svc.emergencyStop({
    event_id: "stop-rs",
    participant_id: id,
    occurred_at: "2026-09-09T09:00:00+08:00",
    reason: "胸闷",
    actor: COORD,
  });

  // 用同一文件重建存储与服务，模拟进程重启。
  const reopened = new EventStore(store.filePath);
  const svc2 = new RiskRelayService(reopened);
  const all = svc2.pendingAll("2026-09-12T08:00:00+08:00");
  const mine = all.find((x) => x.participant_id === id);
  assert.ok(mine);
  const codes = mine.pending.map((p) => p.code);
  assert.ok(codes.includes("MEDICAL_REVIEW_AFTER_EMERGENCY_STOP"));
  assert.equal(mine.pending[0].required_role, "physician");

  // 完成复核后，待办变为“等待恢复签署”。
  await svc2.completeReview({
    event_id: "rev-rs",
    participant_id: id,
    occurred_at: "2026-09-10T10:00:00+08:00",
    review_id: "REV-RS",
    assessment_summary: "评估完成",
    actor: DOCTOR,
  });
  const reopened2 = new EventStore(store.filePath);
  const svc3 = new RiskRelayService(reopened2);
  const codes2 = svc3.pendingReviews(id, "2026-09-12T08:00:00+08:00").map((p) => p.code);
  assert.ok(codes2.includes("PHYSICIAN_RESUMPTION_SIGNATURE"));
  assert.ok(!codes2.includes("MEDICAL_REVIEW_AFTER_EMERGENCY_STOP"));
});

test("暂停—复核—恢复流程：暂停期间训练被拒绝", async () => {
  const id = "P-PAUSE";
  await seedReadyParticipant(id);
  await svc.signPause({
    event_id: "pause-p",
    participant_id: id,
    occurred_at: "2026-09-08T17:00:00+08:00",
    reason: "血压偏高，暂停两周观察",
    actor: DOCTOR,
  });
  assert.equal(svc.canExecute(id, `PLAN-${id}-1`, V1, "2026-09-09T08:00:00+08:00").valid, false);

  await svc.completeReview({
    event_id: "rev-p",
    participant_id: id,
    occurred_at: "2026-09-20T10:00:00+08:00",
    review_id: "REV-P",
    assessment_summary: "血压控制良好，可恢复",
    actor: DOCTOR,
  });
  await svc.signResumption({
    event_id: "res-p",
    participant_id: id,
    occurred_at: "2026-09-20T11:00:00+08:00",
    review_id: "REV-P",
    actor: DOCTOR,
  });
  assert.equal(svc.canExecute(id, `PLAN-${id}-1`, V1, "2026-09-21T08:00:00+08:00").valid, true);
});

test("名额耗尽与处方版本更替", async () => {
  const id = "P-SLOTS";
  await seedReadyParticipant(id, { slots: 1 });
  await svc.recordSession({
    event_id: "s-slot-1",
    participant_id: id,
    occurred_at: "2026-09-03T08:00:00+08:00",
    plan_id: "PLAN-P-SLOTS-1",
    venue_id: V1,
    session_id: "SES-SLOT-1",
    actor: COACH,
  });
  assert.equal(svc.canExecute(id, "PLAN-P-SLOTS-1", V1, "2026-09-04T08:00:00+08:00").valid, false);

  // 医生开新处方，旧处方状态为 superseded，教练拿到新处方。
  await svc.approvePlan({
    event_id: "plan-2",
    participant_id: id,
    occurred_at: "2026-09-05T09:00:00+08:00",
    plan_id: "PLAN-P-SLOTS-2",
    venue_id: V1,
    load: baseLoad(4),
    valid_from: "2026-09-05T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
    actor: DOCTOR,
  });
  const view = svc.coachView(id, "2026-09-06T08:00:00+08:00");
  assert.equal(view.plan.plan_id, "PLAN-P-SLOTS-2");
  assert.equal(view.plan.remaining_slots, 4);
});

test("载荷校验：配速区间、有效期、空事实均被拒绝", async () => {
  const id = "P-VALID";
  await assert.rejects(
    () =>
      svc.recordScreening({
        event_id: "scr-empty",
        participant_id: id,
        occurred_at: "2026-09-01T09:00:00+08:00",
        venue_id: V1,
        facts: [],
        actor: NURSE,
      }),
    ValidationError
  );
  await svc.recordScreening({
    event_id: "scr-v",
    participant_id: id,
    occurred_at: "2026-09-01T09:00:00+08:00",
    venue_id: V1,
    facts: [{ key: "age", value: 50 }],
    actor: NURSE,
  });
  await svc.signTier({
    event_id: "tier-v",
    participant_id: id,
    occurred_at: "2026-09-01T10:00:00+08:00",
    tier: "low",
    actor: DOCTOR,
  });
  await assert.rejects(
    () =>
      svc.approvePlan({
        event_id: "plan-bad-pace",
        participant_id: id,
        occurred_at: "2026-09-01T11:00:00+08:00",
        plan_id: "PLAN-BAD",
        venue_id: V1,
        load: { ...baseLoad(), pace_sec_per_km_min: 600, pace_sec_per_km_max: 480 },
        valid_from: "2026-10-01T00:00:00+08:00",
        valid_until: "2026-09-01T00:00:00+08:00",
        actor: DOCTOR,
      }),
    ValidationError
  );
});

test("事件按发生时间进入个人链，版本按接收顺序单调递增", async () => {
  const id = "P-ORDER";
  await seedReadyParticipant(id);
  // 迟到补录：发生时间早于处方，但版本号更大。
  await svc.noteContraindication({
    event_id: "ci-order",
    participant_id: id,
    occurred_at: "2026-08-30T12:00:00+08:00",
    code: "ARRHYTHMIA",
    detail: "迟交资料",
    actor: DOCTOR,
  });
  const events = store
    .list(`participant:${id}`)
    .sort((a, b) => a.version - b.version)
    .map((e) => ({ type: e.event_type, v: e.version }));
  assert.deepEqual(
    events.map((e) => e.v),
    [1, 2, 3, 4]
  );
  // 重放顺序按发生时间：禁忌虽版本 4，却排在链首。
  const state = replay(store.list(`participant:${id}`));
  assert.equal(state.events[0].event_type, "CONTRAINDICATION_NOTED");
});

test("领域错误携带错误码", async () => {
  const id = "P-CODE";
  await seedReadyParticipant(id);
  try {
    await svc.transferVenue({
      event_id: "tr-code",
      participant_id: id,
      occurred_at: "2026-09-05T18:00:00+08:00",
      plan_id: "PLAN-P-CODE-1",
      to_venue_id: V2,
      actor: COACH,
    });
    assert.fail("应拒绝");
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal(err.code, "AUTHORIZATION_ERROR");
  }
});
