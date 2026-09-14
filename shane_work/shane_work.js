const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const { getDatePartsInTimeZone, resolveTimeZone } = require("../time_utils");
const { COMPANY, EQUIPMENT, FACILITIES: WORLD_FACILITIES } = require("./world");
const { advanceSession, applyScheduleOverride } = require("./onboarding_session");
const { loadTasks, saveTasks } = require("./tasks");
const { loadWorkHours, saveWorkHours } = require("./work_hours");
const { loadLeaves, isOnApprovedLeave } = require("./leaves");
const { loadKnowledge, saveKnowledge, learnFact, learnOnboardingFact, learnLocationFact, learnCoreFacilityFact, learnMealBenefitFact, learnPersonalFacilityFact } = require("./knowledge");
const { loadWakeRequests, saveWakeRequests, queueWorkWake, queueOnboardingWake } = require("./wake_requests");
const { ticksDailyLife } = require("./daily_life");
const { loadRoutineWork, saveRoutineWork, addRoutineRecord } = require("./routine_work");

const TIME_ZONE = resolveTimeZone();
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");
const EVENTS_PATH = path.join(WORK_DIR, "events.json");
const LOG_PATH = path.join(WORK_DIR, "state_changes.jsonl");

function formatIsoInTimeZone(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  const wallTimeAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMinutes = Math.round((wallTimeAsUtc - date.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
}

function getCalendarInfo(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  const weekday = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
  return { parts, weekday, isWorkday: weekday >= 1 && weekday <= 5 };
}

function getScheduleState(date = new Date(), isOnLeave = false) {
  const { parts, isWorkday } = getCalendarInfo(date);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (!isWorkday) return { isWorkday, workState: "OFF_DUTY", isOnLeave: false };
  if (isOnLeave) return { isWorkday, workState: "LEAVE", isOnLeave: true };
  if (minutes >= 495 && minutes < 500) return { isWorkday, workState: "PRE_WORK" };
  if (minutes >= 500 && minutes < 510) return { isWorkday, workState: "COMMUTING_TO_WORK" };
  if (minutes >= 510 && minutes < 720) return { isWorkday, workState: "ON_DUTY" };
  if (minutes >= 720 && minutes < 870) return { isWorkday, workState: "LUNCH" };
  if (minutes >= 870 && minutes < 1050) return { isWorkday, workState: "ON_DUTY" };
  return { isWorkday, workState: "OFF_DUTY" };
}

function shouldStartWorkDay(previous, schedule, now) {
  if (!schedule.isWorkday || schedule.isOnLeave || getLocalMinutes(now) < 510) return false;
  return previous?.work_day_started_date !== getDateKey(now);
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return value && typeof value === "object" ? value : fallback;
  } catch (error) {
    console.error(`Shane Work 读取 ${path.basename(filePath)} 失败:`, error.message);
    return fallback;
  }
}

function loadState() { return loadJson(STATE_PATH, null); }
function loadEvents() {
  const events = loadJson(EVENTS_PATH, []);
  return Array.isArray(events) ? events : [];
}

function initializeEquipment(previous = []) {
  const oldById = new Map((Array.isArray(previous) ? previous : []).map(item => [item.id, item]));
  return EQUIPMENT.map(definition => {
    const old = oldById.get(definition.id) || {};
    return {
      ...definition,
      status: old.status || "NORMAL",
      familiarity: Math.max(0, Math.min(100, Number(old.familiarity) || 0)),
      pending_issue: typeof old.pending_issue === "string" ? old.pending_issue : null
    };
  });
}

function countWorkdaysThrough(startedAt, now, leaves = []) {
  const start = getCalendarInfo(new Date(startedAt)).parts;
  const end = getCalendarInfo(now).parts;
  let cursor = new Date(Date.UTC(Number(start.year), Number(start.month) - 1, Number(start.day)));
  const last = Date.UTC(Number(end.year), Number(end.month) - 1, Number(end.day));
  let count = 0;
  while (cursor.getTime() <= last) {
    if (cursor.getUTCDay() >= 1 && cursor.getUTCDay() <= 5 && !isOnApprovedLeave(leaves, cursor.toISOString().slice(0, 10))) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function getOnboardingPhase(day) {
  if (day <= 0) return "NOT_STARTED";
  if (day === 1) return "DAY_1";
  if (day === 2) return "GUIDED";
  return "NORMAL";
}

function addMinutes(date, minutes) { return new Date(date.getTime() + minutes * 60_000); }
function getEquipmentById(equipment, id) { return equipment.find(item => item.id === id) || null; }
function hashText(value) {
  let hash = 0;
  for (const char of String(value)) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return hash;
}

function increaseFamiliarity(equipment, id, amount) {
  return equipment.map(item => item.id === id ? { ...item, familiarity: Math.min(100, item.familiarity + amount) } : item);
}

function chooseOnDutyActivity(state, onboardingDay, now = new Date()) {
  const index = Number(state.activity_index) || 0;
  const target = getEquipmentById(state.equipment, EQUIPMENT[index % EQUIPMENT.length].id);
  if (onboardingDay === 1) {
    return { activity: "training", location: target.zone, with: ["george_nelson"], equipment_id: target.id, duration_minutes: 90, familiarity_gain: 5, rhythm: "normal" };
  }
  if (onboardingDay === 2) {
    const plan = ["training", "inspection", "reading_manual", "maintenance"];
    const activity = plan[index % plan.length];
    return { activity, location: target.zone, with: ["george_nelson"], equipment_id: target.id, duration_minutes: activity === "training" ? 75 : 60, familiarity_gain: activity === "maintenance" ? 4 : 3, rhythm: activity === "reading_manual" ? "quiet" : "normal" };
  }
  const plan = [
    { activity: "waiting", location: "MAINTENANCE_ROOM", rhythm: "quiet" },
    { activity: "inspection", familiarity_gain: 2, rhythm: "normal" },
    { activity: "waiting", location: "MAINTENANCE_ROOM", rhythm: "quiet" },
    { activity: "organizing_tools", location: "MAINTENANCE_ROOM", rhythm: "quiet" },
    { activity: "reading_manual", familiarity_gain: 1, rhythm: "quiet" },
    { activity: "wandering", rhythm: "quiet" },
    { activity: "slacking", location: "MAINTENANCE_ROOM", rhythm: "quiet" },
    { activity: "chatting", location: "MAINTENANCE_ROOM", with: ["miguel_santos"], rhythm: "normal" }
  ][index % 8];
  const durationMinutes = 30 + (hashText(`${getDateKey(now)}|activity|${index}|${plan.activity}`) % 91);
  return { ...plan, duration_minutes: durationMinutes, with: plan.with || [], equipment_id: target.id, location: plan.location || target.zone };
}

const ROUTINE_ACTIVITY_KINDS = {
  inspection: "ROUTINE_INSPECTION",
  organizing_tools: "ROUTINE_TOOLS_AND_PARTS",
  reading_manual: "ROUTINE_EQUIPMENT_LEARNING"
};

function createRoutineActivity(activityState, currentTime) {
  const kind = ROUTINE_ACTIVITY_KINDS[activityState.activity];
  if (!kind || !activityState.activity_ends_at) return null;
  const equipmentId = activityState.activity === "organizing_tools" ? null : activityState.current_equipment_id || null;
  return {
    id: `ROUTINE-${currentTime.replace(/[-:T+.]/g, "")}-${activityState.activity.toUpperCase()}`,
    kind,
    activity_type: activityState.activity,
    equipment_id: equipmentId,
    with: [...(activityState.with || [])],
    started_at: currentTime,
    activity_ends_at: activityState.activity_ends_at,
    result: "NORMAL"
  };
}

function routineWorkSegment(date) {
  const { parts } = getCalendarInfo(date);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  if (minutes >= 510 && minutes < 720) return `${dateKey}:MORNING`;
  if (minutes >= 870 && minutes < 1050) return `${dateKey}:AFTERNOON`;
  return null;
}

function isRoutineWindowInsideSingleWorkSegment(routine, now) {
  const startedAt = new Date(routine.started_at);
  const endsAt = new Date(routine.activity_ends_at);
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt < startedAt) return false;
  const startSegment = routineWorkSegment(startedAt);
  const endSegment = routineWorkSegment(endsAt);
  return startSegment && startSegment === endSegment && getDateKey(now) === getDateKey(startedAt);
}

function completeRoutineActivity(routine, now, schedule, immediateEvent, activeTask, store) {
  if (!routine) return { routine: null, changed: false };
  const ended = routine.activity_ends_at && new Date(routine.activity_ends_at) <= now;
  if (!ended) {
    if (schedule.workState !== "ON_DUTY" || immediateEvent || activeTask) return { routine: null, changed: false };
    return { routine, changed: false };
  }
  if (schedule.workState !== "ON_DUTY" || immediateEvent || activeTask || !isRoutineWindowInsideSingleWorkSegment(routine, now)) return { routine: null, changed: false };
  const record = {
    id: routine.id,
    kind: routine.kind,
    activity_type: routine.activity_type,
    equipment_id: routine.equipment_id,
    with: routine.with,
    started_at: routine.started_at,
    completed_at: routine.activity_ends_at,
    result: routine.result
  };
  return { routine: null, changed: addRoutineRecord(store, record) };
}

function addKnownPeople(state, ids) {
  for (const id of ids) if (!state.known_npc_ids.includes(id)) state.known_npc_ids.push(id);
}

const ONBOARDING_LOCATION_BY_STEP = {
  ONBOARDING_DAY1_REPORT: "MAINTENANCE_ROOM",
  MEET_ERIN_AND_GEORGE: "MAINTENANCE_ROOM",
  LUNCH_DAY1: "CAFETERIA",
  FACTORY_ORIENTATION: "FACTORY_FLOOR",
  BASIC_WORK_TRAINING: "MAINTENANCE_ROOM",
  DAY1_REVIEW: "MAINTENANCE_ROOM",
  DAY1_COMPLETED: "OFF_SITE",
  DAY2_START: "MAINTENANCE_ROOM",
  SHADOW_GEORGE: "FACTORY_FLOOR",
  LUNCH_DAY2: "CAFETERIA",
  FIRST_PRACTICAL_TASK: "MAINTENANCE_ROOM",
  ONBOARDING_REVIEW: "MAINTENANCE_ROOM",
  ONBOARDING_COMPLETED: "OFF_SITE"
};

const FACILITIES = {
  CAFETERIA: WORLD_FACILITIES.CAFETERIA,
  BREAK_ROOM: {
    id: "BREAK_ROOM",
    name: "维修部员工休息区",
    near: "MAINTENANCE_ROOM",
    fixtures: ["桌椅", "饮水机", "小冰箱", "微波炉", "插座", "午休床", "个人储物柜"]
  }
};

function recoverKnownLocations(previous) {
  if (Array.isArray(previous?.known_location_ids)) return [...new Set(previous.known_location_ids)];
  const recovered = [];
  for (const step of previous?.onboarding_session?.history || []) {
    const location = ONBOARDING_LOCATION_BY_STEP[step.step_id];
    if (location && !recovered.includes(location)) recovered.push(location);
  }
  if (previous?.location && !recovered.includes(previous.location)) recovered.push(previous.location);
  return recovered;
}

function ensureCoreFacilityLocations(state, session) {
  if (session?.status !== "COMPLETED") return false;
  const coreLocations = ["FACTORY_FLOOR", "MAINTENANCE_ROOM", "WAREHOUSE", "SAFETY_EXIT"];
  let changed = false;
  for (const locationId of coreLocations) {
    if (!state.known_location_ids.includes(locationId)) {
      state.known_location_ids.push(locationId);
      changed = true;
    }
  }
  return changed;
}

function discoverBreakRoom(state, schedule, onboardingDay) {
  if (schedule.workState !== "LUNCH" || onboardingDay < 3 || state.known_location_ids.includes(FACILITIES.BREAK_ROOM.id)) return false;
  state.known_location_ids.push(FACILITIES.BREAK_ROOM.id);
  state.personal_facilities = { rest_bed_id: "SHANE_BED_04", locker_id: "SHANE_LOCKER_04" };
  return true;
}

function ensureBreakRoomPersonalFacilities(state) {
  if (!state.known_location_ids.includes(FACILITIES.BREAK_ROOM.id)) return false;
  const expected = { rest_bed_id: "SHANE_BED_04", locker_id: "SHANE_LOCKER_04" };
  if (state.personal_facilities?.rest_bed_id === expected.rest_bed_id && state.personal_facilities?.locker_id === expected.locker_id) return false;
  state.personal_facilities = expected;
  return true;
}

function chooseEventAssistance(equipment, severity) {
  const people = [];
  if (equipment.familiarity < 10) people.push("george_nelson");
  if ((equipment.id.startsWith("A") || equipment.id === "C01" || equipment.id === "C03") && equipment.familiarity >= 10) people.push("miguel_santos");
  if (severity === "SERIOUS") people.push("erin_walker");
  return people;
}

function getNextEventNumber(state, events) {
  const existing = events.reduce((max, event) => Math.max(max, Number(String(event.event_id || "").replace(/\D/g, "")) || 0), 0);
  return Math.max(Number(state.event_counter) || 0, existing) + 1;
}

function createEvent(state, events, now) {
  const dateKey = formatIsoInTimeZone(now).slice(0, 10);
  const hash = hashText(dateKey);
  const template = [
    ["SENSOR_CHECK", "传感器需要清洁/调整"],
    ["CONVEYOR_ALIGNMENT", "输送带轻微跑偏"],
    ["LIGHT_JAM", "轻微卡料需要清理"],
    ["PUMP_OR_PNEUMATIC_CHECK", "泵或气动部件需要检查"],
    ["OPERATOR_REPORT", "操作员报告设备疑似异常，需现场确认"]
  ][hash % 5];
  const openEquipmentIds = new Set(getOpenEvents(events).map(event => event.equipment_id));
  const candidates = state.equipment.filter(item => !openEquipmentIds.has(item.id));
  if (candidates.length === 0) return null;
  const equipment = candidates[hash % candidates.length];
  const severity = hash % 997 === 0 ? "SERIOUS" : hash % 5 === 0 ? "NORMAL" : "MINOR";
  const requiresParts = severity === "SERIOUS" || (severity === "NORMAL" && hash % 4 === 0);
  const eventNumber = getNextEventNumber(state, events);
  const event = {
    event_id: `EVT-${String(eventNumber).padStart(6, "0")}`,
    created_date: dateKey,
    created_at: formatIsoInTimeZone(now),
    updated_at: formatIsoInTimeZone(now),
    equipment_id: equipment.id,
    category: template[0],
    summary: template[1],
    severity,
    importance: severity === "SERIOUS" ? "HIGH" : severity === "NORMAL" ? "MEDIUM" : "LOW",
    status: "DETECTED",
    assigned_with: chooseEventAssistance(equipment, severity),
    requires_parts: requiresParts,
    parts_available_at: null,
    step_due_at: formatIsoInTimeZone(addMinutes(now, 20))
  };
  state.event_counter = eventNumber;
  state.equipment = state.equipment.map(item => item.id === equipment.id ? {
    ...item,
    status: severity === "SERIOUS" ? "SERIOUS_ISSUE" : severity === "NORMAL" ? "FAULT" : "ATTENTION",
    pending_issue: event.event_id
  } : item);
  addKnownPeople(state, event.assigned_with);
  return event;
}

function transitionEvent(event, status, now, patch = {}) {
  return { ...event, ...patch, status, updated_at: formatIsoInTimeZone(now) };
}

function advanceEvent(event, state, now) {
  const equipment = getEquipmentById(state.equipment, event.equipment_id);
  const unfamiliar = equipment.familiarity < 10;
  const duration = base => base + (unfamiliar ? 25 : 0);
  if (event.status === "WAITING_PARTS") {
    if (!event.parts_available_at || new Date(event.parts_available_at) > now) return { event, log: null };
    const next = transitionEvent(event, "REPAIRING", now, { step_due_at: formatIsoInTimeZone(addMinutes(now, duration(55))) });
    return { event: next, log: { at: next.updated_at, type: `EVENT_${next.status}`, event_id: next.event_id, equipment_id: next.equipment_id, severity: next.severity } };
  }
  if (event.status === "TEMP_FIXED") {
    const next = transitionEvent(event, "RECHECK", now, { step_due_at: formatIsoInTimeZone(addMinutes(now, 20)), safe_hold: false });
    return { event: next, log: { at: next.updated_at, type: "EVENT_" + next.status, event_id: next.event_id, equipment_id: next.equipment_id, severity: next.severity } };
  }
  if (!event.step_due_at || new Date(event.step_due_at) > now) return { event, log: null };
  let next;
  if (event.status === "DETECTED") {
    next = transitionEvent(event, "CHECKING", now, { step_due_at: formatIsoInTimeZone(addMinutes(now, duration(35))) });
  } else if (event.status === "CHECKING") {
    if (event.requires_parts) {
      next = transitionEvent(event, "WAITING_PARTS", now, {
        parts_available_at: formatIsoInTimeZone(addMinutes(now, 24 * 60)),
        step_due_at: null
      });
    } else {
      next = transitionEvent(event, "REPAIRING", now, { step_due_at: formatIsoInTimeZone(addMinutes(now, duration(45))) });
    }
  } else if (event.status === "REPAIRING") {
    next = transitionEvent(event, "RECHECK", now, { step_due_at: formatIsoInTimeZone(addMinutes(now, 20)) });
  } else if (event.status === "RECHECK") {
    next = transitionEvent(event, "RESOLVED", now, { step_due_at: null });
    state.equipment = state.equipment.map(item => item.id === event.equipment_id ? { ...item, status: "NORMAL", pending_issue: null, familiarity: Math.min(100, item.familiarity + 2) } : item);
  } else {
    return { event, log: null };
  }
  return { event: next, log: { at: next.updated_at, type: `EVENT_${next.status}`, event_id: next.event_id, equipment_id: next.equipment_id, severity: next.severity } };
}

function getOpenEvents(events) { return events.filter(event => event.status !== "RESOLVED"); }
function getActiveEvent(events) {
  const openEvents = getOpenEvents(events);
  return openEvents.find(event => event.status !== "WAITING_PARTS") || openEvents[0] || null;
}

function getDateKey(date = new Date()) {
  const parts = getCalendarInfo(date).parts;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addWorkdays(date, count) {
  const parts = getCalendarInfo(date).parts;
  const cursor = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  let added = 0;
  while (added < count) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getUTCDay() >= 1 && cursor.getUTCDay() <= 5) added++;
  }
  return cursor.toISOString().slice(0, 10);
}

function getEventInterval(startedAt, sequence) {
  return 4 + (hashText(`${startedAt}|${sequence}`) % 9);
}

function initializeEventSchedule(previous, startedAt, now) {
  if (previous && previous.next_candidate_date) return previous;
  return { sequence: 0, next_candidate_date: addWorkdays(now, getEventInterval(startedAt, 0)) };
}

function getTaskInterval(startedAt, sequence) {
  return 2 + (hashText(startedAt + "|task|" + sequence) % 4);
}

function chooseLunchActivity(now, knownLocationIds = []) {
  const choices = [
    { activity: "eating", location: "CAFETERIA" },
    ...(knownLocationIds.includes("BREAK_ROOM") ? [
      { activity: "resting", location: "BREAK_ROOM" },
      { activity: "chatting", location: "BREAK_ROOM", with: ["miguel_santos"] }
    ] : []),
    { activity: "reading_manual", location: "MAINTENANCE_ROOM" }
  ];
  const choice = choices[hashText(`${getDateKey(now)}|lunch-activity`) % choices.length];
  return { ...choice, with: choice.with || [], current_equipment_id: null, activity_ends_at: null, work_rhythm: "quiet" };
}
function initializeTaskSchedule(previous, startedAt, now) {
  if (previous && previous.next_candidate_date) return previous;
  return { sequence: 0, next_candidate_date: addWorkdays(now, getTaskInterval(startedAt, 0)) };
}
function getOpenTasks(tasks) { return tasks.filter(task => task.status !== "DONE"); }
function getNextTaskNumber(state, tasks) {
  const existing = tasks.reduce((max, task) => Math.max(max, Number(String(task.task_id || "").replace(/\D/g, "")) || 0), 0);
  return Math.max(Number(state.task_counter) || 0, existing) + 1;
}
function getTaskEquipment(state, category, seed) {
  const available = state.equipment.filter(item => !item.pending_issue);
  if (category === "TOOLS_AND_PARTS") return null;
  if (category === "EQUIPMENT_LEARNING") return [...available].sort((left, right) => left.familiarity - right.familiarity || left.id.localeCompare(right.id))[0] || null;
  return available[seed % available.length] || null;
}
function chooseTaskDetails(state, now) {
  const seed = hashText(getDateKey(now) + "|" + state.task_schedule.sequence);
  const category = [
    "PLANNED_INSPECTION", "PLANNED_INSPECTION", "PLANNED_INSPECTION",
    "TOOLS_AND_PARTS", "PLANNED_INSPECTION", "ASSIST_COWORKER",
    "PREVENTIVE_MAINTENANCE", "PLANNED_INSPECTION", "EQUIPMENT_LEARNING",
    "TOOLS_AND_PARTS", "PLANNED_INSPECTION", "ASSIST_COWORKER",
    "PREVENTIVE_MAINTENANCE", "PLANNED_INSPECTION", "HANDOFF_TASK"
  ][state.task_schedule.sequence % 15];
  const equipment = getTaskEquipment(state, category, seed);
  const assignedBy = category === "HANDOFF_TASK" ? "erin_walker" : null;
  const assignedWith = category === "ASSIST_COWORKER" ? [equipment && (equipment.id.startsWith("A") || equipment.id === "C01" || equipment.id === "C03") ? "miguel_santos" : "george_nelson"] : [];
  return { category, equipment, assigned_by: assignedBy, assigned_with: assignedWith };
}
function createTask(state, tasks, now, details) {
  const number = getNextTaskNumber(state, tasks);
  const equipment = details.equipment_id ? getEquipmentById(state.equipment, details.equipment_id) : details.equipment;
  const task = {
    task_id: "TASK-" + String(number).padStart(6, "0"), category: details.category,
    equipment_id: equipment ? equipment.id : null, zone: equipment ? equipment.zone : "MAINTENANCE_ROOM",
    assigned_by: details.assigned_by || null, assigned_with: details.assigned_with || [],
    created_at: formatIsoInTimeZone(now), due_date: details.due_date || getDateKey(now),
    status: "PLANNED", started_at: null, completed_at: null, deferred_at: null,
    activity_ends_at: null, source_event_id: details.source_event_id || null
  };
  state.task_counter = number;
  addKnownPeople(state, [...task.assigned_with, ...(task.assigned_by ? [task.assigned_by] : [])]);
  return task;
}
function hasTaskForEvent(tasks, eventId) { return tasks.some(task => task.source_event_id === eventId); }
function createRecheckTask(state, tasks, event, now) {
  if (hasTaskForEvent(tasks, event.event_id) || getOpenTasks(tasks).length >= 2) return null;
  return createTask(state, tasks, now, { category: "RECHECK", equipment_id: event.equipment_id, assigned_with: [], source_event_id: event.event_id, due_date: addWorkdays(now, 1) });
}
function shouldGenerateTask(state, tasks, now, schedule, onboardingDay) {
  if (onboardingDay < 3 || schedule.workState !== "ON_DUTY") return false;
  if (getDateKey(now) < state.task_schedule.next_candidate_date) return false;
  if (getOpenTasks(tasks).length >= 2) return false;
  return !tasks.some(task => task.created_at.slice(0, 10) === getDateKey(now));
}
function taskDurationMinutes(task) {
  return { PLANNED_INSPECTION: 45, PREVENTIVE_MAINTENANCE: 60, RECHECK: 30, HANDOFF_TASK: 45, TOOLS_AND_PARTS: 35, EQUIPMENT_LEARNING: 45, ASSIST_COWORKER: 60 }[task.category] || 45;
}
function taskFamiliarityGain(task) {
  return ["PLANNED_INSPECTION", "PREVENTIVE_MAINTENANCE", "RECHECK", "EQUIPMENT_LEARNING", "ASSIST_COWORKER"].includes(task.category) && task.equipment_id ? 1 : 0;
}
function deferActiveTasks(tasks, now, logs, reason) {
  const at = formatIsoInTimeZone(now);
  return tasks.map(task => {
    if (task.status !== "ACTIVE") return task;
    logs.push({ at, type: "TASK_DEFERRED", task_id: task.task_id, category: task.category, reason });
    return { ...task, status: "DEFERRED", deferred_at: at, activity_ends_at: null };
  });
}
function applyTask(state, tasks, now, schedule, onboardingDay, immediateEvent, logs) {
  if (schedule.workState !== "ON_DUTY" || immediateEvent) return { tasks: deferActiveTasks(tasks, now, logs, immediateEvent ? "EVENT" : schedule.workState), activeTask: null };
  if (onboardingDay < 3) return { tasks, activeTask: null };
  const active = tasks.find(task => task.status === "ACTIVE");
  if (active) {
    if (active.activity_ends_at && new Date(active.activity_ends_at) <= now) {
      const completedAt = formatIsoInTimeZone(now);
      const done = { ...active, status: "DONE", completed_at: completedAt, activity_ends_at: null };
      const index = tasks.findIndex(task => task.task_id === active.task_id);
      const next = [...tasks]; next[index] = done;
      const gain = taskFamiliarityGain(done);
      if (gain) state.equipment = increaseFamiliarity(state.equipment, done.equipment_id, gain);
      logs.push({ at: completedAt, type: "TASK_DONE", task_id: done.task_id, category: done.category, equipment_id: done.equipment_id, source_event_id: done.source_event_id });
      return { tasks: next, activeTask: null };
    }
    return { tasks, activeTask: active };
  }
  const candidate = tasks.find(task => (task.status === "PLANNED" || task.status === "DEFERRED") && task.due_date <= getDateKey(now));
  if (!candidate) return { tasks, activeTask: null };
  const startedAt = formatIsoInTimeZone(now);
  const activated = { ...candidate, status: "ACTIVE", started_at: candidate.started_at || startedAt, deferred_at: null, activity_ends_at: formatIsoInTimeZone(addMinutes(now, taskDurationMinutes(candidate))) };
  const index = tasks.findIndex(task => task.task_id === candidate.task_id);
  const next = [...tasks]; next[index] = activated;
  logs.push({ at: startedAt, type: "TASK_ACTIVE", task_id: activated.task_id, category: activated.category, equipment_id: activated.equipment_id, source_event_id: activated.source_event_id });
  return { tasks: next, activeTask: activated };
}
function activityForTask(task) {
  return { activity: task.category.toLowerCase(), location: task.zone, with: task.assigned_with, current_equipment_id: task.equipment_id, activity_ends_at: task.activity_ends_at, work_rhythm: "normal" };
}
const ON_CALL_ROTATION = ["george_nelson", "miguel_santos", "shane"];
const ON_CALL_ANCHOR = "2026-09-07";
function getLocalMinutes(date) { const parts = getCalendarInfo(date).parts; return Number(parts.hour) * 60 + Number(parts.minute); }
function getOnCallPerson(now) {
  const parts = getCalendarInfo(now).parts;
  const localDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const mondayOffset = (localDay.getUTCDay() + 6) % 7;
  localDay.setUTCDate(localDay.getUTCDate() - mondayOffset);
  if (mondayOffset === 0 && getLocalMinutes(now) < 510) localDay.setUTCDate(localDay.getUTCDate() - 7);
  const weeks = Math.floor((localDay.getTime() - Date.parse(ON_CALL_ANCHOR + "T00:00:00Z")) / 604800000);
  return ON_CALL_ROTATION[((weeks % ON_CALL_ROTATION.length) + ON_CALL_ROTATION.length) % ON_CALL_ROTATION.length];
}
function addCalendarDays(date, days) {
  const parts = getCalendarInfo(date).parts, cursor = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  cursor.setUTCDate(cursor.getUTCDate() + days); return cursor.toISOString().slice(0, 10);
}
function getOffHoursInterval(startedAt, sequence) { return 28 + (hashText(startedAt + "|off-hours|" + sequence) % 57); }
function initializeOffHoursSchedule(previous, startedAt, now) {
  if (previous && previous.next_candidate_date) return previous;
  return { sequence: 0, next_candidate_date: addCalendarDays(now, getOffHoursInterval(startedAt, 0)) };
}
function isOffHoursEmergencyWindow(now, schedule) {
  if (schedule.workState !== "OFF_DUTY") return false;
  const minutes = getLocalMinutes(now);
  return schedule.isWorkday ? minutes >= 1080 && minutes < 1380 : minutes >= 540 && minutes < 1260;
}
function createOffHoursEmergency(state, events, now, onCallPerson) {
  const number = getNextEventNumber(state, events);
  const event = {
    event_id: "EVT-" + String(number).padStart(6, "0"), created_date: getDateKey(now), created_at: formatIsoInTimeZone(now), updated_at: formatIsoInTimeZone(now),
    equipment_id: "D02", category: "OFF_HOURS_CRITICAL", summary: "关键温控辅助系统存在需立即处理的风险", severity: "SERIOUS", importance: "HIGH",
    status: "DETECTED", assigned_with: onCallPerson === "shane" ? [] : [onCallPerson], requires_parts: false, parts_available_at: null,
    step_due_at: formatIsoInTimeZone(addMinutes(now, 25)), off_hours_emergency: true, on_call_assignee: onCallPerson
  };
  state.event_counter = number;
  state.equipment = state.equipment.map(item => item.id === event.equipment_id ? { ...item, status: "SERIOUS_ISSUE", pending_issue: event.event_id } : item);
  return event;
}
function isOvertimeEligible(event) { return event && event.severity === "SERIOUS" && !event.off_hours_emergency && ["DETECTED", "CHECKING", "REPAIRING", "RECHECK"].includes(event.status); }
function addHoursRecord(hours, entry) { if (!hours.some(item => item.record_id === entry.record_id)) hours.push(entry); }
function recordNormalHours(hours, now, schedule) {
  if (!schedule.isWorkday || schedule.workState === "LEAVE" || getLocalMinutes(now) < 1050) return;
  const date = getDateKey(now), offset = formatIsoInTimeZone(now).slice(-6);
  addHoursRecord(hours, { record_id: "NORMAL-" + date, type: "NORMAL", date, started_at: date + "T08:30:00" + offset, ended_at: date + "T17:30:00" + offset, minutes: 390, source_event_id: null });
}
function startWorkSession(type, event, now, delayMinutes = 0) {
  const startedAt = formatIsoInTimeZone(now);
  const workStartedAt = delayMinutes ? formatIsoInTimeZone(addMinutes(now, delayMinutes)) : startedAt;
  const limitMinutes = type === "OVERTIME" ? 120 : 180;
  return { session_id: type + "-" + event.event_id + "-" + startedAt, type, source_event_id: event.event_id, started_at: startedAt, work_started_at: workStartedAt, deadline_at: formatIsoInTimeZone(addMinutes(new Date(workStartedAt), limitMinutes)) };
}
function finishWorkSession(session, hours, now) {
  const endedAt = formatIsoInTimeZone(now), minutes = Math.max(0, Math.round((now.getTime() - new Date(session.work_started_at).getTime()) / 60000));
  addHoursRecord(hours, { record_id: session.session_id, type: session.type, date: session.work_started_at.slice(0, 10), started_at: session.work_started_at, ended_at: endedAt, minutes, source_event_id: session.source_event_id });
}
function safelyPauseEvent(events, event, now) {
  const index = events.findIndex(item => item.event_id === event.event_id);
  if (index >= 0) events[index] = transitionEvent(event, "TEMP_FIXED", now, { step_due_at: null, safe_hold: true });
}
function syncCurrentKnowledge(knowledge, events, tasks, base, session, currentTime) {
  let changed = false;
  if (session) {
    const event = events.find(item => item.event_id === session.source_event_id);
    if (event) changed = learnFact(knowledge, "EVENT", event, session.type === "CALL_OUT" ? "DIRECT_CALL_OUT" : "DIRECT_WORK", currentTime) || changed;
  }
  const activeTask = tasks.find(task => task.status === "ACTIVE");
  if (activeTask) changed = learnFact(knowledge, "TASK", activeTask, "DIRECT_TASK", currentTime) || changed;
  if (["checking", "repairing", "rechecking"].includes(base.activity)) {
    const event = events.find(item => item.status !== "RESOLVED" && item.equipment_id === base.current_equipment_id);
    if (event) changed = learnFact(knowledge, "EVENT", event, "DIRECT_WORK", currentTime) || changed;
  }
  for (const fact of knowledge.facts) {
    if (fact.subject_type === "TASK") {
      const task = tasks.find(item => item.task_id === fact.source_task_id);
      if (task) changed = learnFact(knowledge, "TASK", task, fact.channel, currentTime) || changed;
    }
    if (fact.subject_type === "EVENT") {
      const event = events.find(item => item.event_id === fact.source_event_id);
      if (event && (!event.off_hours_emergency || event.on_call_assignee === "shane")) changed = learnFact(knowledge, "EVENT", event, fact.channel, currentTime) || changed;
    }
  }
  return changed;
}
function applyWorkSession(state, events, hours, now, logs) {
  const session = state.work_session;
  if (!session) return { session: null, activeEvent: null, display: null };
  const event = events.find(item => item.event_id === session.source_event_id);
  if (!event) { finishWorkSession(session, hours, now); return { session: null, activeEvent: null, display: null }; }
  if (session.type === "CALL_OUT" && new Date(session.work_started_at) > now) return { session, activeEvent: event, display: { activity: "responding_call_out", location: "OFF_SITE", with: [], current_equipment_id: event.equipment_id, activity_ends_at: session.work_started_at, work_rhythm: "normal" } };
  const advanced = advanceEvent(event, state, now);
  let current = advanced.event;
  if (advanced.event !== event) { const index = events.findIndex(item => item.event_id === event.event_id); events[index] = advanced.event; if (advanced.log) logs.push(advanced.log); }
  const expired = new Date(session.deadline_at) <= now;
  if (current.status === "RESOLVED" || current.status === "WAITING_PARTS" || expired) {
    if (expired && current.status !== "RESOLVED" && current.status !== "WAITING_PARTS") safelyPauseEvent(events, current, now);
    finishWorkSession(session, hours, now);
    logs.push({ at: formatIsoInTimeZone(now), type: session.type + "_ENDED", source_event_id: session.source_event_id, reason: expired ? "SAFETY_LIMIT" : current.status });
    return { session: null, activeEvent: null, display: null };
  }
  return { session, activeEvent: current, display: activityForEvent(current, getEquipmentById(state.equipment, current.equipment_id)) };
}
function shouldGenerateEvent(state, events, now, schedule) {
  if (schedule.workState !== "ON_DUTY") return false;
  if (getDateKey(now) < state.event_schedule.next_candidate_date) return false;
  const openEvents = getOpenEvents(events);
  if (openEvents.length >= 2) return false;
  if (openEvents.some(event => event.severity === "SERIOUS")) return false;
  if (openEvents.some(event => event.status !== "WAITING_PARTS")) return false;
  if (events.some(event => event.created_date === getDateKey(now))) return false;
  return true;
}

function activityForEvent(event, equipment) {
  const activity = event.status === "REPAIRING" ? "repairing"
    : event.status === "RECHECK" ? "rechecking"
    : event.status === "WAITING_PARTS" ? "waiting_parts"
    : "checking";
  return { activity, location: equipment.zone, with: event.assigned_with, current_equipment_id: event.equipment_id, activity_ends_at: event.step_due_at, work_rhythm: "normal" };
}

function applyActivity(state, now, schedule, onboardingDay, immediateEvent, activeTask) {
  if (schedule.workState === "LEAVE") return { activity: "on_leave", location: "OFF_SITE", with: [], current_equipment_id: null, activity_ends_at: null, work_rhythm: "quiet" };
  if (schedule.workState === "PRE_WORK") return { activity: "preparing_for_work", location: "OFF_SITE", with: [], current_equipment_id: null, activity_ends_at: null, work_rhythm: "quiet" };
  if (schedule.workState === "COMMUTING_TO_WORK") return { activity: "commuting_to_work", location: "COMMUTE", with: [], current_equipment_id: null, activity_ends_at: null, work_rhythm: "quiet" };
  if (schedule.workState === "LUNCH") return chooseLunchActivity(now, state.known_location_ids);
  if (schedule.workState === "OFF_DUTY") return { activity: "off_duty", location: "OFF_SITE", with: [], current_equipment_id: null, activity_ends_at: null, work_rhythm: "quiet" };
  if (immediateEvent) return activityForEvent(immediateEvent, getEquipmentById(state.equipment, immediateEvent.equipment_id));
  if (activeTask) return activityForTask(activeTask);

  const currentEndsAt = state.activity_ends_at ? new Date(state.activity_ends_at) : null;
  if (state.work_state === "ON_DUTY" && currentEndsAt && currentEndsAt > now) {
    return { activity: state.activity, location: state.location, with: state.with || [], current_equipment_id: state.current_equipment_id || null, activity_ends_at: state.activity_ends_at, work_rhythm: state.work_rhythm || "quiet" };
  }
  const choice = chooseOnDutyActivity(state, onboardingDay, now);
  if (choice.familiarity_gain) state.equipment = increaseFamiliarity(state.equipment, choice.equipment_id, choice.familiarity_gain);
  state.activity_index = (Number(state.activity_index) || 0) + 1;
  addKnownPeople(state, choice.with);
  return { activity: choice.activity, location: choice.location, with: choice.with, current_equipment_id: choice.equipment_id, activity_ends_at: formatIsoInTimeZone(addMinutes(now, choice.duration_minutes)), work_rhythm: choice.rhythm };
}

function hasDisplayStateChanged(previous, next) {
  return !previous || previous.work_state !== next.work_state || previous.activity !== next.activity
    || previous.location !== next.location || JSON.stringify(previous.with || []) !== JSON.stringify(next.with || [])
    || previous.current_equipment_id !== next.current_equipment_id || previous.is_workday !== next.is_workday;
}

function appendLog(entry) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf-8");
}

function tickBase(now = new Date()) {
  const currentTime = formatIsoInTimeZone(now);
  const previous = loadState();
  const startedAt = previous?.employment_started_at || currentTime;
  const leaves = loadLeaves();
  const isOnLeave = isOnApprovedLeave(leaves, getDateKey(now));
  const onboardingDay = countWorkdaysThrough(startedAt, now, leaves);
  const onboarding = advanceSession(previous?.onboarding_session, { dateKey: getDateKey(now), minutes: getLocalMinutes(now), now: currentTime, isOnLeave });
  let schedule = getScheduleState(now, isOnLeave);
  schedule = applyScheduleOverride(schedule, onboarding.session, getDateKey(now), getLocalMinutes(now), isOnLeave);
  const isStartingWorkDay = shouldStartWorkDay(previous, schedule, now);
  const state = {
    equipment: initializeEquipment(previous?.equipment),
    event_counter: Number(previous?.event_counter) || 0,
    event_schedule: initializeEventSchedule(previous?.event_schedule, startedAt, now),
    task_counter: Number(previous?.task_counter) || 0,
    task_schedule: initializeTaskSchedule(previous?.task_schedule, startedAt, now),
    activity_index: Number(previous?.activity_index) || 0,
    known_npc_ids: Array.isArray(previous?.known_npc_ids) ? [...previous.known_npc_ids] : [],
    known_location_ids: recoverKnownLocations(previous),
    personal_facilities: previous?.personal_facilities || null,
    work_state: previous?.work_state,
    activity: previous?.activity,
    location: previous?.location,
    with: previous?.with,
    current_equipment_id: previous?.current_equipment_id,
    activity_ends_at: previous?.activity_ends_at,
    work_rhythm: previous?.work_rhythm,
    routine_activity: previous?.routine_activity || null
  };
  ensureCoreFacilityLocations(state, onboarding.session);
  const events = loadEvents();
  const routineStore = loadRoutineWork();
  let tasks = loadTasks();
  const logs = [];
  let activeEvent = getActiveEvent(events);
  // 当日首个 tick 只初始化工作上下文；普通 event/task 留给后续 Heartbeat tick。
  if (!isStartingWorkDay && shouldGenerateEvent(state, events, now, schedule)) {
    const createdEvent = createEvent(state, events, now);
    if (createdEvent) {
      activeEvent = createdEvent;
      events.push(activeEvent);
      const nextSequence = state.event_schedule.sequence + 1;
      state.event_schedule = {
        sequence: nextSequence,
        next_candidate_date: addWorkdays(now, getEventInterval(startedAt, nextSequence))
      };
      logs.push({ at: currentTime, type: "EVENT_DETECTED", event_id: activeEvent.event_id, equipment_id: activeEvent.equipment_id, severity: activeEvent.severity, importance: activeEvent.importance });
    }
  }
  if (activeEvent && schedule.workState === "ON_DUTY") {
    const advanced = advanceEvent(activeEvent, state, now);
    if (advanced.event !== activeEvent) {
      const index = events.findIndex(event => event.event_id === activeEvent.event_id);
      events[index] = advanced.event;
      activeEvent = advanced.event.status === "RESOLVED" ? null : advanced.event;
      if (advanced.log) logs.push(advanced.log);
      if (advanced.event.status === "RESOLVED") {
        const recheckTask = createRecheckTask(state, tasks, advanced.event, now);
        if (recheckTask) { tasks.push(recheckTask); logs.push({ at: currentTime, type: "TASK_PLANNED", task_id: recheckTask.task_id, category: recheckTask.category, equipment_id: recheckTask.equipment_id, source_event_id: recheckTask.source_event_id }); }
      }
    }
  }
  const immediateEvent = events.find(event => event.status !== "RESOLVED" && event.status !== "WAITING_PARTS") || null;
  if (!isStartingWorkDay && shouldGenerateTask(state, tasks, now, schedule, onboardingDay)) {
    const plannedTask = createTask(state, tasks, now, chooseTaskDetails(state, now));
    tasks.push(plannedTask);
    const nextSequence = state.task_schedule.sequence + 1;
    state.task_schedule = { sequence: nextSequence, next_candidate_date: addWorkdays(now, getTaskInterval(startedAt, nextSequence)) };
    logs.push({ at: currentTime, type: "TASK_PLANNED", task_id: plannedTask.task_id, category: plannedTask.category, equipment_id: plannedTask.equipment_id });
  }
  const taskResult = applyTask(state, tasks, now, schedule, onboardingDay, immediateEvent, logs);
  tasks = taskResult.tasks;
  const routineResult = completeRoutineActivity(state.routine_activity, now, schedule, immediateEvent, taskResult.activeTask, routineStore);
  if (routineResult.changed) saveRoutineWork(routineStore);
  const discoveredBreakRoom = discoverBreakRoom(state, schedule, onboardingDay);
  ensureBreakRoomPersonalFacilities(state);
  let activityState = applyActivity(state, now, schedule, onboardingDay, immediateEvent, taskResult.activeTask);
  if (discoveredBreakRoom) activityState = { activity: "chatting", location: "BREAK_ROOM", with: ["george_nelson"], current_equipment_id: null, activity_ends_at: null, work_rhythm: "quiet" };
  if (!immediateEvent && !taskResult.activeTask && onboarding.activity) activityState = onboarding.activity;
  let routineActivity = routineResult.routine;
  const continuingLegacyRoutine = !routineActivity && previous?.work_state === "ON_DUTY" && previous.activity === activityState.activity && previous.activity_ends_at === activityState.activity_ends_at && previous.activity_ends_at && new Date(previous.activity_ends_at) > now;
  if (!routineActivity && !continuingLegacyRoutine && schedule.workState === "ON_DUTY" && !immediateEvent && !taskResult.activeTask && !onboarding.activity) {
    routineActivity = createRoutineActivity(activityState, currentTime);
  }
  const displayState = { is_workday: schedule.isWorkday, work_state: schedule.workState, ...activityState };
  const next = {
    schema_version: 6,
    company: COMPANY.name,
    time_zone: TIME_ZONE,
    current_time: currentTime,
    employment_started_at: startedAt,
    employment_status: "EMPLOYED",
    role: "设备维修技师",
    age: 29,
    onboarding_day: onboardingDay,
    onboarding_phase: getOnboardingPhase(onboardingDay),
    work_day_started_date: isStartingWorkDay ? getDateKey(now) : previous?.work_day_started_date || null,
    work_day_started_at: isStartingWorkDay ? currentTime : previous?.work_day_started_at || null,
    is_workday: schedule.isWorkday,
    is_on_leave: Boolean(schedule.isOnLeave),
    work_state: schedule.workState,
    activity: activityState.activity,
    location: activityState.location,
    with: activityState.with,
    current_equipment_id: activityState.current_equipment_id,
    activity_ends_at: activityState.activity_ends_at,
    work_rhythm: activityState.work_rhythm,
    routine_activity: routineActivity,
    since: hasDisplayStateChanged(previous, displayState) ? currentTime : previous.since,
    last_tick_at: currentTime,
    activity_index: state.activity_index,
    event_counter: state.event_counter,
    event_schedule: state.event_schedule,
    task_counter: state.task_counter,
    task_schedule: state.task_schedule,
    known_npc_ids: state.known_npc_ids,
    known_location_ids: state.known_location_ids,
    personal_facilities: state.personal_facilities,
    onboarding_session: onboarding.session,
    onboarding_context: onboarding.session?.active ? onboarding.session.context : null,
    equipment: state.equipment
  };
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(EVENTS_PATH, events);
  saveTasks(tasks);
  writeJsonAtomicSync(STATE_PATH, next);
  if (onboarding.changed) logs.unshift({ at: currentTime, type: "ONBOARDING_STEP", onboarding_session_id: onboarding.session.session_id, step_id: onboarding.session.context.current_step_id });
  if (isStartingWorkDay) logs.unshift({ at: currentTime, type: "WORK_DAY_STARTED", work_day_started_date: next.work_day_started_date, onboarding_day: next.onboarding_day, onboarding_phase: next.onboarding_phase });
  if (hasDisplayStateChanged(previous, next)) logs.unshift({ at: currentTime, type: previous ? "ACTIVITY_CHANGED" : "STATE_INITIALIZED", work_state: next.work_state, activity: next.activity, location: next.location, with: next.with, current_equipment_id: next.current_equipment_id, onboarding_day: next.onboarding_day });
  for (const log of logs) appendLog(log);
  return next;
}

function tick(now = new Date()) {
  const before = loadState();
  const base = tickBase(now);
  ticksDailyLife(now, base);
  const leaves = loadLeaves(), isOnLeave = isOnApprovedLeave(leaves, getDateKey(now));
  const schedule = getScheduleState(now, isOnLeave), currentTime = formatIsoInTimeZone(now), scheduledOnCallPerson = getOnCallPerson(now);
  const onCallPerson = isOnLeave && scheduledOnCallPerson === "shane" ? "george_nelson" : scheduledOnCallPerson;
  const state = { ...base, equipment: base.equipment, event_counter: base.event_counter, work_session: before?.work_session || null };
  const events = loadEvents(), hours = loadWorkHours(), logs = [];
  recordNormalHours(hours, now, schedule);
  let session = state.work_session;
  let active = session ? events.find(event => event.event_id === session.source_event_id) : null;
  if (session && !(session.type === "CALL_OUT" && new Date(session.work_started_at) > now) && active) {
    const advanced = advanceEvent(active, state, now);
    active = advanced.event;
    const index = events.findIndex(event => event.event_id === active.event_id);
    events[index] = active;
    if (active.status === "RESOLVED" || active.status === "WAITING_PARTS" || new Date(session.deadline_at) <= now) {
      if (new Date(session.deadline_at) <= now && active.status !== "RESOLVED" && active.status !== "WAITING_PARTS") safelyPauseEvent(events, active, now);
      finishWorkSession(session, hours, new Date(session.deadline_at) <= now && active.status !== "RESOLVED" && active.status !== "WAITING_PARTS" ? new Date(session.deadline_at) : now); session = null;
    }
  }
  if (!session && schedule.workState === "OFF_DUTY" && schedule.isWorkday && getLocalMinutes(now) >= 1050) {
    active = getActiveEvent(events);
    if (isOvertimeEligible(active)) session = startWorkSession("OVERTIME", active, now);
  }
  const offSchedule = initializeOffHoursSchedule(before?.off_hours_schedule, base.employment_started_at, now);
  if (!session && isOffHoursEmergencyWindow(now, schedule) && getDateKey(now) >= offSchedule.next_candidate_date) {
    const emergency = createOffHoursEmergency(state, events, now, onCallPerson);
    events.push(emergency);
    const sequence = offSchedule.sequence + 1;
    state.off_hours_schedule = { sequence, next_candidate_date: addCalendarDays(now, getOffHoursInterval(base.employment_started_at, sequence)) };
    if (onCallPerson === "shane") { session = startWorkSession("CALL_OUT", emergency, now, 30); active = emergency; }
    else {
      const index = events.findIndex(event => event.event_id === emergency.event_id);
      const response = { responder_npc_id: onCallPerson, source_event_id: emergency.event_id, started_at: emergency.created_at, ended_at: currentTime, result: "RESOLVED" };
      events[index] = transitionEvent(emergency, "RESOLVED", now, { resolved_by: onCallPerson, response, step_due_at: null });
      state.equipment = state.equipment.map(item => item.id === emergency.equipment_id ? { ...item, status: "NORMAL", pending_issue: null } : item);
    }
  }
  let next = { ...base, schema_version: 5, on_call: onCallPerson === "shane", on_call_person: onCallPerson, scheduled_on_call_person: scheduledOnCallPerson, effective_on_call_person: onCallPerson, off_hours_schedule: state.off_hours_schedule || offSchedule, work_session: session };
  if (session) {
    next.work_state = session.type === "OVERTIME" ? "OVERTIME" : "CALLED_OUT";
    if (session.type === "CALL_OUT" && new Date(session.work_started_at) > now) next = { ...next, activity: "responding_call_out", location: "OFF_SITE", with: [], current_equipment_id: active?.equipment_id || null, activity_ends_at: session.work_started_at };
    else if (active) Object.assign(next, activityForEvent(active, getEquipmentById(state.equipment, active.equipment_id)));
  }
next.current_time = currentTime; next.last_tick_at = currentTime; next.equipment = state.equipment;
  const knowledge = loadKnowledge();
  const onboardingCompletedAt = base.onboarding_session?.history?.find(item => item.step_id === "ONBOARDING_COMPLETED")?.occurred_at || currentTime;
  const breakRoomKnowledgeChanged = base.known_location_ids.includes(FACILITIES.BREAK_ROOM.id)
    ? learnLocationFact(knowledge, FACILITIES.BREAK_ROOM.id, currentTime)
    : false;
  const breakRoomLearnedAt = knowledge.facts.find(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM")?.learned_at || currentTime;
  const personalFacilityKnowledgeChanged = base.known_location_ids.includes(FACILITIES.BREAK_ROOM.id)
    && base.personal_facilities?.rest_bed_id === "SHANE_BED_04"
    && base.personal_facilities?.locker_id === "SHANE_LOCKER_04"
    ? learnPersonalFacilityFact(knowledge, base.personal_facilities, currentTime, breakRoomLearnedAt)
    : false;
  const cafeteriaKnowledgeChanged = base.onboarding_session?.status === "COMPLETED" && base.known_location_ids.includes(FACILITIES.CAFETERIA.id)
    ? learnLocationFact(knowledge, FACILITIES.CAFETERIA.id, currentTime, onboardingCompletedAt)
    : false;
  const coreFacilityKnowledgeChanged = base.onboarding_session?.status === "COMPLETED"
    ? learnCoreFacilityFact(knowledge, base.onboarding_session, currentTime)
    : false;
  const mealBenefitKnowledgeChanged = base.onboarding_session?.status === "COMPLETED"
    ? learnMealBenefitFact(knowledge, base.onboarding_session, currentTime)
    : false;
  let knowledgeChanged = syncCurrentKnowledge(knowledge, events, loadTasks(), base, session, currentTime) || breakRoomKnowledgeChanged || personalFacilityKnowledgeChanged || cafeteriaKnowledgeChanged || coreFacilityKnowledgeChanged || mealBenefitKnowledgeChanged;
  let onboardingFact = null;
  if (base.onboarding_session?.history?.length) { onboardingFact = learnOnboardingFact(knowledge, base.onboarding_session, currentTime); knowledgeChanged = true; }
  if (knowledgeChanged) saveKnowledge(knowledge);
  const wakeRequests = loadWakeRequests();
  let requestChanged = false;
  if (onboardingFact && base.onboarding_session.history.some(item => item.step_id === "ONBOARDING_DAY1_REPORT")) requestChanged = queueOnboardingWake(wakeRequests, base.onboarding_session.session_id, onboardingFact.fact_key, currentTime) || requestChanged;
  for (const fact of knowledge.facts.filter(item => item.subject_type === "EVENT" && ["DIRECT_WORK", "DIRECT_CALL_OUT"].includes(item.channel))) {
    const event = events.find(item => item.event_id === fact.source_event_id);
    const wakeWorthy = fact.channel === "DIRECT_CALL_OUT" || (fact.channel === "DIRECT_WORK" && event?.severity === "SERIOUS");
    if (event && wakeWorthy) requestChanged = queueWorkWake(wakeRequests, event.event_id, fact.fact_key, currentTime) || requestChanged;
  }
  if (requestChanged) saveWakeRequests(wakeRequests);
  writeJsonAtomicSync(EVENTS_PATH, events); saveWorkHours(hours); writeJsonAtomicSync(STATE_PATH, next);
  return next;
}
function getCurrentOnboardingContext() { const state = loadState(); return state?.onboarding_session?.active ? state.onboarding_session.context || null : null; }
module.exports = { tick, getCurrentOnboardingContext, getScheduleState };
