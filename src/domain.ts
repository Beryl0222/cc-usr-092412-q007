/** 超慢跑风险接力使用的领域事件信封与事件类型。 */

/** 可签署升级 / 暂停 / 恢复的角色。 */
export type Role =
  | "screening_nurse" // 初筛护士：可登记筛查与禁忌
  | "physician" // 医生：签署分层升级、暂停、恢复
  | "coordinator" // 医疗协调员：登记观察、发起紧急停止、执行场地交接
  | "coach"; // 教练：只能执行有效处方、登记训练完成与异常观察

/** 风险分层：自动分层只产出建议，升级需医生签署。 */
export type RiskTier = "low" | "moderate" | "high";

/** 个人链活动状态。 */
export type ChainStatus = "active" | "paused" | "emergency_stopped";

/** 建议来源：自动规则引擎或人工。 */
export type AdviceSource = "auto" | "manual";

/** 签署人信息。 */
export interface SignedBy {
  staff_id: string;
  name: string;
  role: Role;
}

/** 负荷处方内容。 */
export interface Load {
  /** 配速区间，秒 / 公里，[下限, 上限]。 */
  pace_sec_per_km_min: number;
  pace_sec_per_km_max: number;
  /** 单次时长（分钟）。 */
  duration_min: number;
  /** 心率上限（次 / 分）。 */
  max_heart_rate?: number;
  /** 剩余可执行课次名额。 */
  remaining_slots: number;
}

/** 带发生时间与记录来源的事实点（筛查指标、症状等）。 */
export interface Fact {
  key: string;
  value: number | string | boolean;
  /** 记录时间；迟到事件按发生时间插入个人链。 */
  recorded_at?: string;
}

/** 异常观察的严重程度。 */
export type Severity = "mild" | "moderate" | "severe";

export type EventType =
  | "SCREENING_RECORDED"
  | "CONTRAINDICATION_NOTED"
  | "RISK_TIER_SIGNED"
  | "PLAN_APPROVED"
  | "VENUE_TRANSFERRED"
  | "SESSION_RECORDED"
  | "ABNORMAL_OBSERVATION_RECORDED"
  | "EMERGENCY_STOP_ISSUED"
  | "PAUSE_SIGNED"
  | "REVIEW_COMPLETED"
  | "RESUMPTION_SIGNED"
  | "RISK_FLAGGED"
  | "ACTIVITY_PAUSED";

export type AggregateType =
  | "participant_chain"
  | "participant_plan"
  | "activity_session"
  | "risk_observation"
  | "clinical_handoff";

export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  /** 始终为参与者个人链标识 participant:{id}。 */
  aggregate_id: string;
  /** 事实发生时间（不是系统接收时间）；个人链按此排序。 */
  occurred_at: string;
  /** 该参与者个人链内单调递增的事件版本。 */
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
}

/** 处方有效性判定结果。 */
export interface PlanValidity {
  plan_id: string;
  valid: boolean;
  reasons: string[];
  venue_id: string;
  load: Load;
  remaining_slots: number;
  valid_from: string;
  valid_until: string;
}

/** 教练视角的最小必要信息（不含筛查结论与禁忌临床细节）。 */
export interface CoachView {
  participant_id: string;
  venue_id: string;
  status: ChainStatus;
  plan: PlanValidity | null;
  /** 近期需要教练知晓的非临床提示，如“恢复训练，负荷减半”。 */
  notices: string[];
}

/** 迟到事件影响评估。 */
export interface LateImpact {
  event_id: string;
  /** 该事件发生时间之后、被回看受影响的处方与训练。 */
  affected_plans: string[];
  affected_sessions: string[];
  /** 是否仍需补做复核（紧急停止后的新评估恢复等）。 */
  pending_reviews: string[];
}
