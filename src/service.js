import { checkRole, coachViewOf } from "./access.js";
import { AGGREGATES as A, EVENT_TYPES as T, SEVERE_OBSERVATIONS, makeEvent } from "./events.js";

/** 迟到后需要触发回看复核的临床事件类型。 */
const CLINICAL_TYPES = new Set([T.SCREENING_RECORDED, T.OBSERVATION_RECORDED]);

function blankParticipant(participantId) {
  return {
    participant_id: participantId,
    chain: [],
    screenings: [],
    observations: [],
    prescriptions: new Map(),
    sessions: new Map(),
    receipts: new Set(),
    reviews: new Map(),
    suggestions: [],
    escalations: [],
    handovers: [],
    stop: null,
    paused: false,
    pause_event: null,
  };
}

/**
 * 风险接力领域服务。所有状态变化都先落成事件再更新投影，
 * 重启后由事件存储重放恢复，待办复核因此不会丢失。
 */
export class RiskRelayService {
  constructor(store, { now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.now = now;
    this.participants = new Map();
    for (const event of store.events) this._apply(event);
  }

  // ---------- 命令 ----------

  /** 登记筛查结论与禁忌（医生）。 */
  recordScreening({ actor, participant_id, occurred_at, conclusion, contraindications = [], detail = "", event_id }) {
    const denied = checkRole(actor, "recordScreening");
    if (denied) return { ok: false, error: denied };
    const event = makeEvent({
      event_id,
      event_type: T.SCREENING_RECORDED,
      aggregate_type: A.PARTICIPANT_CHAIN,
      aggregate_id: participant_id,
      occurred_at,
      actor,
      participant_id,
      summary: `筛查结论：${conclusion}`,
      data: { conclusion, contraindications, detail },
    });
    this._commit([event]);
    const suggestion = this._stratify(participant_id, event);
    const review = this._openRetroReviewIfLate(participant_id, event);
    return { ok: true, event, suggestion, retro_review: review };
  }

  /** 开具负荷处方（医生），新处方取代同参与者当前有效处方。 */
  issuePrescription({ actor, participant_id, prescription_id, venue_id, valid_from, valid_to, load, occurred_at, event_id }) {
    const denied = checkRole(actor, "issuePrescription");
    if (denied) return { ok: false, error: denied };
    const event = makeEvent({
      event_id,
      event_type: T.PRESCRIPTION_ISSUED,
      aggregate_type: A.PRESCRIPTION,
      aggregate_id: prescription_id,
      occurred_at,
      actor,
      participant_id,
      summary: `开具处方 ${prescription_id}（场地 ${venue_id}，${valid_from} 至 ${valid_to}）`,
      data: { prescription_id, venue_id, valid_from, valid_to, load },
    });
    this._commit([event]);
    return { ok: true, event };
  }

  /** 排定课程名额（协调员/教练）。 */
  scheduleSession({ actor, participant_id, session_id, prescription_id, venue_id, scheduled_at, slots = 1, occurred_at, event_id }) {
    const denied = checkRole(actor, "scheduleSession");
    if (denied) return { ok: false, error: denied };
    const event = makeEvent({
      event_id,
      event_type: T.SESSION_SCHEDULED,
      aggregate_type: A.TRAINING_SESSION,
      aggregate_id: session_id,
      occurred_at: occurred_at ?? scheduled_at,
      actor,
      participant_id,
      summary: `排定课程 ${session_id}（场地 ${venue_id}）`,
      data: { session_id, prescription_id, venue_id, scheduled_at, slots },
    });
    this._commit([event]);
    return { ok: true, event };
  }

  /**
   * 记录课程完成（教练）。先按“执行当下”的状态做准入门禁：
   * 紧急停止/暂停未解除、处方与场地或期限不符都会被拒绝并留下决定记录。
   * 设备回执按 receipt_id 去重，重复回执不增加运动量。
   */
  completeSession({ actor, participant_id, session_id, occurred_at, device_receipt_id, volume = 0, event_id }) {
    const denied = checkRole(actor, "completeSession");
    if (denied) return { ok: false, error: denied };
    const p = this._participant(participant_id);
    if (device_receipt_id && p.receipts.has(device_receipt_id)) {
      return { ok: true, duplicate: true, allowed: true, reasons: ["设备回执已入账，运动量不重复累计"] };
    }
    const reasons = this._admissionReasons(p, session_id, occurred_at);
    const allowed = reasons.length === 0;
    const event = makeEvent({
      event_id,
      event_type: allowed ? T.SESSION_COMPLETED : T.SESSION_REJECTED,
      aggregate_type: A.TRAINING_SESSION,
      aggregate_id: session_id,
      occurred_at,
      actor,
      participant_id,
      summary: allowed ? `课程 ${session_id} 完成` : `课程 ${session_id} 被拒绝：${reasons.join("；")}`,
      data: { session_id, allowed, reasons, device_receipt_id, volume: allowed ? volume : 0 },
    });
    this._commit([event]);
    return { ok: true, allowed, reasons, event };
  }

  /** 登记异常观察（教练/医生）。 */
  recordObservation({ actor, participant_id, occurred_at, severity, note = "", event_id }) {
    const denied = checkRole(actor, "recordObservation");
    if (denied) return { ok: false, error: denied };
    const event = makeEvent({
      event_id,
      event_type: T.OBSERVATION_RECORDED,
      aggregate_type: A.PARTICIPANT_CHAIN,
      aggregate_id: participant_id,
      occurred_at,
      actor,
      participant_id,
      summary: `异常观察（${severity}）：${note}`,
      data: { severity, note },
    });
    this._commit([event]);
    const suggestion = this._stratify(participant_id, event);
    const review = this._openRetroReviewIfLate(participant_id, event);
    return { ok: true, event, suggestion, retro_review: review };
  }

  /** 紧急停止：任何在场人员可触发，立即阻断后续训练。 */
  emergencyStop({ actor, participant_id, occurred_at, reason, event_id }) {
    const denied = checkRole(actor, "emergencyStop");
    if (denied) return { ok: false, error: denied };
    const event = makeEvent({
      event_id,
      event_type: T.EMERGENCY_STOPPED,
      aggregate_type: A.PARTICIPANT_CHAIN,
      aggregate_id: participant_id,
      occurred_at,
      actor,
      participant_id,
      summary: `紧急停止：${reason}`,
      data: { reason },
    });
    this._commit([event]);
    return { ok: true, event };
  }

  /** 签署风险升级（医生）。 */
  signEscalation({ actor, participant_id, level, rationale = "", occurred_at, event_id }) {
    const denied = checkRole(actor, "signEscalation");
    if (denied) return { ok: false, error: denied };
    const event = makeEvent({
      event_id,
      event_type: T.RISK_ESCALATED,
      aggregate_type: A.PARTICIPANT_CHAIN,
      aggregate_id: participant_id,
      occurred_at,
      actor,
      participant_id,
      summary: `风险升级为 ${level}：${rationale}`,
      data: { level, rationale },
    });
    this._commit([event]);
    return { ok: true, event };
  }

  /** 签署暂停（医生）。 */
  signPause({ actor, participant_id, rationale = "", occurred_at, event_id }) {
    const denied = checkRole(actor, "signPause");
    if (denied) return { ok: false, error: denied };
    const event = makeEvent({
      event_id,
      event_type: T.ACTIVITY_PAUSED,
      aggregate_type: A.PARTICIPANT_CHAIN,
      aggregate_id: participant_id,
      occurred_at,
      actor,
      participant_id,
      summary: `签署暂停：${rationale}`,
      data: { rationale },
    });
    this._commit([event]);
    return { ok: true, event };
  }

  /**
   * 签署恢复（医生）。若参与者处于紧急停止状态，
   * 必须引用停止之后登记的新评估（筛查）事件，否则拒绝恢复。
   */
  signResume({ actor, participant_id, occurred_at, assessment_event_id = null, rationale = "", event_id }) {
    const denied = checkRole(actor, "signResume");
    if (denied) return { ok: false, error: denied };
    const p = this._participant(participant_id);
    if (p.stop && !p.stop.resumed_at) {
      const assessment = assessment_event_id
        ? p.screenings.find((s) => s.event_id === assessment_event_id && s.occurred_at > p.stop.occurred_at)
        : null;
      if (!assessment) {
        return { ok: false, error: "紧急停止后的恢复必须引用停止之后登记的新评估" };
      }
    }
    const event = makeEvent({
      event_id,
      event_type: T.ACTIVITY_RESUMED,
      aggregate_type: A.PARTICIPANT_CHAIN,
      aggregate_id: participant_id,
      occurred_at,
      actor,
      participant_id,
      summary: `签署恢复${assessment_event_id ? `（依据评估 ${assessment_event_id}）` : ""}`,
      data: { rationale, assessment_event_id },
    });
    this._commit([event]);
    return { ok: true, event };
  }

  /**
   * 场地交接（协调员）：已完成课程保留在原场地，
   * 尚未执行的名额与负荷随处方原子迁移到新场地。
   * 任一步校验失败则整批不写入。
   */
  venueHandoff({ actor, participant_id, from_venue_id, to_venue_id, occurred_at, new_prescription_id, event_id }) {
    const denied = checkRole(actor, "venueHandoff");
    if (denied) return { ok: false, error: denied };
    const p = this._participant(participant_id);
    const rx = [...p.prescriptions.values()].find((item) => item.venue_id === from_venue_id && item.status === "active");
    if (!rx) return { ok: false, error: `场地 ${from_venue_id} 没有有效处方，交接中止` };
    const pending = [...p.sessions.values()].filter((s) => s.venue_id === from_venue_id && s.status !== "completed");
    const transferId = new_prescription_id ?? `${rx.prescription_id}@${to_venue_id}`;
    const transfer = makeEvent({
      event_type: T.PRESCRIPTION_TRANSFERRED,
      aggregate_type: A.PRESCRIPTION,
      aggregate_id: transferId,
      occurred_at,
      actor,
      participant_id,
      summary: `处方 ${rx.prescription_id} 迁移至场地 ${to_venue_id}`,
      data: {
        from_prescription_id: rx.prescription_id,
        new_prescription: { ...rx, prescription_id: transferId, venue_id: to_venue_id },
      },
    });
    const handoff = makeEvent({
      event_id,
      event_type: T.VENUE_HANDOFF_COMPLETED,
      aggregate_type: A.VENUE_HANDOFF,
      aggregate_id: `${participant_id}:${occurred_at}`,
      occurred_at,
      actor,
      participant_id,
      summary: `场地交接 ${from_venue_id} → ${to_venue_id}，迁移 ${pending.length} 节未执行课程`,
      data: {
        from_venue_id,
        to_venue_id,
        new_prescription_id: transferId,
        migrated_session_ids: pending.map((s) => s.session_id),
      },
    });
    this._commit([transfer, handoff]);
    return { ok: true, events: [transfer, handoff], migrated_session_ids: handoff.data.migrated_session_ids };
  }

  /** 完结一项回看复核（协调员/医生），历史记录保持不变。 */
  resolveReview({ actor, participant_id, review_id, outcome, occurred_at, event_id }) {
    const denied = checkRole(actor, "resolveReview");
    if (denied) return { ok: false, error: denied };
    const p = this._participant(participant_id);
    const review = p.reviews.get(review_id);
    if (!review || review.status !== "open") return { ok: false, error: `复核 ${review_id} 不存在或已完结` };
    const event = makeEvent({
      event_id,
      event_type: T.RETRO_REVIEW_RESOLVED,
      aggregate_type: A.REVIEW_TASK,
      aggregate_id: review_id,
      occurred_at,
      actor,
      participant_id,
      summary: `复核完结：${outcome}`,
      data: { review_id, outcome },
    });
    this._commit([event]);
    return { ok: true, event };
  }

  // ---------- 查询 ----------

  /** 个人链：按发生时间排序的全部事件。 */
  participantChain(participant_id) {
    const p = this.participants.get(participant_id);
    if (!p) return [];
    return [...p.chain].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.version - b.version));
  }

  /** 解释某次课程为何被允许或拒绝。 */
  explainSession(session_id) {
    for (const p of this.participants.values()) {
      const session = p.sessions.get(session_id);
      if (!session) continue;
      const decision = session.decisions.at(-1);
      return {
        participant_id: p.participant_id,
        session_id,
        venue_id: session.venue_id,
        status: session.status,
        allowed: decision ? decision.data.allowed : null,
        reasons: decision ? decision.data.reasons : ["课程尚未执行"],
        decided_at: decision ? decision.occurred_at : null,
        decided_by: decision ? decision.actor : null,
        prescription_id: session.prescription_id,
      };
    }
    return null;
  }

  /** 接手时间线：交接与全部签署/停止/恢复动作，说明谁在何时接手。 */
  handoverTimeline(participant_id) {
    const p = this.participants.get(participant_id);
    if (!p) return [];
    const entries = [
      ...p.handovers.map((e) => ({ kind: "venue_handoff", at: e.occurred_at, actor: e.actor, summary: e.summary })),
      ...p.chain
        .filter((e) => [T.RISK_ESCALATED, T.ACTIVITY_PAUSED, T.ACTIVITY_RESUMED, T.EMERGENCY_STOPPED].includes(e.event_type))
        .map((e) => ({ kind: e.event_type, at: e.occurred_at, actor: e.actor, summary: e.summary })),
    ];
    return entries.sort((a, b) => (a.at < b.at ? -1 : 1));
  }

  /** 待完成的回看复核（重启后依然可查）。 */
  pendingReviews() {
    const open = [];
    for (const p of this.participants.values()) {
      for (const review of p.reviews.values()) {
        if (review.status === "open") open.push({ participant_id: p.participant_id, ...review });
      }
    }
    return open;
  }

  /** 教练视图：只含执行必需字段。 */
  coachView(participant_id) {
    const p = this.participants.get(participant_id);
    return p ? coachViewOf(p) : null;
  }

  /** 临床视图：仅医生与协调员可见完整临床细节。 */
  clinicalView(actor, participant_id) {
    if (!actor || !["physician", "coordinator"].includes(actor.role)) return null;
    const p = this.participants.get(participant_id);
    if (!p) return null;
    return {
      participant_id,
      screenings: p.screenings.map((e) => e.data),
      observations: p.observations.map((e) => e.data),
      escalations: p.escalations.map((e) => e.data),
    };
  }

  /** 参与者累计运动量（重复回执不计入）。 */
  trainingVolume(participant_id) {
    const p = this.participants.get(participant_id);
    if (!p) return 0;
    return [...p.sessions.values()].reduce((sum, s) => sum + (s.status === "completed" ? s.volume ?? 0 : 0), 0);
  }

  // ---------- 内部 ----------

  _participant(participantId) {
    if (!this.participants.has(participantId)) this.participants.set(participantId, blankParticipant(participantId));
    return this.participants.get(participantId);
  }

  _commit(events) {
    const result = this.store.appendBatch(events);
    if (!result.appended) throw new Error("事件写入冲突，整批未提交");
    for (const event of result.events) this._apply(event);
  }

  /** 课程准入门禁：返回拒绝原因列表，空列表表示允许。 */
  _admissionReasons(p, sessionId, occurredAt) {
    const reasons = [];
    const session = p.sessions.get(sessionId);
    if (!session) {
      reasons.push("课程未登记");
    } else if (session.status === "completed") {
      reasons.push("课程已完成，不可重复记录");
    } else {
      const rx = p.prescriptions.get(session.prescription_id);
      if (!rx) reasons.push("处方不存在");
      else {
        if (rx.status !== "active") reasons.push(`处方状态为 ${rx.status}，不可执行`);
        if (rx.venue_id !== session.venue_id) reasons.push(`处方限定场地 ${rx.venue_id}，不适用于 ${session.venue_id}`);
        if (occurredAt < rx.valid_from || occurredAt > rx.valid_to) reasons.push("超出处方有效期限");
      }
    }
    if (p.stop && !p.stop.resumed_at && p.stop.occurred_at <= occurredAt) reasons.push("紧急停止未解除");
    if (p.paused && p.pause_event && p.pause_event.occurred_at <= occurredAt) reasons.push("活动已被签署暂停");
    return reasons;
  }

  /** 自动风险分层：只生成建议事件，不改变任何执行状态。 */
  _stratify(participantId, trigger) {
    let suggestion = null;
    if (trigger.event_type === T.SCREENING_RECORDED && trigger.data.contraindications.length > 0) {
      suggestion = { action: "escalate", level: "high", basis: trigger.event_id };
    }
    if (trigger.event_type === T.OBSERVATION_RECORDED && SEVERE_OBSERVATIONS.has(trigger.data.severity)) {
      suggestion = { action: "pause", basis: trigger.event_id };
    }
    if (!suggestion) return null;
    const event = makeEvent({
      event_type: T.RISK_SUGGESTION_GENERATED,
      aggregate_type: A.PARTICIPANT_CHAIN,
      aggregate_id: participantId,
      occurred_at: this.now(),
      participant_id: participantId,
      summary: `自动分层建议：${suggestion.action}（需有资质人员签署后生效）`,
      data: { suggestion },
    });
    this._commit([event]);
    return event;
  }

  /**
   * 迟到的临床事件不回写历史，而是开启一项回看复核，
   * 列出其发生时间之后可能受影响的处方与课程。
   */
  _openRetroReviewIfLate(participantId, event) {
    if (!CLINICAL_TYPES.has(event.event_type)) return null;
    const p = this._participant(participantId);
    const later = p.chain.filter((e) => e.event_id !== event.event_id && e.occurred_at > event.occurred_at);
    if (later.length === 0) return null;
    const affectedPrescriptions = [...p.prescriptions.values()]
      .filter((rx) => rx.valid_to >= event.occurred_at)
      .map((rx) => rx.prescription_id);
    const affectedSessions = [...p.sessions.values()]
      .filter((s) => (s.scheduled_at ?? "") > event.occurred_at)
      .map((s) => s.session_id);
    const reviewId = `review-${event.event_id}`;
    const review = makeEvent({
      event_type: T.RETRO_REVIEW_OPENED,
      aggregate_type: A.REVIEW_TASK,
      aggregate_id: reviewId,
      occurred_at: this.now(),
      participant_id: participantId,
      summary: `迟到事件 ${event.event_id} 触发回看复核`,
      data: {
        review_id: reviewId,
        trigger_event_id: event.event_id,
        trigger_occurred_at: event.occurred_at,
        affected_prescription_ids: affectedPrescriptions,
        affected_session_ids: affectedSessions,
      },
    });
    this._commit([review]);
    return review;
  }

  _apply(event) {
    const p = this._participant(event.participant_id);
    p.chain.push(event);
    switch (event.event_type) {
      case T.SCREENING_RECORDED:
        p.screenings.push(event);
        break;
      case T.OBSERVATION_RECORDED:
        p.observations.push(event);
        break;
      case T.PRESCRIPTION_ISSUED:
        for (const rx of p.prescriptions.values()) {
          if (rx.status === "active") rx.status = "superseded";
        }
        p.prescriptions.set(event.data.prescription_id, { ...event.data, status: "active" });
        break;
      case T.PRESCRIPTION_TRANSFERRED: {
        const old = p.prescriptions.get(event.data.from_prescription_id);
        if (old) old.status = "transferred";
        const next = event.data.new_prescription;
        p.prescriptions.set(next.prescription_id, { ...next, status: "active" });
        break;
      }
      case T.SESSION_SCHEDULED:
        p.sessions.set(event.data.session_id, { ...event.data, status: "scheduled", decisions: [] });
        break;
      case T.SESSION_COMPLETED:
      case T.SESSION_REJECTED: {
        const session = p.sessions.get(event.data.session_id);
        if (session) {
          session.decisions.push(event);
          session.status = event.event_type === T.SESSION_COMPLETED ? "completed" : "rejected";
          if (event.event_type === T.SESSION_COMPLETED) {
            session.volume = event.data.volume;
            if (event.data.device_receipt_id) p.receipts.add(event.data.device_receipt_id);
          }
        }
        break;
      }
      case T.RISK_SUGGESTION_GENERATED:
        p.suggestions.push(event);
        break;
      case T.RISK_ESCALATED:
        p.escalations.push(event);
        break;
      case T.ACTIVITY_PAUSED:
        p.paused = true;
        p.pause_event = event;
        break;
      case T.ACTIVITY_RESUMED:
        p.paused = false;
        if (p.stop) p.stop.resumed_at = event.occurred_at;
        break;
      case T.EMERGENCY_STOPPED:
        p.stop = event;
        break;
      case T.RETRO_REVIEW_OPENED:
        p.reviews.set(event.data.review_id, { ...event.data, status: "open", opened_at: event.occurred_at });
        break;
      case T.RETRO_REVIEW_RESOLVED: {
        const review = p.reviews.get(event.data.review_id);
        if (review) {
          review.status = "resolved";
          review.outcome = event.data.outcome;
          review.resolved_at = event.occurred_at;
        }
        break;
      }
      case T.VENUE_HANDOFF_COMPLETED:
        p.handovers.push(event);
        for (const sessionId of event.data.migrated_session_ids) {
          const session = p.sessions.get(sessionId);
          if (session && session.status !== "completed") {
            session.venue_id = event.data.to_venue_id;
            session.prescription_id = event.data.new_prescription_id;
          }
        }
        break;
      default:
        break;
    }
  }
}
