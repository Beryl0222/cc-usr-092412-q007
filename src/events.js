/** 超慢跑风险接力的领域事件类型、聚合类型与构造辅助。 */

export const EVENT_TYPES = Object.freeze({
  SCREENING_RECORDED: "SCREENING_RECORDED",
  PRESCRIPTION_ISSUED: "PRESCRIPTION_ISSUED",
  PRESCRIPTION_TRANSFERRED: "PRESCRIPTION_TRANSFERRED",
  SESSION_SCHEDULED: "SESSION_SCHEDULED",
  SESSION_COMPLETED: "SESSION_COMPLETED",
  SESSION_REJECTED: "SESSION_REJECTED",
  OBSERVATION_RECORDED: "OBSERVATION_RECORDED",
  RISK_SUGGESTION_GENERATED: "RISK_SUGGESTION_GENERATED",
  RISK_ESCALATED: "RISK_ESCALATED",
  ACTIVITY_PAUSED: "ACTIVITY_PAUSED",
  ACTIVITY_RESUMED: "ACTIVITY_RESUMED",
  EMERGENCY_STOPPED: "EMERGENCY_STOPPED",
  RETRO_REVIEW_OPENED: "RETRO_REVIEW_OPENED",
  RETRO_REVIEW_RESOLVED: "RETRO_REVIEW_RESOLVED",
  VENUE_HANDOFF_COMPLETED: "VENUE_HANDOFF_COMPLETED",
});

export const AGGREGATES = Object.freeze({
  PARTICIPANT_CHAIN: "participant_chain",
  PRESCRIPTION: "prescription",
  TRAINING_SESSION: "training_session",
  REVIEW_TASK: "review_task",
  VENUE_HANDOFF: "venue_handoff",
});

/** 严重到需要自动分层给出暂停建议的异常观察级别。 */
export const SEVERE_OBSERVATIONS = new Set(["severe", "chest_pain"]);

let sequence = 0;

/**
 * 构造一条领域事件。event_id 缺省时自动生成；version 由事件存储在追加时
 * 按聚合统一赋值，调用方不应自行编造。
 */
export function makeEvent({ event_type, aggregate_type, aggregate_id, occurred_at, actor, participant_id, summary, data = {}, event_id }) {
  sequence += 1;
  return {
    event_id: event_id ?? `evt-${Date.now().toString(36)}-${sequence}`,
    event_type,
    aggregate_type,
    aggregate_id,
    occurred_at,
    version: 1,
    summary,
    actor: actor ?? { id: "system", role: "system" },
    participant_id,
    data,
  };
}
