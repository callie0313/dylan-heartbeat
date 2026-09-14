const SESSION_ID = "SHANE-ONBOARDING-2026-09-08";
const DAY_1 = "2026-09-08";
const DAY_2 = "2026-09-09";

// This is intentionally Shane-specific background, not a reusable employee-training system.
const STEPS = [
  { id: "ONBOARDING_DAY1_REPORT", date: DAY_1, minute: 11 * 60, current: "已入职，准备开始熟悉公司。", next: "与 Erin 和 George 会面", wake: true, activity: "onboarding_report", location: "MAINTENANCE_ROOM", with: [] },
  { id: "MEET_ERIN_AND_GEORGE", date: DAY_1, minute: 11 * 60 + 30, current: "Erin 已确认岗位；George 是主要带教人员，正在介绍维修部门。", next: "午休", activity: "onboarding_meeting", location: "MAINTENANCE_ROOM", with: ["erin_walker", "george_nelson"] },
  { id: "LUNCH_DAY1", date: DAY_1, minute: 12 * 60, current: "Day 1 午休。", next: "工厂与维修区域熟悉", activity: "eating", location: "CAFETERIA", with: [] },
  { id: "FACTORY_ORIENTATION", date: DAY_1, minute: 13 * 60 + 30, current: "正在熟悉工厂区域、维修区域和基础安全规则。", next: "基础工作培训", activity: "factory_orientation", location: "FACTORY_FLOOR", with: ["george_nelson"] },
  { id: "BASIC_WORK_TRAINING", date: DAY_1, minute: 15 * 60, current: "正在学习工具规范、维修记录与工作流程。", next: "Day 1 回顾", activity: "training", location: "MAINTENANCE_ROOM", with: ["george_nelson"] },
  { id: "DAY1_REVIEW", date: DAY_1, minute: 16 * 60 + 30, current: "正在完成 Day 1 回顾。", next: "结束 Day 1", activity: "onboarding_review", location: "MAINTENANCE_ROOM", with: ["george_nelson"] },
  { id: "DAY1_COMPLETED", date: DAY_1, minute: 17 * 60, current: "Day 1 已完成，正在整理工具并等待正常下班。", next: "Day 2 开始", activity: "organizing_tools", location: "MAINTENANCE_ROOM", with: [] },
  { id: "DAY2_START", date: DAY_2, minute: 8 * 60 + 30, current: "Day 2 开始，准备继续在 George 指导下熟悉日常工作。", next: "跟随 George 巡检", activity: "training", location: "MAINTENANCE_ROOM", with: ["george_nelson"] },
  { id: "SHADOW_GEORGE", date: DAY_2, minute: 9 * 60, current: "正在跟随 George 学习设备巡检与日常维修。", next: "午休", activity: "training", location: "FACTORY_FLOOR", with: ["george_nelson"] },
  { id: "LUNCH_DAY2", date: DAY_2, minute: 12 * 60, current: "Day 2 午休。", next: "第一次简单实践", activity: "eating", location: "CAFETERIA", with: [] },
  { id: "FIRST_PRACTICAL_TASK", date: DAY_2, minute: 13 * 60 + 30, current: "正在在 George 指导下完成第一次简单实践。", next: "入职回顾", activity: "training", location: "MAINTENANCE_ROOM", with: ["george_nelson"] },
  { id: "ONBOARDING_REVIEW", date: DAY_2, minute: 15 * 60 + 30, current: "正在完成入职回顾。", next: "结束入职阶段", activity: "onboarding_review", location: "MAINTENANCE_ROOM", with: ["george_nelson"] },
  { id: "ONBOARDING_COMPLETED", date: DAY_2, minute: 17 * 60, current: "入职阶段已完成，下一工作日进入正式维修岗位。", next: null, activity: "off_duty", location: "OFF_SITE", with: [], completes: true }
];

function isSessionDate(dateKey) { return dateKey === DAY_1 || dateKey === DAY_2; }
function dayForDate(dateKey) { return dateKey === DAY_1 ? 1 : dateKey === DAY_2 ? 2 : null; }

function initialSession(now) {
  return {
    session_id: SESSION_ID,
    status: "ACTIVE",
    active: true,
    started_at: now,
    completed_at: null,
    archived_at: null,
    history: [],
    context: {
      day: 1,
      phase: "DAY_1",
      current_step_id: null,
      current: "已入职，准备开始熟悉公司。",
      recent: null,
      next: "ONBOARDING_DAY1_REPORT",
      updated_at: now
    }
  };
}

function nextStep(history) { return STEPS.find(step => !history.some(item => item.step_id === step.id)) || null; }

function advanceSession(previous, { dateKey, minutes, now, isOnLeave }) {
  let session = previous ? JSON.parse(JSON.stringify(previous)) : null;
  if (!session && dateKey === DAY_1 && !isOnLeave) session = initialSession(now);
  if (!session || !session.active || isOnLeave) return { session, changed: false, activity: null, reportReached: false };

  let changed = false;
  let reportReached = false;
  let step = nextStep(session.history || []);
  // A delayed tick may catch up on several scheduled milestones, each with its true order preserved.
  while (step && (dateKey > step.date || (dateKey === step.date && minutes >= step.minute))) {
    session.history.push({ step_id: step.id, occurred_at: now });
    session.context = {
      day: dayForDate(step.date),
      phase: step.date === DAY_1 ? "DAY_1" : "DAY_2",
      current_step_id: step.id,
      current: step.current,
      recent: step.id,
      next: (STEPS[STEPS.indexOf(step) + 1] || {}).id || null,
      updated_at: now
    };
    if (step.wake) reportReached = true;
    if (step.completes) {
      session.status = "COMPLETED";
      session.active = false;
      session.completed_at = now;
      session.archived_at = now;
    }
    changed = true;
    step = nextStep(session.history);
  }

  const latestId = session.context?.current_step_id;
  const latest = STEPS.find(item => item.id === latestId);
  const activity = session.active && latest ? {
    activity: latest.activity,
    location: latest.location,
    with: latest.with,
    current_equipment_id: null,
    activity_ends_at: null,
    work_rhythm: "normal"
  } : null;
  return { session, changed, activity, reportReached };
}

function applyScheduleOverride(schedule, session, dateKey, minutes, isOnLeave) {
  if (!session?.active || isOnLeave || !isSessionDate(dateKey)) return schedule;
  // The personal schedule resumes after its shorter 12:00–13:30 lunch, without altering the global default.
  if (minutes >= 13 * 60 + 30 && minutes < 17 * 60) return { ...schedule, workState: "ON_DUTY" };
  return schedule;
}

module.exports = { SESSION_ID, advanceSession, applyScheduleOverride };
