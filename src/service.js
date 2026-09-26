/**
 * 风险接力服务门面：命令产生事件（只追加），查询由链重放派生。
 *
 * 关键不变量：
 * - 所有事实按 occurred_at（发生时间）进入个人链；迟到补录只追加，不改写历史；
 * - 自动风险分层只产出建议；分层升级 / 暂停 / 恢复必须相应资质人员签署；
 * - 紧急停止立即阻断后续训练并作废旧处方，恢复必须引用停止之后的新评估；
 * - 教练只能看到执行处方所需的最小信息，看不到筛查与禁忌等临床细节；
 * - 设备回执重复提交幂等，不产生第二次训练、不增加运动量；
 * - 场地交接以单事件原子完成：已完成课程保留，未执行名额与负荷一起迁移。
 */
import { validateEvent } from "./validator.js";
import {
  activeContraindications,
  assertResumptionReview,
  coachView,
  evaluatePlan,
  explainSession,
  lateEventImpact,
  pendingReviews,
  replay,
  requireFields,
  sanitizeForCoach,
  suggestTier,
  timeOf,
  validateLoad,
} from "./rules.js";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./errors.js";

const PHYSICIAN = "physician";
const COORDINATOR = "coordinator";
const COACH = "coach";
const NURSE = "screening_nurse";

const AGGREGATE = (participantId) => `participant:${participantId}`;

/** 各命令允许的签署角色。 */
const CAN = {
  recordScreening: [NURSE, COORDINATOR],
  noteContraindication: [NURSE, PHYSICIAN],
  signTier: [PHYSICIAN],
  approvePlan: [PHYSICIAN],
  transferVenue: [COORDINATOR],
  recordSession: [COACH],
  recordObservation: [COACH, COORDINATOR, NURSE],
  emergencyStop: [COORDINATOR],
  signPause: [PHYSICIAN],
  completeReview: [PHYSICIAN],
  signResumption: [PHYSICIAN],
};

export class RiskRelayService {
  constructor(store) {
    this.store = store;
  }

  /* ---------------- 内部工具 ---------------- */

  _allow(action, actor) {
    if (!actor || typeof actor.staff_id !== "string") throw new ValidationError("缺少签署 / 操作人信息 actor");
    if (!CAN[action].includes(actor.role)) {
      throw new AuthorizationError(`${actor.role} 无权执行 ${action}，需要 ${CAN[action].join(" 或 ")}`);
    }
  }

  _load(participantId) {
    const events = this.store.list(AGGREGATE(participantId));
    return { events, state: replay(events) };
  }

  /** 截至某发生时间的链投影（只含 occurred_at <= atIso 的事实）。 */
  _loadAsOf(participantId, atIso) {
    const cutoff = timeOf(atIso);
    const events = this.store
      .list(AGGREGATE(participantId))
      .filter((e) => timeOf(e.occurred_at) <= cutoff);
    return replay(events);
  }

  /** 在存储互斥区内完成“重放—判定—落事件”，命令天然串行。 */
  async _commit(participantId, eventId, fn) {
    return this.store.runExclusive(() => {
      // 命令幂等：同一 event_id 重放直接返回既有事件，不再走业务判定。
      const existing = this.store.get(eventId);
      if (existing) {
        if (existing.aggregate_id !== AGGREGATE(participantId)) {
          throw new ConflictError(`event_id ${eventId} 已用于其他参与者的链`);
        }
        return existing;
      }
      const events = this.store.list(AGGREGATE(participantId));
      const state = replay(events);
      const draft = fn(state);
      // 非事件结果（如重复设备回执去重）直接透传，不追加、不发版本号。
      if (draft && draft._noop) return draft;
      const event = this._build(participantId, draft);
      return this.store.appendInTx(event);
    });
  }

  _build(participantId, draft) {
    requireFields(draft, ["event_id", "event_type", "occurred_at", "summary"], "事件");
    const event = {
      event_id: draft.event_id,
      event_type: draft.event_type,
      aggregate_type: "participant_chain",
      aggregate_id: AGGREGATE(participantId),
      occurred_at: draft.occurred_at,
      version: this.store.nextVersion(AGGREGATE(participantId)),
      summary: draft.summary,
      payload: draft.payload || {},
    };
    timeOf(event.occurred_at);
    const envelopeErrors = validateEvent(event);
    if (envelopeErrors.length > 0) throw new ValidationError(envelopeErrors.join("；"));
    return event;
  }

  /* ---------------- 命令 ---------------- */

  /** 初筛登记（护士 / 协调员）。允许迟到补录，按发生时间入链。 */
  async recordScreening(cmd) {
    this._allow("recordScreening", cmd.actor);
    requireFields(cmd, ["event_id", "participant_id", "occurred_at", "venue_id", "facts"], "初筛");
    if (!Array.isArray(cmd.facts) || cmd.facts.length === 0) throw new ValidationError("初筛事实 facts 不能为空");
    return this._commit(cmd.participant_id, cmd.event_id, () => ({
      event_id: cmd.event_id,
      event_type: "SCREENING_RECORDED",
      occurred_at: cmd.occurred_at,
      summary: `登记 ${cmd.participant_id} 的初筛记录`,
      payload: {
        participant_id: cmd.participant_id,
        venue_id: cmd.venue_id,
        facts: cmd.facts,
        recorded_by: cmd.actor,
      },
    }));
  }

  /** 登记活动禁忌（护士 / 医生）。 */
  async noteContraindication(cmd) {
    this._allow("noteContraindication", cmd.actor);
    requireFields(cmd, ["event_id", "participant_id", "occurred_at", "code"], "禁忌");
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      if (state.contraindications.has(cmd.code)) {
        const existing = state.contraindications.get(cmd.code);
        if (existing.active) throw new ConflictError(`禁忌 ${cmd.code} 已登记且尚未解除`);
      }
      return {
        event_id: cmd.event_id,
        event_type: "CONTRAINDICATION_NOTED",
        occurred_at: cmd.occurred_at,
        summary: `登记活动禁忌 ${cmd.code}`,
        payload: {
          participant_id: cmd.participant_id,
          code: cmd.code,
          detail: cmd.detail || "",
          noted_by: cmd.actor,
        },
      };
    });
  }

  /**
   * 自动风险分层：只返回建议，不落状态、不改变任何分层。
   * 升级 / 调整必须由医生调用 signTier 签署后生效。
   */
  adviseTier(participantId, nowIso = new Date().toISOString()) {
    const { state } = this._load(participantId);
    const advice = suggestTier(
      [...state.facts].map(([key, value]) => ({ key, value })),
      activeContraindications(state, timeOf(nowIso)),
      state.observations
    );
    return { ...advice, current_signed_tier: state.currentTier };
  }

  /** 医生签署风险分层（升级 / 调整 / 维持）。自动建议不能替代签署。 */
  async signTier(cmd) {
    this._allow("signTier", cmd.actor);
    requireFields(cmd, ["event_id", "participant_id", "occurred_at", "tier"], "分层签署");
    if (!["low", "moderate", "high"].includes(cmd.tier)) throw new ValidationError("分层必须为 low/moderate/high");
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      const advice = suggestTier(
        [...state.facts].map(([key, value]) => ({ key, value })),
        activeContraindications(state, timeOf(cmd.occurred_at)),
        state.observations
      );
      const downgrade =
        state.currentTier &&
        ({ low: 1, moderate: 2, high: 3 })[state.currentTier] >
          ({ low: 1, moderate: 2, high: 3 })[cmd.tier];
      // 允许医生基于判断签署任意分层，但降层必须给出书面理由。
      if (downgrade && !cmd.reason) throw new ValidationError("降低已签署分层必须填写理由");
      return {
        event_id: cmd.event_id,
        event_type: "RISK_TIER_SIGNED",
        occurred_at: cmd.occurred_at,
        summary: `医生签署风险分层：${state.currentTier || "无"} → ${cmd.tier}`,
        payload: {
          participant_id: cmd.participant_id,
          tier: cmd.tier,
          reason: cmd.reason || advice.reasons.join("；"),
          auto_advice: advice,
          signed_by: cmd.actor,
        },
      };
    });
  }

  /** 医生开具负荷处方：绑定场地与有效期，含剩余名额。 */
  async approvePlan(cmd) {
    this._allow("approvePlan", cmd.actor);
    requireFields(
      cmd,
      ["event_id", "participant_id", "occurred_at", "plan_id", "venue_id", "load", "valid_from", "valid_until"],
      "处方"
    );
    validateLoad(cmd.load);
    if (timeOf(cmd.valid_until) <= timeOf(cmd.valid_from)) {
      throw new ValidationError("处方有效期止必须晚于生效时间");
    }
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      if (state.plans.has(cmd.plan_id)) throw new ConflictError(`处方 ${cmd.plan_id} 已存在`);
      if (state.status === "emergency_stopped") {
        throw new ConflictError("紧急停止未解除：须先完成新评估并由医生签署恢复，才能开具新处方");
      }
      const blockers = activeContraindications(state, timeOf(cmd.occurred_at));
      if (blockers.length > 0) throw new ConflictError(`存在未解除禁忌，不能开方：${blockers.map((c) => c.code).join("、")}`);
      return {
        event_id: cmd.event_id,
        event_type: "PLAN_APPROVED",
        occurred_at: cmd.occurred_at,
        summary: `医生开具处方 ${cmd.plan_id}（场地 ${cmd.venue_id}，${cmd.load.duration_min} 分钟/次，名额 ${cmd.load.remaining_slots}）`,
        payload: {
          participant_id: cmd.participant_id,
          plan_id: cmd.plan_id,
          venue_id: cmd.venue_id,
          load: cmd.load,
          valid_from: cmd.valid_from,
          valid_until: cmd.valid_until,
          signed_by: cmd.actor,
        },
      };
    });
  }

  /**
   * 场地交接（协调员）：单事件原子迁移。
   * 已完成课程保留在原场地的历史记录中；未执行名额与当前负荷快照迁到新场地。
   */
  async transferVenue(cmd) {
    this._allow("transferVenue", cmd.actor);
    requireFields(cmd, ["event_id", "participant_id", "occurred_at", "plan_id", "to_venue_id"], "场地交接");
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      const plan = state.plans.get(cmd.plan_id);
      if (!plan) throw new NotFoundError(`处方 ${cmd.plan_id} 不存在`);
      if (plan.status !== "active") throw new ConflictError(`处方状态为 ${plan.status}，不能迁移`);
      if (cmd.to_venue_id === plan.venue_id) throw new ConflictError("新场地与当前场地相同");
      if (state.venue_id && plan.venue_id !== state.venue_id) {
        throw new ConflictError(`处方场地 ${plan.venue_id} 与个人链当前场地 ${state.venue_id} 不一致`);
      }
      const completed = state.sessions
        .filter((s) => s.plan_id === cmd.plan_id)
        .map((s) => s.session_id);
      return {
        event_id: cmd.event_id,
        event_type: "VENUE_TRANSFERRED",
        occurred_at: cmd.occurred_at,
        summary: `场地交接：${plan.venue_id} → ${cmd.to_venue_id}，迁移剩余名额 ${plan.remaining_slots}，已完成 ${completed.length} 次课程保留`,
        payload: {
          participant_id: cmd.participant_id,
          plan_id: cmd.plan_id,
          from_venue_id: plan.venue_id,
          to_venue_id: cmd.to_venue_id,
          moved_slots: plan.remaining_slots,
          moved_load: plan.load,
          completed_session_ids: completed,
          transferred_by: cmd.actor,
        },
      };
    });
  }

  /**
   * 教练记录训练完成。会在课程时间点上判定处方是否可执行：
   * 场地不符 / 过期 / 无名额 / 暂停 / 紧急停止 / 严重观察未复核 / 禁忌未解除，一律拒绝。
   * 设备回执重复提交幂等：直接返回既有课程，不增加运动量。
   */
  async recordSession(cmd) {
    this._allow("recordSession", cmd.actor);
    requireFields(
      cmd,
      ["event_id", "participant_id", "occurred_at", "plan_id", "venue_id", "session_id"],
      "训练记录"
    );
    const slots = cmd.slots_used ?? 1;
    if (!Number.isInteger(slots) || slots <= 0) throw new ValidationError("扣减名额必须为正整数");

    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      // 设备回执优先去重：网络重试会带新的 event_id / session_id 包装，
      // 但同一 receipt 只能对应一次运动，必须先于 session_id 重复检查。
      if (cmd.device_receipt_id) {
        const dupReceipt = state.events.find(
          (e) => e.event_type === "SESSION_RECORDED" && e.payload.device_receipt_id === cmd.device_receipt_id
        );
        if (dupReceipt) {
          return { deduplicated_receipt: dupReceipt.event_id, _noop: true };
        }
      }
      const existingSession = state.sessions.find((s) => s.session_id === cmd.session_id);
      if (existingSession) throw new ConflictError(`课程 ${cmd.session_id} 已记录`);

      // 以课程发生时点的链投影判定：已在链中的迟到事实（如补录胸闷）同样阻断。
      const cutoff = timeOf(cmd.occurred_at);
      const stateThen = replay(state.events.filter((e) => timeOf(e.occurred_at) <= cutoff));
      const plan = stateThen.plans.get(cmd.plan_id);
      if (!plan) throw new NotFoundError(`处方 ${cmd.plan_id} 不存在或在课程时点尚未生效`);
      const verdict = evaluatePlan(stateThen, cmd.plan_id, cmd.occurred_at, cmd.venue_id);
      const gate = this._unresolvedGateAt(stateThen, cmd.occurred_at);
      if (gate) verdict.reasons.push(gate);
      verdict.valid = verdict.reasons.length === 0;
      if (!verdict.valid) {
        // 教练是训练记录的唯一角色：错误信息同样脱敏，不泄漏禁忌编码 / 症状。
        throw new ConflictError(`课程不允许执行：${verdict.reasons.map(sanitizeForCoach).join("；")}`);
      }
      if (plan.remaining_slots < slots) throw new ConflictError(`剩余名额 ${plan.remaining_slots} 不足 ${slots}`);

      return {
        event_id: cmd.event_id,
        event_type: "SESSION_RECORDED",
        occurred_at: cmd.occurred_at,
        summary: `记录课程 ${cmd.session_id} 完成（场地 ${cmd.venue_id}，扣减名额 ${slots}）`,
        payload: {
          participant_id: cmd.participant_id,
          session_id: cmd.session_id,
          plan_id: cmd.plan_id,
          venue_id: cmd.venue_id,
          slots_used: slots,
          completed_load: cmd.completed_load || plan.load,
          device_receipt_id: cmd.device_receipt_id || null,
          recorded_by: cmd.actor,
        },
      };
    }).then((result) => {
      // 重复回执路径：不追加事件，返回既有课程标识。
      if (result && result._noop) {
        return { deduplicated: true, existing_event_id: result.deduplicated_receipt };
      }
      return { deduplicated: false, event: result };
    });
  }

  /**
   * 严重异常观察安全闸门：课程时间点之前存在、且之后没有医生复核覆盖的
   * 严重观察，阻断训练（复核是医生签署动作；分层建议本身不改变状态）。
   */
  _unresolvedGateAt(state, atIso) {
    const atMs = timeOf(atIso);
    const severe = state.observations
      .filter((o) => o.severity === "severe" && timeOf(o.at) <= atMs)
      .sort((a, b) => timeOf(b.at) - timeOf(a.at))[0];
    if (!severe) return null;
    const reviewed = state.reviews.some((r) => timeOf(r.at) > timeOf(severe.at) && timeOf(r.at) <= atMs);
    if (reviewed) return null;
    const stoppedResolved = state.stops.some((s) => timeOf(s.at) > timeOf(severe.at) && timeOf(s.at) <= atMs) &&
      state.resumes.some((r) => timeOf(r.at) > timeOf(severe.at) && timeOf(r.at) <= atMs);
    if (stoppedResolved) return null;
    return `严重异常观察 ${severe.observation_id}（${severe.symptom}）尚未经医生复核，训练阻断`;
  }

  /** 异常观察登记（教练 / 协调员 / 护士）。迟到补录允许，按发生时间入链。 */
  async recordObservation(cmd) {
    this._allow("recordObservation", cmd.actor);
    requireFields(
      cmd,
      ["event_id", "participant_id", "occurred_at", "observation_id", "symptom", "severity"],
      "异常观察"
    );
    if (!["mild", "moderate", "severe"].includes(cmd.severity)) throw new ValidationError("严重程度非法");
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      if (state.observations.some((o) => o.observation_id === cmd.observation_id)) {
        throw new ConflictError(`观察 ${cmd.observation_id} 已登记`);
      }
      return {
        event_id: cmd.event_id,
        event_type: "ABNORMAL_OBSERVATION_RECORDED",
        occurred_at: cmd.occurred_at,
        summary: `登记异常观察：${cmd.symptom}（${cmd.severity}）${cmd.session_id ? `，课程 ${cmd.session_id}` : ""}`,
        payload: {
          participant_id: cmd.participant_id,
          observation_id: cmd.observation_id,
          session_id: cmd.session_id || null,
          symptom: cmd.symptom,
          severity: cmd.severity,
          detail: cmd.detail || "",
          observed_by: cmd.actor,
        },
      };
    });
  }

  /** 协调员发起紧急停止：立即阻断后续训练，当前处方作废，恢复须凭新评估。 */
  async emergencyStop(cmd) {
    this._allow("emergencyStop", cmd.actor);
    requireFields(cmd, ["event_id", "participant_id", "occurred_at", "reason"], "紧急停止");
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      if (state.status === "emergency_stopped") throw new ConflictError("个人链已处于紧急停止状态");
      return {
        event_id: cmd.event_id,
        event_type: "EMERGENCY_STOP_ISSUED",
        occurred_at: cmd.occurred_at,
        summary: `紧急停止：${cmd.reason}`,
        payload: {
          participant_id: cmd.participant_id,
          reason: cmd.reason,
          observation_id: cmd.observation_id || null,
          issued_by: cmd.actor,
        },
      };
    });
  }

  /** 医生签署暂停（非紧急的医学暂停）。 */
  async signPause(cmd) {
    this._allow("signPause", cmd.actor);
    requireFields(cmd, ["event_id", "participant_id", "occurred_at", "reason"], "暂停签署");
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      if (state.status === "emergency_stopped") throw new ConflictError("紧急停止状态下不能以普通暂停覆盖");
      if (state.status === "paused") throw new ConflictError("个人链已处于暂停状态");
      return {
        event_id: cmd.event_id,
        event_type: "PAUSE_SIGNED",
        occurred_at: cmd.occurred_at,
        summary: `医生签署暂停：${cmd.reason}`,
        payload: { participant_id: cmd.participant_id, reason: cmd.reason, signed_by: cmd.actor },
      };
    });
  }

  /** 医生完成复核评估（暂停 / 停止之后的“新评估”）。 */
  async completeReview(cmd) {
    this._allow("completeReview", cmd.actor);
    requireFields(cmd, ["event_id", "participant_id", "occurred_at", "review_id", "assessment_summary"], "复核");
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      if (state.reviews.some((r) => r.review_id === cmd.review_id)) {
        throw new ConflictError(`复核 ${cmd.review_id} 已存在`);
      }
      if (state.status === "active") {
        throw new ConflictError("个人链当前为可训练状态，没有待复核的暂停 / 停止");
      }
      return {
        event_id: cmd.event_id,
        event_type: "REVIEW_COMPLETED",
        occurred_at: cmd.occurred_at,
        summary: `医生完成复核 ${cmd.review_id}`,
        payload: {
          participant_id: cmd.participant_id,
          review_id: cmd.review_id,
          findings: cmd.findings || "",
          assessment_summary: cmd.assessment_summary,
          resolves_contraindications: cmd.resolves_contraindications || [],
          completed_by: cmd.actor,
        },
      };
    });
  }

  /** 医生签署恢复：必须引用暂停 / 停止之后完成的新评估。 */
  async signResumption(cmd) {
    this._allow("signResumption", cmd.actor);
    requireFields(cmd, ["event_id", "participant_id", "occurred_at", "review_id"], "恢复签署");
    return this._commit(cmd.participant_id, cmd.event_id, (state) => {
      if (state.status === "active") throw new ConflictError("个人链已处于可训练状态，无需恢复签署");
      assertResumptionReview(state, cmd.review_id);
      return {
        event_id: cmd.event_id,
        event_type: "RESUMPTION_SIGNED",
        occurred_at: cmd.occurred_at,
        summary: `医生引用新评估 ${cmd.review_id} 签署恢复${cmd.load_adjustment ? `，负荷调整：${cmd.load_adjustment}` : ""}`,
        payload: {
          participant_id: cmd.participant_id,
          review_id: cmd.review_id,
          load_adjustment: cmd.load_adjustment || null,
          signed_by: cmd.actor,
        },
      };
    });
  }

  /* ---------------- 查询 ---------------- */

  /** 处方在某时间、某场地是否可执行（教练开训前调用）。 */
  canExecute(participantId, planId, venueId, atIso = new Date().toISOString()) {
    const state = this._loadAsOf(participantId, atIso);
    const verdict = evaluatePlan(state, planId, atIso, venueId);
    const gate = this._unresolvedGateAt(state, atIso);
    if (gate) {
      verdict.valid = false;
      verdict.reasons.push(gate);
    }
    return verdict;
  }

  /** 教练视图：数据最小化，不含任何临床细节。 */
  coachView(participantId, atIso = new Date().toISOString()) {
    const state = this._loadAsOf(participantId, atIso);
    const gate = this._unresolvedGateAt(state, atIso);
    return coachView(state, atIso, gate ? [gate] : []);
  }

  /** 某次课程为何允许 / 为何（事后）应停止。 */
  explainSession(participantId, sessionId) {
    const { state } = this._load(participantId);
    const result = explainSession(state, sessionId);
    if (!result) throw new NotFoundError(`课程 ${sessionId} 不存在`);
    return result;
  }

  /** 谁在何时接手：场地交接与暂停 / 停止 / 恢复签署链。 */
  handoffTrail(participantId) {
    const { state } = this._load(participantId);
    const trail = [];
    for (const t of state.transfers) {
      trail.push({
        kind: "venue_transfer",
        at: t.at,
        by: t.by,
        from_venue_id: t.from_venue_id,
        to_venue_id: t.to_venue_id,
        moved_slots: t.moved_slots,
        retained_completed_sessions: t.completed_session_ids,
        event_id: t.event_id,
      });
    }
    for (const s of state.stops) {
      trail.push({ kind: "emergency_stop", at: s.at, by: s.by, reason: s.reason, event_id: s.event_id });
    }
    for (const p of state.pauses) {
      trail.push({ kind: "pause", at: p.at, by: p.by, reason: p.reason, event_id: p.event_id });
    }
    for (const r of state.resumes) {
      trail.push({ kind: "resumption", at: r.at, by: r.by, review_id: r.review_id, event_id: r.event_id });
    }
    return trail.sort((a, b) => timeOf(a.at) - timeOf(b.at));
  }

  /** 单人待复核 / 待签署事项（重启后由事件链重新派生）。 */
  pendingReviews(participantId, nowIso = new Date().toISOString()) {
    const { state } = this._load(participantId);
    return pendingReviews(state, nowIso);
  }

  /** 协调员视图：服务重启后仍待完成的全部复核与签署。 */
  pendingAll(nowIso = new Date().toISOString()) {
    const ids = new Set(this.store.list().map((e) => e.payload && e.payload.participant_id).filter(Boolean));
    return [...ids].map((participantId) => ({
      participant_id: participantId,
      pending: this.pendingReviews(participantId, nowIso),
    })).filter((x) => x.pending.length > 0);
  }

  /** 迟到事件回看：它之后的处方与训练是否受影响（不改写历史）。 */
  lateEventImpact(participantId, eventId) {
    const { state } = this._load(participantId);
    const result = lateEventImpact(state, eventId);
    if (!result) throw new NotFoundError(`事件 ${eventId} 不在 ${participantId} 的个人链中`);
    return result;
  }

  /**
   * 个人链时间线。临床角色可见完整内容；教练只看到脱敏版本
   * （筛查事实、禁忌细节、评估原文一律不返回）。
   */
  timeline(participantId, viewer) {
    if (!viewer || !viewer.role) throw new ValidationError("查询需要提供 viewer");
    const { events } = this._load(participantId);
    if (viewer.role === COACH) {
      return events
        .filter((e) =>
          ["PLAN_APPROVED", "VENUE_TRANSFERRED", "SESSION_RECORDED", "EMERGENCY_STOP_ISSUED", "PAUSE_SIGNED", "RESUMPTION_SIGNED"].includes(
            e.event_type
          )
        )
        .map((e) => ({
          event_id: e.event_id,
          event_type: e.event_type,
          occurred_at: e.occurred_at,
          version: e.version,
          // 停止 / 暂停原因属于临床信息，对教练只给执行性结论。
          summary:
            e.event_type === "EMERGENCY_STOP_ISSUED"
              ? "训练已紧急停止，等待医生新评估与恢复签署"
              : e.event_type === "PAUSE_SIGNED"
                ? "医生已暂停训练，等待复核与恢复签署"
                : e.summary,
        }));
    }
    return events;
  }
}
