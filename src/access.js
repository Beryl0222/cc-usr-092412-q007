/** 角色与最小可见性：教练只能看到执行课程所必需的字段。 */

export const ROLES = Object.freeze({
  COORDINATOR: "coordinator",
  PHYSICIAN: "physician",
  COACH: "coach",
  SYSTEM: "system",
});

/** 任何在场工作人员都可触发紧急停止。 */
export const STAFF_ROLES = [ROLES.COORDINATOR, ROLES.PHYSICIAN, ROLES.COACH];

/** 各敏感操作所需资质：签署类操作只能由医生完成。 */
export const COMMAND_ROLES = Object.freeze({
  recordScreening: [ROLES.PHYSICIAN],
  issuePrescription: [ROLES.PHYSICIAN],
  scheduleSession: [ROLES.COORDINATOR, ROLES.COACH],
  completeSession: [ROLES.COACH],
  recordObservation: [ROLES.COACH, ROLES.PHYSICIAN],
  signEscalation: [ROLES.PHYSICIAN],
  signPause: [ROLES.PHYSICIAN],
  signResume: [ROLES.PHYSICIAN],
  emergencyStop: STAFF_ROLES,
  venueHandoff: [ROLES.COORDINATOR],
  resolveReview: [ROLES.COORDINATOR, ROLES.PHYSICIAN],
});

export function checkRole(actor, command) {
  const allowed = COMMAND_ROLES[command];
  if (!allowed) return `未知操作：${command}`;
  if (!actor || !allowed.includes(actor.role)) {
    return `操作 ${command} 需要资质：${allowed.join("/")}`;
  }
  return null;
}

/**
 * 教练视图：负荷、场地、期限、课程状态与阻断标记，
 * 不含筛查结论、禁忌明细、异常观察等临床细节。
 */
export function coachViewOf(participant) {
  return {
    participant_id: participant.participant_id,
    stopped: Boolean(participant.stop && !participant.stop.resumed_at),
    paused: participant.paused,
    prescriptions: [...participant.prescriptions.values()].map((rx) => ({
      prescription_id: rx.prescription_id,
      venue_id: rx.venue_id,
      valid_from: rx.valid_from,
      valid_to: rx.valid_to,
      load: rx.load,
      status: rx.status,
    })),
    sessions: [...participant.sessions.values()].map((session) => ({
      session_id: session.session_id,
      prescription_id: session.prescription_id,
      venue_id: session.venue_id,
      scheduled_at: session.scheduled_at,
      status: session.status,
      volume: session.volume ?? 0,
    })),
  };
}
