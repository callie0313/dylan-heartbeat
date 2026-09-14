const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "work-activity-lifecycle-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";

const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const { tick } = require("../shane_work/shane_work");
const { loadRoutineWork } = require("../shane_work/routine_work");
const { buildTodayKnownExperience } = require("../shane_work/context_builder");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");

function at(time) { return new Date(`2026-09-10T${time}:00+08:00`); }
function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(STATE_PATH, {
    employment_started_at: "2026-09-08T08:30:00+08:00",
    work_state: "ON_DUTY",
    activity: "waiting",
    location: "MAINTENANCE_ROOM",
    with: [],
    current_equipment_id: null,
    activity_ends_at: null,
    activity_index: 1,
    onboarding_session: { session_id: "SHANE-ONBOARDING-2026-09-08", status: "COMPLETED", active: false, history: [] },
    event_schedule: { sequence: 0, next_candidate_date: "2099-01-01" },
    task_schedule: { sequence: 0, next_candidate_date: "2099-01-01" },
    known_npc_ids: [],
    known_location_ids: ["MAINTENANCE_ROOM"],
    personal_facilities: null,
    equipment: []
  });
  writeJsonAtomicSync(path.join(WORK_DIR, "events.json"), []);
  writeJsonAtomicSync(path.join(WORK_DIR, "tasks.json"), []);
  writeJsonAtomicSync(path.join(WORK_DIR, "knowledge.json"), { schema_version: 1, facts: [] });
  writeJsonAtomicSync(path.join(WORK_DIR, "wake_requests.json"), { schema_version: 1, requests: [] });
}

function runSample(index) {
  reset();
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  state.activity_index = index;
  writeJsonAtomicSync(STATE_PATH, state);
  const started = tick(at("09:00"));
  return (new Date(started.activity_ends_at).getTime() - at("09:00").getTime()) / 60_000;
}


function dateAt(day, time) { return new Date(`${day}T${time}:00+08:00`); }
function seedRoutineWindow(startedAt, endsAt, id = "ROUTINE-EDGE") {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  Object.assign(state, {
    work_state: "ON_DUTY", activity: "inspection", location: "A区", with: [], current_equipment_id: "A02",
    activity_ends_at: endsAt,
    routine_activity: { id, kind: "ROUTINE_INSPECTION", activity_type: "inspection", equipment_id: "A02", with: [], started_at: startedAt, activity_ends_at: endsAt, result: "NORMAL" }
  });
  writeJsonAtomicSync(STATE_PATH, state);
}
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("普通 inspection 在开始时确定 30–120 分钟持续时间，后续 tick 和重载前保持不变", () => {
  reset();
  const started = tick(at("09:00"));
  assert.equal(started.activity, "inspection");
  const endsAt = started.activity_ends_at;
  const duration = (new Date(endsAt).getTime() - at("09:00").getTime()) / 60_000;
  assert.ok(duration >= 30 && duration <= 120);

  const middle = tick(at("09:30"));
  assert.equal(middle.activity, "inspection");
  assert.equal(middle.activity_ends_at, endsAt);

  delete require.cache[require.resolve("../shane_work/shane_work")];
  const reloaded = require("../shane_work/shane_work").tick(at("09:45"));
  assert.equal(reloaded.activity, "inspection");
  assert.equal(reloaded.activity_ends_at, endsAt);
});

test("普通自由 activity 使用确定性 30–120 分钟范围，而非固定三档", () => {
  const durations = [0, 1, 2, 3, 4, 5, 6, 7].map(runSample);
  for (const duration of durations) assert.ok(duration >= 30 && duration <= 120);
  assert.ok(new Set(durations).size > 3);
  assert.ok(durations.some(duration => ![30, 60, 90].includes(duration)));
});

test("已完成的普通 inspection/整理工具/阅读资料写入窄 routine work，重复 tick 不重复", () => {
  for (const [index, type] of [[1, "inspection"], [3, "organizing_tools"], [4, "reading_manual"]]) {
    reset();
    const seed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    seed.activity_index = index;
    writeJsonAtomicSync(STATE_PATH, seed);
    const started = tick(at("09:00"));
    assert.equal(started.activity, type);
    const completed = require("../shane_work/shane_work").tick(new Date(started.activity_ends_at));
    const records = loadRoutineWork().records;
    assert.equal(records.length, 1);
    assert.equal(records[0].activity_type, type);
    assert.equal(records[0].equipment_id, type === "organizing_tools" ? null : started.current_equipment_id);
    assert.equal(records[0].completed_at, started.activity_ends_at);
    require("../shane_work/shane_work").tick(new Date(started.activity_ends_at));
    assert.equal(loadRoutineWork().records.length, 1);
    assert.ok(completed.activity);
  }
});

test("waiting、wandering、slacking 结束后不生成 routine work 记录", () => {
  for (const index of [0, 5, 6]) {
    reset();
    const seed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    seed.activity_index = index;
    writeJsonAtomicSync(STATE_PATH, seed);
    const started = tick(at("09:00"));
    assert.ok(["waiting", "wandering", "slacking"].includes(started.activity));
    tick(new Date(started.activity_ends_at));
    assert.equal(loadRoutineWork().records.length, 0);
  }
});

test("尚未完成的普通 activity 被正式 task 打断时不记录为完成", () => {
  reset();
  const started = tick(at("09:00"));
  assert.equal(started.activity, "inspection");
  writeJsonAtomicSync(path.join(WORK_DIR, "tasks.json"), [{
    task_id: "TASK-900001", category: "TOOLS_AND_PARTS", equipment_id: null, zone: "MAINTENANCE_ROOM",
    assigned_by: null, assigned_with: [], created_at: "2026-09-10T09:01:00+08:00", due_date: "2026-09-10",
    status: "PLANNED", started_at: null, completed_at: null, deferred_at: null, activity_ends_at: null, source_event_id: null
  }]);
  const interrupted = tick(at("09:30"));
  assert.equal(interrupted.activity, "tools_and_parts");
  assert.equal(interrupted.routine_activity, null);
  assert.equal(loadRoutineWork().records.length, 0);
});

test("routine activity 重启后仍只完成一次", () => {
  reset();
  const started = tick(at("09:00"));
  delete require.cache[require.resolve("../shane_work/shane_work")];
  const reloadedTick = require("../shane_work/shane_work").tick;
  reloadedTick(new Date(started.activity_ends_at));
  reloadedTick(new Date(started.activity_ends_at));
  assert.equal(loadRoutineWork().records.length, 1);
});
test("routine completion 仅接受同一连续上午或下午工作段", () => {
  for (const [startedAt, endsAt] of [
    ["2026-09-10T09:00:00+08:00", "2026-09-10T10:00:00+08:00"],
    ["2026-09-10T11:20:00+08:00", "2026-09-10T11:55:00+08:00"],
    ["2026-09-10T14:40:00+08:00", "2026-09-10T16:00:00+08:00"],
    ["2026-09-10T16:20:00+08:00", "2026-09-10T17:20:00+08:00"]
  ]) {
    reset();
    seedRoutineWindow(startedAt, endsAt);
    tick(new Date(endsAt));
    const records = loadRoutineWork().records;
    assert.equal(records.length, 1);
    assert.equal(records[0].started_at, startedAt);
    assert.equal(records[0].completed_at, endsAt);
  }
});

test("跨午休、跨下班或跨日的 routine 不会补写 DONE，也不会进入 Today summary", () => {
  const invalid = [
    ["2026-09-10T11:45:00+08:00", "2026-09-10T12:15:00+08:00", "2026-09-10T14:30:00+08:00"],
    ["2026-09-10T11:30:00+08:00", "2026-09-10T14:45:00+08:00", "2026-09-10T15:00:00+08:00"],
    ["2026-09-10T17:10:00+08:00", "2026-09-10T17:45:00+08:00", "2026-09-10T17:45:00+08:00"],
    ["2026-09-10T16:50:00+08:00", "2026-09-11T08:40:00+08:00", "2026-09-11T08:40:00+08:00"],
    ["2026-09-10T16:10:00+08:00", "2026-09-10T17:20:00+08:00", "2026-09-11T09:00:00+08:00"]
  ];
  for (const [startedAt, endsAt, tickAt] of invalid) {
    reset();
    seedRoutineWindow(startedAt, endsAt, `ROUTINE-INVALID-${startedAt.slice(11, 16).replace(":", "")}`);
    const after = tick(new Date(tickAt));
    assert.equal(loadRoutineWork().records.length, 0);
    assert.notEqual(after.routine_activity?.id, `ROUTINE-INVALID-${startedAt.slice(11, 16).replace(":", "")}`);
    tick(new Date(tickAt));
    assert.equal(loadRoutineWork().records.length, 0);
    assert.equal(buildTodayKnownExperience({ knowledge: { facts: [] }, routineWork: loadRoutineWork(), now: new Date(tickAt) }).length, 0);
  }
});