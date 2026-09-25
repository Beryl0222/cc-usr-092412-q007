import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RiskRelayService } from "../src/service.js";
import { EventStore } from "../src/store.js";

const physician = { id: "dr-wang", role: "physician" };
const coach = { id: "coach-li", role: "coach" };
const coordinator = { id: "coord-zhao", role: "coordinator" };

function setup() {
  const service = new RiskRelayService(new EventStore());
  service.recordScreening({
    actor: physician,
    participant_id: "p-001",
    occurred_at: "2026-09-01T09:00:00+08:00",
    conclusion: "可参加低强度超慢跑",
  });
  service.issuePrescription({
    actor: physician,
    participant_id: "p-001",
    prescription_id: "rx-1",
    venue_id: "venue-a",
    valid_from: "2026-09-01T00:00:00+08:00",
    valid_to: "2026-09-30T23:59:59+08:00",
    load: { pace: "6km/h", minutes: 30 },
    occurred_at: "2026-09-01T10:00:00+08:00",
  });
  return service;
}

test("换到新场地后旧处方不能执行", () => {
  const service = setup();
  service.scheduleSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-1",
    prescription_id: "rx-1",
    venue_id: "venue-b",
    scheduled_at: "2026-09-10T08:00:00+08:00",
  });
  const result = service.completeSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-1",
    occurred_at: "2026-09-10T08:30:00+08:00",
    device_receipt_id: "rc-1",
    volume: 30,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("不适用于")));
  const explain = service.explainSession("s-1");
  assert.equal(explain.allowed, false);
  assert.equal(explain.decided_by.id, "coach-li");
});

test("期限外的处方不能执行，期限内允许且可解释", () => {
  const service = setup();
  service.scheduleSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-2",
    prescription_id: "rx-1",
    venue_id: "venue-a",
    scheduled_at: "2026-10-02T08:00:00+08:00",
  });
  const late = service.completeSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-2",
    occurred_at: "2026-10-02T08:30:00+08:00",
    device_receipt_id: "rc-2",
    volume: 30,
  });
  assert.equal(late.allowed, false);
  assert.ok(late.reasons.some((r) => r.includes("期限")));

  service.scheduleSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-3",
    prescription_id: "rx-1",
    venue_id: "venue-a",
    scheduled_at: "2026-09-12T08:00:00+08:00",
  });
  const ok = service.completeSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-3",
    occurred_at: "2026-09-12T08:30:00+08:00",
    device_receipt_id: "rc-3",
    volume: 30,
  });
  assert.equal(ok.allowed, true);
  assert.equal(service.explainSession("s-3").allowed, true);
  assert.equal(service.trainingVolume("p-001"), 30);
});

test("自动分层只给建议，签署需要资质，越权签署被拒绝", () => {
  const service = setup();
  const obs = service.recordObservation({
    actor: coach,
    participant_id: "p-001",
    occurred_at: "2026-09-05T09:00:00+08:00",
    severity: "chest_pain",
    note: "课中胸闷",
  });
  assert.equal(obs.suggestion.data.suggestion.action, "pause");

  // 建议本身不阻断：未签署前课程仍可执行
  service.scheduleSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-4",
    prescription_id: "rx-1",
    venue_id: "venue-a",
    scheduled_at: "2026-09-06T08:00:00+08:00",
  });
  assert.equal(
    service.completeSession({ actor: coach, participant_id: "p-001", session_id: "s-4", occurred_at: "2026-09-06T08:30:00+08:00", device_receipt_id: "rc-4", volume: 20 }).allowed,
    true,
  );

  // 教练无权签署暂停/升级/恢复
  assert.equal(service.signPause({ actor: coach, participant_id: "p-001", occurred_at: "2026-09-06T09:00:00+08:00" }).ok, false);
  assert.equal(service.signEscalation({ actor: coach, participant_id: "p-001", level: "high", occurred_at: "2026-09-06T09:00:00+08:00" }).ok, false);
  assert.equal(service.signResume({ actor: coach, participant_id: "p-001", occurred_at: "2026-09-06T09:00:00+08:00" }).ok, false);

  // 医生签署暂停后课程被阻断
  assert.equal(service.signPause({ actor: physician, participant_id: "p-001", occurred_at: "2026-09-06T09:00:00+08:00", rationale: "胸闷待查" }).ok, true);
  service.scheduleSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-5",
    prescription_id: "rx-1",
    venue_id: "venue-a",
    scheduled_at: "2026-09-07T08:00:00+08:00",
  });
  const blocked = service.completeSession({ actor: coach, participant_id: "p-001", session_id: "s-5", occurred_at: "2026-09-07T08:30:00+08:00", device_receipt_id: "rc-5", volume: 20 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.some((r) => r.includes("暂停")));
});

test("紧急停止立即阻断，恢复必须引用停止之后的新评估", () => {
  const service = setup();
  service.emergencyStop({ actor: coach, participant_id: "p-001", occurred_at: "2026-09-08T08:00:00+08:00", reason: "现场晕厥" });
  service.scheduleSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-6",
    prescription_id: "rx-1",
    venue_id: "venue-a",
    scheduled_at: "2026-09-09T08:00:00+08:00",
  });
  const blocked = service.completeSession({ actor: coach, participant_id: "p-001", session_id: "s-6", occurred_at: "2026-09-09T08:30:00+08:00", device_receipt_id: "rc-6", volume: 20 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.some((r) => r.includes("紧急停止")));

  // 无新评估引用不能恢复；引用停止之前的旧评估也不能恢复
  assert.equal(service.signResume({ actor: physician, participant_id: "p-001", occurred_at: "2026-09-09T10:00:00+08:00" }).ok, false);
  const stale = service.recordScreening({
    actor: physician,
    participant_id: "p-001",
    occurred_at: "2026-09-07T09:00:00+08:00",
    conclusion: "停止前的旧评估",
  });
  assert.equal(service.signResume({ actor: physician, participant_id: "p-001", occurred_at: "2026-09-09T10:00:00+08:00", assessment_event_id: stale.event.event_id }).ok, false);

  // 停止之后的新评估可以支撑恢复
  const fresh = service.recordScreening({
    actor: physician,
    participant_id: "p-001",
    occurred_at: "2026-09-09T09:30:00+08:00",
    conclusion: "复查通过，可恢复低强度",
  });
  assert.equal(service.signResume({ actor: physician, participant_id: "p-001", occurred_at: "2026-09-09T10:00:00+08:00", assessment_event_id: fresh.event.event_id }).ok, true);
  service.scheduleSession({
    actor: coach,
    participant_id: "p-001",
    session_id: "s-7",
    prescription_id: "rx-1",
    venue_id: "venue-a",
    scheduled_at: "2026-09-10T08:00:00+08:00",
  });
  assert.equal(
    service.completeSession({ actor: coach, participant_id: "p-001", session_id: "s-7", occurred_at: "2026-09-10T08:30:00+08:00", device_receipt_id: "rc-7", volume: 20 }).allowed,
    true,
  );
});

test("迟到事件开启回看复核，历史不被改写，重启后待办仍在", () => {
  const dir = mkdtempSync(join(tmpdir(), "risk-relay-"));
  const file = join(dir, "events.jsonl");
  const service = new RiskRelayService(new EventStore(file));
  service.recordScreening({ actor: physician, participant_id: "p-001", occurred_at: "2026-09-01T09:00:00+08:00", conclusion: "可参加" });
  service.issuePrescription({
    actor: physician,
    participant_id: "p-001",
    prescription_id: "rx-1",
    venue_id: "venue-a",
    valid_from: "2026-09-01T00:00:00+08:00",
    valid_to: "2026-09-30T23:59:59+08:00",
    load: { pace: "6km/h", minutes: 30 },
    occurred_at: "2026-09-01T10:00:00+08:00",
  });
  service.scheduleSession({ actor: coach, participant_id: "p-001", session_id: "s-1", prescription_id: "rx-1", venue_id: "venue-a", scheduled_at: "2026-09-05T08:00:00+08:00" });
  service.completeSession({ actor: coach, participant_id: "p-001", session_id: "s-1", occurred_at: "2026-09-05T08:30:00+08:00", device_receipt_id: "rc-1", volume: 30 });

  // 补录 9 月 3 日的胸闷事件（晚于课程发生时间才登记）
  const late = service.recordObservation({
    actor: physician,
    participant_id: "p-001",
    occurred_at: "2026-09-03T15:00:00+08:00",
    severity: "chest_pain",
    note: "补录：9 月 3 日课中胸闷",
  });
  assert.ok(late.retro_review, "迟到事件应开启回看复核");
  assert.deepEqual(late.retro_review.data.affected_session_ids, ["s-1"]);
  assert.deepEqual(late.retro_review.data.affected_prescription_ids, ["rx-1"]);

  // 历史课程记录保持原样
  const explain = service.explainSession("s-1");
  assert.equal(explain.allowed, true);
  assert.equal(explain.status, "completed");

  // 重启后待办复核依然可查
  const reopened = new RiskRelayService(new EventStore(file));
  const pending = reopened.pendingReviews();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].trigger_event_id, late.event.event_id);

  // 完结复核后待办清空，历史链不变
  assert.equal(
    reopened.resolveReview({ actor: coordinator, participant_id: "p-001", review_id: pending[0].review_id, outcome: "已电话随访，无需调整", occurred_at: "2026-09-06T10:00:00+08:00" }).ok,
    true,
  );
  assert.equal(reopened.pendingReviews().length, 0);
  assert.equal(reopened.participantChain("p-001").some((e) => e.event_type === "RETRO_REVIEW_RESOLVED"), true);
});

test("场地交接保留已完成课程，未执行名额与负荷原子迁移", () => {
  const service = setup();
  service.scheduleSession({ actor: coach, participant_id: "p-001", session_id: "done-1", prescription_id: "rx-1", venue_id: "venue-a", scheduled_at: "2026-09-03T08:00:00+08:00" });
  service.completeSession({ actor: coach, participant_id: "p-001", session_id: "done-1", occurred_at: "2026-09-03T08:30:00+08:00", device_receipt_id: "rc-d1", volume: 30 });
  service.scheduleSession({ actor: coach, participant_id: "p-001", session_id: "todo-1", prescription_id: "rx-1", venue_id: "venue-a", scheduled_at: "2026-09-20T08:00:00+08:00" });

  // 无有效处方的场地交接失败且不产生任何事件
  const before = service.store.events.length;
  assert.equal(service.venueHandoff({ actor: coordinator, participant_id: "p-001", from_venue_id: "venue-x", to_venue_id: "venue-b", occurred_at: "2026-09-15T10:00:00+08:00" }).ok, false);
  assert.equal(service.store.events.length, before);

  const handoff = service.venueHandoff({ actor: coordinator, participant_id: "p-001", from_venue_id: "venue-a", to_venue_id: "venue-b", occurred_at: "2026-09-15T10:00:00+08:00" });
  assert.equal(handoff.ok, true);
  assert.deepEqual(handoff.migrated_session_ids, ["todo-1"]);

  // 已完成课程仍归属原场地
  assert.equal(service.explainSession("done-1").venue_id, "venue-a");
  // 迁移后的课程在新场地按原负荷执行
  const view = service.coachView("p-001");
  const migrated = view.sessions.find((s) => s.session_id === "todo-1");
  assert.equal(migrated.venue_id, "venue-b");
  const newRx = view.prescriptions.find((rx) => rx.prescription_id === "rx-1@venue-b");
  assert.deepEqual(newRx.load, { pace: "6km/h", minutes: 30 });
  assert.equal(
    service.completeSession({ actor: coach, participant_id: "p-001", session_id: "todo-1", occurred_at: "2026-09-20T08:30:00+08:00", device_receipt_id: "rc-t1", volume: 30 }).allowed,
    true,
  );

  // 时间线能说明谁在何时接手
  const timeline = service.handoverTimeline("p-001");
  assert.equal(timeline[0].kind, "venue_handoff");
  assert.equal(timeline[0].actor.id, "coord-zhao");
});

test("重复设备回执不增加运动量", () => {
  const service = setup();
  service.scheduleSession({ actor: coach, participant_id: "p-001", session_id: "s-1", prescription_id: "rx-1", venue_id: "venue-a", scheduled_at: "2026-09-05T08:00:00+08:00" });
  const first = service.completeSession({ actor: coach, participant_id: "p-001", session_id: "s-1", occurred_at: "2026-09-05T08:30:00+08:00", device_receipt_id: "rc-dup", volume: 30 });
  assert.equal(first.allowed, true);
  const again = service.completeSession({ actor: coach, participant_id: "p-001", session_id: "s-1", occurred_at: "2026-09-05T08:35:00+08:00", device_receipt_id: "rc-dup", volume: 30 });
  assert.equal(again.duplicate, true);
  assert.equal(service.trainingVolume("p-001"), 30);
});

test("教练视图不含临床细节，临床视图按角色放行", () => {
  const service = setup();
  service.recordScreening({
    actor: physician,
    participant_id: "p-001",
    occurred_at: "2026-09-02T09:00:00+08:00",
    conclusion: "随访观察",
    contraindications: ["未控制的高血压"],
    detail: "建议心内科随访",
  });
  service.recordObservation({ actor: coach, participant_id: "p-001", occurred_at: "2026-09-04T09:00:00+08:00", severity: "mild", note: "轻微气喘" });

  const view = service.coachView("p-001");
  const text = JSON.stringify(view);
  assert.ok(!text.includes("高血压"), "教练视图不得包含禁忌明细");
  assert.ok(!text.includes("气喘"), "教练视图不得包含观察记录");
  assert.ok(text.includes("6km/h"), "教练视图应包含负荷处方");

  assert.equal(service.clinicalView(coach, "p-001"), null);
  const clinical = service.clinicalView(physician, "p-001");
  assert.equal(clinical.screenings.at(-1).contraindications[0], "未控制的高血压");
});

test("个人链按发生时间排序，事件版本不被原地改写", () => {
  const service = setup();
  service.recordObservation({ actor: coach, participant_id: "p-001", occurred_at: "2026-08-30T09:00:00+08:00", severity: "mild", note: "补录早期观察" });
  const chain = service.participantChain("p-001");
  const times = chain.map((e) => e.occurred_at);
  const sorted = [...times].sort();
  assert.deepEqual(times, sorted);
  const versions = chain.map((e) => `${e.event_id}@${e.version}`);
  assert.equal(new Set(versions).size, versions.length);
});
