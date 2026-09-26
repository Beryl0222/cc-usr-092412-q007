/**
 * 纯领域规则：从个人链事件重放状态，并给出分层建议、处方有效性、
 * 教练最小视图、课程解释、待办复核与迟到事件影响。
 *
 * 约定：
 * - 链按（occurred_at 发生时间, version 接收序号）排序重放；
 *   version 反映接收顺序，迟到事件不会重写历史事件的 version。
 * - 本文件不做任何文件 / 网络 IO，也不判断“当前操作人是谁”，
 *   角色权限由 service 层负责。
 */
import { ConflictError, ValidationError } from "./errors.js";

const TIER_RANK = { low: 1, moderate: 2, high: 3 };

export function timeOf(value, label = "occurred_at") {
  if (typeof value !== "string") throw new ValidationError(`${label} 必须是 ISO 时间字符串`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ValidationError(`${label} 不是合法时间：${value}`);
  return ms;
}

/* ---------------- 自动风险分层（只提建议） ---------------- */

/**
 * 根据筛查事实、活动禁忌与异常观察给出分层建议。
 * 该结果永远只是“建议”：升级必须由医生签署 RISK_TIER_SIGNED。
 */
export function suggestTier(facts = [], activeContraindications = [], observations = []) {
  const factMap = new Map();
  for (const f of facts) factMap.set(f.key, f.value);

  const reasons = [];
  let tier = "low";
  const bump = (t, reason) => {
    reasons.push(reason);
    if (TIER_RANK[t] > TIER_RANK[tier]) tier = t;
  };

  if (activeContraindications.length > 0) {
    bump("high", `存在活动禁忌：${activeContraindications.map((c) => c.code).join("、")}`);
  }

  const age = Number(factMap.get("age"));
  if (Number.isFinite(age) && age >= 70) bump("high", `年龄 ${age} 岁，建议高风险`);
  else if (Number.isFinite(age) && age >= 60) bump("moderate", `年龄 ${age} 岁，建议中风险`);

  const systolic = Number(factMap.get("systolic_bp"));
  if (Number.isFinite(systolic)) {
    if (systolic >= 160) bump("high", `收缩压 ${systolic} mmHg，建议高风险`);
    else if (systolic >= 140) bump("moderate", `收缩压 ${systolic} mmHg，建议中风险`);
  }

  const restingHr = Number(factMap.get("resting_hr"));
  if (Number.isFinite(restingHr) && restingHr >= 90) {
    bump("moderate", `静息心率 ${restingHr} 次/分，建议中风险`);
  }
  if (factMap.get("has_chest_discomfort_history") === true) {
    bump("high", "既往胸闷 / 胸部不适合史，建议高风险");
  }

  for (const o of observations) {
    if (o.severity === "severe") bump("high", `严重异常观察：${o.symptom}`);
    else if (o.severity === "moderate") bump("moderate", `中度异常观察：${o.symptom}`);
  }

  if (reasons.length === 0) reasons.push("未命中任何升层规则，建议低风险");
  return { advised_tier: tier, reasons, advice_source: "auto" };
}

/* ---------------- 链重放 ---------------- */

/**
 * 把一个参与者的事件列表重放为当前状态。
 * 输入不会被修改；事件按发生时间排序，接收次序（version）作为同位依据。
 */
export function replay(events) {
  const ordered = [...events].sort((a, b) => {
    const ta = timeOf(a.occurred_at);
    const tb = timeOf(b.occurred_at);
    return ta - tb || a.version - b.version;
  });

  const state = {
    participant_id: null,
    status: "active",
    venue_id: null,
    facts: new Map(),
    contraindications: new Map(), // code -> {code, detail, active, noted_at, resolved_at}
    tiers: [], // {tier, reason, at, event_id, signed_by}
    currentTier: null,
    plans: new Map(), // plan_id -> plan
    currentPlanId: null,
    sessions: [],
    observations: [],
    stops: [],
    pauses: [],
    reviews: [],
    resumes: [],
    transfers: [],
    receipts: new Map(), // device_receipt_id -> session_id
    screenings: [],
    events: ordered,
  };

  for (const e of ordered) {
    const p = e.payload || {};
    const at = e.occurred_at;
    switch (e.event_type) {
      case "SCREENING_RECORDED": {
        state.participant_id = p.participant_id;
        if (p.venue_id) state.venue_id = p.venue_id;
        state.screenings.push({ at, facts: p.facts || [], event_id: e.event_id });
        for (const f of p.facts || []) state.facts.set(f.key, f.value);
        break;
      }
      case "CONTRAINDICATION_NOTED": {
        state.contraindications.set(p.code, {
          code: p.code,
          detail: p.detail,
          active: true,
          noted_at: at,
          resolved_at: null,
          event_id: e.event_id,
        });
        break;
      }
      case "RISK_TIER_SIGNED": {
        state.tiers.push({ tier: p.tier, reason: p.reason, at, event_id: e.event_id, signed_by: p.signed_by });
        state.currentTier = p.tier;
        break;
      }
      case "PLAN_APPROVED": {
        if (state.currentPlanId) {
          const old = state.plans.get(state.currentPlanId);
          // 只有仍在执行的处方被“取代”；紧急停止作废的处方保留作废结论。
          if (old.status === "active") {
            old.status = "superseded";
            old.superseded_at = at;
          }
        }
        state.plans.set(p.plan_id, {
          plan_id: p.plan_id,
          venue_id: p.venue_id,
          load: p.load,
          valid_from: p.valid_from,
          valid_until: p.valid_until,
          remaining_slots: p.load.remaining_slots,
          status: "active",
          approved_at: at,
          event_id: e.event_id,
        });
        state.currentPlanId = p.plan_id;
        break;
      }
      case "VENUE_TRANSFERRED": {
        const plan = state.plans.get(p.plan_id);
        // 已完成课程保留在历史 sessions 中不动；未执行名额与负荷原子迁移到新场地。
        plan.venue_id = p.to_venue_id;
        plan.remaining_slots = p.moved_slots;
        if (p.moved_load) plan.load = p.moved_load;
        state.venue_id = p.to_venue_id;
        state.transfers.push({
          plan_id: p.plan_id,
          from_venue_id: p.from_venue_id,
          to_venue_id: p.to_venue_id,
          moved_slots: p.moved_slots,
          completed_session_ids: p.completed_session_ids || [],
          at,
          by: p.transferred_by,
          event_id: e.event_id,
        });
        break;
      }
      case "SESSION_RECORDED": {
        const plan = state.plans.get(p.plan_id);
        plan.remaining_slots -= p.slots_used ?? 1;
        state.sessions.push({
          session_id: p.session_id,
          plan_id: p.plan_id,
          venue_id: p.venue_id,
          at,
          slots_used: p.slots_used ?? 1,
          load: p.completed_load || plan.load,
          receipt_id: p.device_receipt_id || null,
          event_id: e.event_id,
          version: e.version,
        });
        if (p.device_receipt_id) state.receipts.set(p.device_receipt_id, p.session_id);
        break;
      }
      case "ABNORMAL_OBSERVATION_RECORDED": {
        state.observations.push({
          observation_id: p.observation_id,
          session_id: p.session_id || null,
          symptom: p.symptom,
          severity: p.severity,
          at,
          by: p.observed_by,
          event_id: e.event_id,
          version: e.version,
        });
        break;
      }
      case "EMERGENCY_STOP_ISSUED": {
        state.status = "emergency_stopped";
        state.stops.push({ at, reason: p.reason, observation_id: p.observation_id || null, by: p.issued_by, event_id: e.event_id });
        // 紧急停止立即阻断后续训练：当前处方作废，恢复后须凭新评估重新开方。
        if (state.currentPlanId) {
          const plan = state.plans.get(state.currentPlanId);
          if (plan.status === "active") {
            plan.status = "voided";
            plan.voided_at = at;
            plan.voided_reason = "EMERGENCY_STOP";
          }
        }
        break;
      }
      case "PAUSE_SIGNED": {
        state.status = "paused";
        state.pauses.push({ at, reason: p.reason, by: p.signed_by, event_id: e.event_id });
        break;
      }
      case "REVIEW_COMPLETED": {
        state.reviews.push({
          review_id: p.review_id,
          at,
          findings: p.findings,
          assessment_summary: p.assessment_summary,
          by: p.completed_by,
          event_id: e.event_id,
        });
        for (const code of p.resolves_contraindications || []) {
          const c = state.contraindications.get(code);
          if (c) {
            c.active = false;
            c.resolved_at = at;
          }
        }
        break;
      }
      case "RESUMPTION_SIGNED": {
        state.status = "active";
        state.resumes.push({
          at,
          review_id: p.review_id,
          load_adjustment: p.load_adjustment || null,
          by: p.signed_by,
          event_id: e.event_id,
        });
        break;
      }
      default:
        // RISK_FLAGGED / ACTIVITY_PAUSED 等兼容事件不驱动状态机。
        break;
    }
  }

  return state;
}

/* ---------------- 处方有效性 ---------------- */

export function activeContraindications(state, atMs) {
  return [...state.contraindications.values()].filter(
    (c) =>
      timeOf(c.noted_at) <= atMs &&
      (!c.resolved_at || timeOf(c.resolved_at) > atMs)
  );
}

/**
 * 判定处方在指定场地、指定时间是否可执行，并给出全部拒绝理由。
 * 不传 atMs 时按“当前”评估（含迟到补录后回看的结论）。
 */
export function evaluatePlan(state, planId, atIso = new Date().toISOString(), venueId = null) {
  const plan = state.plans.get(planId);
  const atMs = timeOf(atIso);
  const reasons = [];

  if (!plan) return { plan_id: planId, valid: false, reasons: ["处方不存在"] };

  if (plan.status === "voided") reasons.push(`处方已被紧急停止作废（${plan.voided_at}），恢复后须凭新评估重新开方`);
  if (plan.status === "superseded") reasons.push("处方已被新版本取代");
  if (state.status === "emergency_stopped") reasons.push("个人链处于紧急停止状态，一切训练阻断");
  if (state.status === "paused") reasons.push("个人链处于医生签署暂停状态");
  if (atMs < timeOf(plan.valid_from)) reasons.push(`尚未到生效时间 ${plan.valid_from}`);
  if (atMs > timeOf(plan.valid_until)) reasons.push(`处方已过有效期 ${plan.valid_until}`);
  if (plan.remaining_slots <= 0) reasons.push("剩余可执行名额为 0");
  if (venueId && plan.venue_id !== venueId) {
    reasons.push(`处方仅在场地 ${plan.venue_id} 有效，当前场地为 ${venueId}`);
  }
  const blockers = activeContraindications(state, atMs);
  if (blockers.length > 0) reasons.push(`存在未解除的活动禁忌：${blockers.map((c) => c.code).join("、")}`);

  return {
    plan_id: planId,
    venue_id: plan.venue_id,
    load: plan.load,
    remaining_slots: plan.remaining_slots,
    valid_from: plan.valid_from,
    valid_until: plan.valid_until,
    status: plan.status,
    valid: reasons.length === 0,
    reasons,
  };
}

/* ---------------- 教练最小视图（数据最小化） ---------------- */

/**
 * 教练视图的理由脱敏：禁忌编码、症状等临床细节不下发给教练，
 * 只保留“能不能练、为什么不能练”的执行性结论。
 */
export function sanitizeForCoach(reason) {
  if (reason.includes("活动禁忌") || reason.includes("医学禁忌")) {
    return "存在未解除的医学限制，训练暂停，等待医生评估（临床细节见医疗记录）";
  }
  if (reason.includes("严重异常观察")) {
    return "存在尚未经医生复核的异常情况，训练暂停（临床细节见医疗记录）";
  }
  return reason;
}

/**
 * 教练视图：只含执行处方所需信息。
 * 不返回筛查事实、既往病史、禁忌编码与细节、评估原文等临床内容。
 */
export function coachView(state, atIso = new Date().toISOString(), extraReasons = []) {
  const view = {
    participant_id: state.participant_id,
    venue_id: state.venue_id,
    status: state.status,
    plan: null,
    notices: [],
  };

  if (state.currentPlanId) {
    const r = evaluatePlan(state, state.currentPlanId, atIso);
    const reasons = [...r.reasons, ...extraReasons].map(sanitizeForCoach);
    view.plan = {
      plan_id: r.plan_id,
      venue_id: r.venue_id,
      load: r.load,
      remaining_slots: r.remaining_slots,
      valid_from: r.valid_from,
      valid_until: r.valid_until,
      valid: reasons.length === 0,
      reasons: reasons.length === 0 ? [] : reasons,
    };
  } else {
    view.notices.push("当前无有效处方，不得安排训练");
  }

  const lastResume = state.resumes[state.resumes.length - 1];
  if (state.status === "active" && lastResume) {
    view.notices.push(
      `链已于 ${lastResume.at} 恢复（基于复核 ${lastResume.review_id}）` +
        (lastResume.load_adjustment ? `，负荷调整：${lastResume.load_adjustment}` : "")
    );
  }
  if (state.status === "emergency_stopped") {
    const stop = state.stops[state.stops.length - 1];
    view.notices.push(`紧急停止生效中（${stop.at}），等待医生新评估与恢复签署`);
  }
  if (state.status === "paused") view.notices.push("暂停生效中，等待医生复核与恢复签署");

  return view;
}

/* ---------------- 课程解释：为何允许 / 为何停止 ---------------- */

/**
 * 解释某次已记录课程当时为何被允许，以及迟到补录 / 后续事件对它的回看结论。
 * - at_time：用“发生时间 <= 课程时间、且在课程之前接收”的事件还原当时判断；
 * - late_facts：发生时间 <= 课程时间、但接收晚于课程的迟到事实（如补录胸闷）；
 * - after_then：课程之后发生的停止 / 复核等，用于说明后续为何叫停。
 */
export function explainSession(state, sessionId) {
  const session = state.sessions.find((s) => s.session_id === sessionId);
  if (!session) return null;
  const tMs = timeOf(session.at);

  const knownThen = state.events.filter(
    (e) => timeOf(e.occurred_at) <= tMs && e.version < session.version
  );
  const thenState = replay(knownThen);
  const planThen = thenState.plans.get(session.plan_id);

  // “当时是否允许”只依据课程发生时已经接收到的信息，不受迟到补录影响。
  const allowedReasons = [];
  const thenBlockers = [];
  if (thenState.status === "active") allowedReasons.push("课程发生时个人链处于可训练状态");
  else thenBlockers.push(`课程发生时个人链状态为 ${thenState.status}`);
  if (!planThen) thenBlockers.push("课程发生时处方不存在或尚未开具");
  if (planThen && planThen.venue_id === session.venue_id) {
    allowedReasons.push(`处方 ${session.plan_id} 绑定场地 ${session.venue_id}，与课程场地一致`);
  } else if (planThen) {
    thenBlockers.push(`处方场地 ${planThen.venue_id} 与课程场地 ${session.venue_id} 不一致`);
  }
  if (planThen && timeOf(planThen.valid_from) <= tMs && tMs <= timeOf(planThen.valid_until)) {
    allowedReasons.push(`课程时间在处方有效期 ${planThen.valid_from} ~ ${planThen.valid_until} 内`);
  }
  if (planThen && planThen.remaining_slots >= session.slots_used) {
    allowedReasons.push(`课程发生时处方剩余名额 ${planThen.remaining_slots}，足以执行本次 ${session.slots_used} 个名额`);
  }

  // 迟到事实：发生时间不晚于课程、但接收（版本）晚于课程，只能回看标记，不改写当时结论。
  const lateFacts = state.events.filter(
    (e) => timeOf(e.occurred_at) <= tMs && e.version > session.version
  );
  const stopReasons = [];
  for (const e of lateFacts) {
    if (e.event_type === "ABNORMAL_OBSERVATION_RECORDED") {
      stopReasons.push(`迟到补录的异常观察 ${e.payload.observation_id}（${e.payload.symptom}）按发生时间回看，本课程应被阻断`);
    }
    if (e.event_type === "CONTRAINDICATION_NOTED") {
      stopReasons.push(`迟到补录的禁忌 ${e.payload.code} 按发生时间回看，本课程不应执行`);
    }
  }

  const afterward = state.events.filter((e) => timeOf(e.occurred_at) > tMs);
  const laterStops = afterward.filter((e) => e.event_type === "EMERGENCY_STOP_ISSUED");

  return {
    session_id: sessionId,
    plan_id: session.plan_id,
    venue_id: session.venue_id,
    occurred_at: session.at,
    decision_at_time: {
      status_then: thenState.status,
      allowed: thenBlockers.length === 0,
      reasons: thenBlockers.length === 0 ? allowedReasons : thenBlockers,
    },
    late_event_flags: lateFacts.map((e) => ({
      event_id: e.event_id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      summary: e.summary,
    })),
    later_stops: laterStops.map((e) => ({
      event_id: e.event_id,
      at: e.occurred_at,
      reason: e.payload.reason,
      issued_by: e.payload.issued_by,
    })),
    late_event_verdict: stopReasons.length === 0 ? "未发现应阻断的迟到事实" : stopReasons.join("；"),
  };
}

/* ---------------- 待办复核（重启后仍可派生） ---------------- */

/**
 * 派生当前仍待完成的复核与签署。完全由事件链计算，服务重启后结论不变。
 */
export function pendingReviews(state, nowIso = new Date().toISOString()) {
  const nowMs = timeOf(nowIso);
  const pending = [];

  const lastStop = state.stops[state.stops.length - 1];
  const lastPause = state.pauses[state.pauses.length - 1];
  const lastResume = state.resumes[state.resumes.length - 1];

  if (state.status === "emergency_stopped" && lastStop) {
    const newReview = state.reviews.find((r) => timeOf(r.at) > timeOf(lastStop.at));
    if (!newReview) {
      pending.push({
        code: "MEDICAL_REVIEW_AFTER_EMERGENCY_STOP",
        description: "紧急停止后必须完成新的医学评估",
        since: lastStop.at,
        required_role: "physician",
      });
    } else if (!lastResume || timeOf(lastResume.at) < timeOf(newReview.at)) {
      pending.push({
        code: "PHYSICIAN_RESUMPTION_SIGNATURE",
        description: `新评估 ${newReview.review_id} 已完成，等待医生引用该评估签署恢复`,
        since: newReview.at,
        required_role: "physician",
      });
    }
  } else if (state.status === "paused" && lastPause) {
    const reviewAfterPause = state.reviews.find((r) => timeOf(r.at) > timeOf(lastPause.at));
    if (!reviewAfterPause) {
      pending.push({
        code: "MEDICAL_REVIEW_AFTER_PAUSE",
        description: "暂停后需医生完成复核评估",
        since: lastPause.at,
        required_role: "physician",
      });
    } else {
      pending.push({
        code: "PHYSICIAN_RESUMPTION_SIGNATURE",
        description: `复核 ${reviewAfterPause.review_id} 已完成，等待医生签署恢复`,
        since: reviewAfterPause.at,
        required_role: "physician",
      });
    }
  }

  if (state.status === "active" && state.currentPlanId) {
    const plan = state.plans.get(state.currentPlanId);
    if (plan.status === "voided") {
      pending.push({
        code: "NEW_PLAN_AFTER_EMERGENCY_STOP",
        description: "恢复后旧处方已作废，需医生凭新评估重新开具负荷处方",
        since: plan.voided_at,
        required_role: "physician",
      });
    }
  }

  // 自动建议高于已签署分层且尚无对应签署 → 待医生签署（建议本身不改状态）。
  const advice = suggestTier(
    [...state.facts].map(([key, value]) => ({ key, value })),
    activeContraindications(state, nowMs),
    state.observations
  );
  if (!state.currentTier || TIER_RANK[advice.advised_tier] > TIER_RANK[state.currentTier]) {
    pending.push({
      code: "PHYSICIAN_TIER_SIGNATURE",
      description: `自动分层建议为 ${advice.advised_tier}，当前签署分层为 ${state.currentTier || "未签署"}，等待医生签署`,
      reasons: advice.reasons,
      required_role: "physician",
    });
  }

  return pending;
}

/* ---------------- 迟到事件影响回看 ---------------- */

/**
 * 给定一条迟到补录事件，回看其发生时间之后的处方与训练是否受影响。
 * 不修改任何历史事件，只给出当前重放下的结论。
 */
export function lateEventImpact(state, eventId) {
  const target = state.events.find((e) => e.event_id === eventId);
  if (!target) return null;
  const tMs = timeOf(target.occurred_at);

  const affectedPlans = [];
  for (const plan of state.plans.values()) {
    if (timeOf(plan.approved_at) > tMs) {
      const r = evaluatePlan(state, plan.plan_id);
      affectedPlans.push({
        plan_id: plan.plan_id,
        approved_at: plan.approved_at,
        currently_executable: r.valid,
        reasons: r.reasons,
      });
    }
  }

  const affectedSessions = state.sessions
    .filter((s) => timeOf(s.at) > tMs)
    .map((s) => {
      const laterBlocking = state.events.some(
        (e) =>
          e.version > s.version &&
          timeOf(e.occurred_at) <= timeOf(s.at) &&
          (e.event_type === "ABNORMAL_OBSERVATION_RECORDED" ||
            e.event_type === "CONTRAINDICATION_NOTED" ||
            e.event_type === "EMERGENCY_STOP_ISSUED")
      );
      return {
        session_id: s.session_id,
        plan_id: s.plan_id,
        venue_id: s.venue_id,
        occurred_at: s.at,
        retrospective_concern: laterBlocking,
      };
    });

  return {
    event_id: eventId,
    event_type: target.event_type,
    occurred_at: target.occurred_at,
    affected_plans: affectedPlans,
    affected_sessions: affectedSessions,
    pending_reviews: pendingReviews(state).map((p) => p.code),
  };
}

/* ---------------- 载荷校验 ---------------- */

export function requireFields(obj, fields, label) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === "") {
      throw new ValidationError(`${label} 缺少字段：${f}`);
    }
  }
}

export function validateLoad(load) {
  if (!load || typeof load !== "object") throw new ValidationError("负荷处方 load 缺失");
  requireFields(load, ["pace_sec_per_km_min", "pace_sec_per_km_max", "duration_min", "remaining_slots"], "load");
  const { pace_sec_per_km_min: lo, pace_sec_per_km_max: hi, duration_min: dur, remaining_slots: slots } = load;
  if (!(Number.isFinite(lo) && Number.isFinite(hi)) || lo <= 0 || hi <= 0 || lo > hi) {
    throw new ValidationError("配速区间必须为正数且下限不大于上限");
  }
  if (!Number.isFinite(dur) || dur <= 0) throw new ValidationError("单次时长必须为正数");
  if (!Number.isInteger(slots) || slots <= 0) throw new ValidationError("剩余名额必须为正整数");
  if (load.max_heart_rate !== undefined && (!Number.isFinite(load.max_heart_rate) || load.max_heart_rate <= 0)) {
    throw new ValidationError("心率上限必须为正数");
  }
}

/** 恢复签署时校验：引用的复核必须存在，且严格晚于最近一次停止 / 暂停（即“新评估”）。 */
export function assertResumptionReview(state, reviewId) {
  const review = state.reviews.find((r) => r.review_id === reviewId);
  if (!review) throw new ConflictError(`恢复引用的复核 ${reviewId} 不存在`);
  const blockerAt = Math.max(
    ...[...state.stops, ...state.pauses].map((x) => timeOf(x.at)),
    0
  );
  if (blockerAt && timeOf(review.at) <= blockerAt) {
    throw new ConflictError("恢复必须引用停止 / 暂停之后完成的新评估，不能引用阻断前的旧评估");
  }
}
