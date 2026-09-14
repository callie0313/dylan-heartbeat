const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "work-sync-context-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";

const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const {
  prepareWorkSyncContext,
  markWorkSyncDelivered,
  insertTransientCurrentWorkContext,
  buildTodayKnownExperience,
  buildBaselineAwarenessContext,
  buildObjectiveFactBoundaryContext
} = require("../shane_work/context_builder");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const paths = {
  state: path.join(WORK_DIR, "state.json"),
  knowledge: path.join(WORK_DIR, "knowledge.json"),
  daily: path.join(WORK_DIR, "daily_life.json"),
  events: path.join(WORK_DIR, "events.json"),
  tasks: path.join(WORK_DIR, "tasks.json"),
  wake: path.join(WORK_DIR, "wake_requests.json"),
  hours: path.join(WORK_DIR, "work_hours.json"),
  legacyCursor: path.join(WORK_DIR, "work_sync_cursor.json"),
  kelivoCursor: path.join(WORK_DIR, "work_sync_cursor_kelivo.json"),
  wakeCursor: path.join(WORK_DIR, "work_sync_cursor_wake.json"),
  routine: path.join(WORK_DIR, "routine_work.json")
};

function at(time) { return new Date(`2026-09-14T${time}:00+08:00`); }
function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(paths.state, {
    work_state: "ON_DUTY", activity: "inspection", location: "A区", with: [], current_equipment_id: "A02",
    onboarding_phase: "NORMAL", is_workday: true, on_call: false, work_session: null
  });
  writeJsonAtomicSync(paths.knowledge, { schema_version: 1, facts: [] });
  writeJsonAtomicSync(paths.daily, { schema_version: 1, events: [] });
  writeJsonAtomicSync(paths.events, [{ event_id: "WORLD-UNKNOWN", category: "SECRET_WORLD_EVENT" }]);
  writeJsonAtomicSync(paths.tasks, [{ task_id: "WORLD-UNKNOWN-TASK" }]);
  writeJsonAtomicSync(paths.wake, { schema_version: 1, requests: [] });
  writeJsonAtomicSync(paths.hours, [{ record_id: "KEEP-HOURS" }]);
  writeJsonAtomicSync(paths.routine, { schema_version: 1, records: [] });
}
function update(file, value) { writeJsonAtomicSync(file, value); }
function snapshotFiles() { return new Map(Object.values(paths).filter(file => fs.existsSync(file)).map(file => [file, fs.readFileSync(file, "utf8")])); }
function assertFilesUnchanged(before) { for (const [file, text] of before) assert.equal(fs.readFileSync(file, "utf8"), text); }

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("首次消息注入当前工作同步，连续无变化消息不重复", () => {
  reset();
  const first = prepareWorkSyncContext(at("09:00"));
  assert.match(first.context, /^【工作同步】/);
  assert.match(first.context, /当前工作状态：工作中/);
  markWorkSyncDelivered(first.cursor, at("09:00"));
  const second = prepareWorkSyncContext(at("09:05"));
  assert.equal(second.context, "");
});

test("Shane 已知的新 task/event 最多三条进入近期，未知世界事件不会进入", () => {
  reset();
  const initial = prepareWorkSyncContext(at("09:00"));
  markWorkSyncDelivered(initial.cursor, at("09:00"));
  update(paths.knowledge, {
    schema_version: 1,
    facts: [
      { fact_key: "TASK:TASK-1", subject_type: "TASK", last_known_at: "2026-09-14T09:10:00+08:00", known_snapshot: { equipment_id: "A02", category: "PLANNED_INSPECTION", status: "DONE", completed_at: "2026-09-14T09:10:00+08:00" } },
      { fact_key: "EVENT:EVT-2", subject_type: "EVENT", last_known_at: "2026-09-14T09:20:00+08:00", known_snapshot: { equipment_id: "B02", category: "SENSOR_CHECK", status: "REPAIRING" } },
      { fact_key: "TASK:TASK-3", subject_type: "TASK", last_known_at: "2026-09-14T09:25:00+08:00", known_snapshot: { equipment_id: "C01", category: "HANDOFF_TASK", status: "DEFERRED" } },
      { fact_key: "TASK:TASK-4", subject_type: "TASK", last_known_at: "2026-09-14T09:30:00+08:00", known_snapshot: { equipment_id: "D01", category: "TOOLS_AND_PARTS", status: "DONE", completed_at: "2026-09-14T09:30:00+08:00" } }
    ]
  });
  const sync = prepareWorkSyncContext(at("09:35"));
  assert.match(sync.context, /D01 工具与备件整理完成/);
  assert.match(sync.context, /C01 交接事项暂缓，待继续/);
  assert.match(sync.context, /正在处理B02 传感器检查/);
  assert.doesNotMatch(sync.context, /A02 例行检查完成/);
  assert.doesNotMatch(sync.context, /SECRET_WORLD_EVENT|WORLD-UNKNOWN/);
});

test("已发生 Daily Life 可同步，未来 Daily Life 不可见", () => {
  reset();
  const initial = prepareWorkSyncContext(at("09:00"));
  markWorkSyncDelivered(initial.cursor, at("09:00"));
  update(paths.daily, { schema_version: 1, events: [
    { event_id: "LIFE-1", date: "2026-09-14", category: "BREAK", summary: "上午有一次短暂休息。", occurred_at: "2026-09-14T10:00:00+08:00" },
    { event_id: "LIFE-FUTURE", date: "2026-09-14", category: "LUNCH", summary: "未来午餐不应出现。", occurred_at: "2026-09-14T12:00:00+08:00" }
  ] });
  const sync = prepareWorkSyncContext(at("10:30"));
  assert.match(sync.context, /上午有一次短暂休息/);
  assert.doesNotMatch(sync.context, /未来午餐/);
});

test("跨班次边界会同步，午休无真实事件时不规定具体生活行为", () => {
  reset();
  const morning = prepareWorkSyncContext(at("11:59"));
  markWorkSyncDelivered(morning.cursor, at("11:59"));
  const lunch = prepareWorkSyncContext(at("12:00"));
  assert.match(lunch.context, /已进入午休[\s\S]*当前工作状态：午休[\s\S]*下午班开始：14:30/);
  assert.doesNotMatch(lunch.context, /resting|eating|chatting|reading_manual|BREAK_ROOM|CAFETERIA/);
});

test("同步纸条为 transient，读取不改 Work、Knowledge、Wake 或工时文件", () => {
  reset();
  const before = snapshotFiles();
  const sync = prepareWorkSyncContext(at("09:00"));
  assert.match(sync.context, /【工作同步】/);
  assertFilesUnchanged(before);
  const messages = [{ role: "system", content: "人格" }, { role: "user", content: "你好" }];
  const forWake = insertTransientCurrentWorkContext(messages, sync.context);
  const forKelivo = insertTransientCurrentWorkContext(messages, sync.context);
  assert.deepEqual(forWake, forKelivo);
  assert.equal(messages.length, 2);
});

test("Wake 与 Kelivo 使用独立 cursor，旧全局 cursor 不会吞掉首次同步", () => {
  reset();
  const legacy = { schema_version: 1, state_signature: "OLD", last_synced_at: "2026-09-14T08:59:00+08:00" };
  update(paths.legacyCursor, legacy);

  const wakeFirst = prepareWorkSyncContext(at("09:00"), { channel: "wake" });
  assert.match(wakeFirst.context, /^【工作同步】/);
  assert.equal(wakeFirst.cursor.channel, "wake");
  markWorkSyncDelivered(wakeFirst.cursor, at("09:00"), "wake");
  assert.ok(fs.existsSync(paths.wakeCursor));
  assert.equal(fs.existsSync(paths.kelivoCursor), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.legacyCursor, "utf8")), legacy);
  assert.equal(prepareWorkSyncContext(at("09:05"), { channel: "wake" }).context, "");

  const kelivoFirst = prepareWorkSyncContext(at("09:05"), { channel: "kelivo" });
  assert.match(kelivoFirst.context, /^【工作同步】/);
  assert.equal(kelivoFirst.cursor.channel, "kelivo");
  markWorkSyncDelivered(kelivoFirst.cursor, at("09:05"), "kelivo");
  assert.ok(fs.existsSync(paths.kelivoCursor));
  assert.equal(JSON.parse(fs.readFileSync(paths.wakeCursor, "utf8")).channel, "wake");
  assert.equal(JSON.parse(fs.readFileSync(paths.kelivoCursor, "utf8")).channel, "kelivo");
});

test("Work Sync 事实边界仅随实际注入的纸条出现", () => {
  reset();
  const first = prepareWorkSyncContext(at("09:00"), { channel: "kelivo" });
  assert.match(first.context, /事实边界：[\s\S]*未提供的具体同事、设备、故障、步骤、结果或评价/);
  markWorkSyncDelivered(first.cursor, at("09:00"), "kelivo");
  const unchanged = prepareWorkSyncContext(at("09:05"), { channel: "kelivo" });
  assert.equal(unchanged.context, "");
  assert.equal(unchanged.cursor, null);
});

test("构建同步不会推进任一 cursor，只有成功路径显式标记时才写入", () => {
  reset();
  const wake = prepareWorkSyncContext(at("09:00"), { channel: "wake" });
  const kelivo = prepareWorkSyncContext(at("09:00"), { channel: "kelivo" });
  assert.equal(fs.existsSync(paths.wakeCursor), false);
  assert.equal(fs.existsSync(paths.kelivoCursor), false);
  markWorkSyncDelivered(kelivo.cursor, at("09:00"), "kelivo");
  assert.equal(fs.existsSync(paths.wakeCursor), false);
  assert.ok(fs.existsSync(paths.kelivoCursor));
  assert.match(wake.context, /^【工作同步】/);
});

test("BREAK_ROOM 地点认知由 Wake 和 Kelivo 各自同步一次，且不泄露个人设施", () => {
  reset();
  const wakeInitial = prepareWorkSyncContext(at("09:00"), { channel: "wake" });
  const kelivoInitial = prepareWorkSyncContext(at("09:00"), { channel: "kelivo" });
  markWorkSyncDelivered(wakeInitial.cursor, at("09:00"), "wake");
  markWorkSyncDelivered(kelivoInitial.cursor, at("09:00"), "kelivo");

  update(paths.knowledge, {
    schema_version: 1,
    facts: [{
      knowledge_id: "KN-000001",
      fact_key: "LOCATION_DISCOVERED:BREAK_ROOM",
      subject_type: "LOCATION",
      source_event_id: null,
      source_task_id: null,
      source_location_id: "BREAK_ROOM",
      channel: "DIRECT_LOCATION",
      learned_at: "2026-09-14T10:00:00+08:00",
      last_known_at: "2026-09-14T10:00:00+08:00",
      known_snapshot: { location_id: "BREAK_ROOM", label: "厂内休息室" }
    }]
  });

  const wake = prepareWorkSyncContext(at("10:05"), { channel: "wake" });
  const kelivo = prepareWorkSyncContext(at("10:05"), { channel: "kelivo" });
  for (const sync of [wake, kelivo]) {
    assert.match(sync.context, /已熟悉：厂内休息室/);
    assert.doesNotMatch(sync.context, /SHANE_BED_04|SHANE_LOCKER_04|personal_facilities|known_location_ids/);
  }

  markWorkSyncDelivered(wake.cursor, at("10:05"), "wake");
  assert.equal(prepareWorkSyncContext(at("10:06"), { channel: "wake" }).context, "");
  assert.match(prepareWorkSyncContext(at("10:06"), { channel: "kelivo" }).context, /已熟悉：厂内休息室/);

  markWorkSyncDelivered(kelivo.cursor, at("10:06"), "kelivo");
  assert.equal(prepareWorkSyncContext(at("10:07"), { channel: "kelivo" }).context, "");
});

test("基础厂区认知由 Wake 和 Kelivo 独立同步，且只输出窄摘要", () => {
  reset();
  const wakeInitial = prepareWorkSyncContext(at("09:00"), { channel: "wake" });
  const kelivoInitial = prepareWorkSyncContext(at("09:00"), { channel: "kelivo" });
  markWorkSyncDelivered(wakeInitial.cursor, at("09:00"), "wake");
  markWorkSyncDelivered(kelivoInitial.cursor, at("09:00"), "kelivo");

  update(paths.knowledge, {
    schema_version: 1,
    facts: [{
      knowledge_id: "KN-000002",
      fact_key: "ONBOARDING:CORE_FACILITY_AWARENESS",
      subject_type: "FACILITY",
      source_onboarding_id: "SHANE-ONBOARDING-2026-09-08",
      channel: "DIRECT_ONBOARDING",
      learned_at: "2026-09-09T17:00:00+08:00",
      last_known_at: "2026-09-14T10:00:00+08:00",
      known_snapshot: { label: "生产区域、维修间、仓库、安全出口及主要设备区域的基本划分" }
    }]
  });

  const wake = prepareWorkSyncContext(at("10:05"), { channel: "wake" });
  const kelivo = prepareWorkSyncContext(at("10:05"), { channel: "kelivo" });
  for (const sync of [wake, kelivo]) {
    assert.match(sync.context, /已熟悉：生产区域、维修间、仓库、安全出口及主要设备区域的基本划分/);
    assert.doesNotMatch(sync.context, /WAREHOUSE|SAFETY_EXIT|方向|路线/);
  }

  markWorkSyncDelivered(wake.cursor, at("10:05"), "wake");
  assert.equal(prepareWorkSyncContext(at("10:06"), { channel: "wake" }).context, "");
  assert.match(prepareWorkSyncContext(at("10:06"), { channel: "kelivo" }).context, /已熟悉：生产区域、维修间、仓库、安全出口及主要设备区域的基本划分/);
  markWorkSyncDelivered(kelivo.cursor, at("10:06"), "kelivo");
  assert.equal(prepareWorkSyncContext(at("10:07"), { channel: "kelivo" }).context, "");
});

test("Work Sync 重建今天已知经历：只保留已知完成事实与已完成 routine work，且不重复近期", () => {
  reset();
  const initial = prepareWorkSyncContext(at("09:00"));
  markWorkSyncDelivered(initial.cursor, at("09:00"));
  update(paths.knowledge, { schema_version: 1, facts: [
    { fact_key: "TASK:TASK-1", subject_type: "TASK", last_known_at: "2026-09-14T09:20:00+08:00", known_snapshot: { equipment_id: "A02", category: "PLANNED_INSPECTION", status: "DONE", completed_at: "2026-09-14T09:20:00+08:00" } },
    { fact_key: "EVENT:EVT-RESOLVED", subject_type: "EVENT", last_known_at: "2026-09-14T09:25:00+08:00", known_snapshot: { equipment_id: "B02", category: "SENSOR_CHECK", status: "RESOLVED", resolved_at: "2026-09-14T09:25:00+08:00" } },
    { fact_key: "EVENT:EVT-ACTIVE", subject_type: "EVENT", last_known_at: "2026-09-14T09:26:00+08:00", known_snapshot: { equipment_id: "C02", category: "SENSOR_CHECK", status: "REPAIRING" } }
  ] });
  update(paths.routine, { schema_version: 1, records: [
    { id: "ROUTINE-1", activity_type: "organizing_tools", equipment_id: null, with: [], started_at: "2026-09-14T09:25:00+08:00", completed_at: "2026-09-14T09:45:00+08:00", result: "NORMAL" },
    { id: "ROUTINE-2", activity_type: "inspection", equipment_id: "A03", with: ["george_nelson"], started_at: "2026-09-14T09:50:00+08:00", completed_at: "2026-09-14T10:20:00+08:00", result: "NORMAL" },
    { id: "ROUTINE-FUTURE", activity_type: "reading_manual", equipment_id: "C01", with: [], started_at: "2026-09-14T11:30:00+08:00", completed_at: "2026-09-14T12:00:00+08:00", result: "NORMAL" }
  ] });
  const sync = prepareWorkSyncContext(at("10:30"));
  assert.match(sync.context, /今天已发生：/);
  assert.match(sync.context, /B02 传感器检查处理完成/);
  assert.match(sync.context, /整理常用维修工具与备件/);
  assert.match(sync.context, /完成 A03 例行检查，未发现需要处理的异常。\（与 George\）/);
  assert.doesNotMatch(sync.context, /C01|ROUTINE-FUTURE|WORLD-UNKNOWN|SECRET_WORLD_EVENT|李师傅|老手|师傅/);
  assert.equal((sync.context.match(/A02 例行检查完成/g) || []).length, 1);

  markWorkSyncDelivered(sync.cursor, at("10:30"));
  const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
  state.activity = "waiting";
  update(paths.state, state);
  const later = prepareWorkSyncContext(at("10:35"));
  assert.match(later.context, /今天已发生：[\s\S]*整理常用维修工具与备件/);
});

test("基础认知独立于 Work Sync cursor：无 delta 时仍可作为 transient 上下文插入", () => {
  reset();
  const baseline = buildBaselineAwarenessContext({
    state: { company: "星果食品有限公司", role: "设备维修技师" },
    knowledge: { facts: [{ fact_key: "ONBOARDING:MEAL_BENEFIT_AWARENESS" }, { fact_key: "LOCATION_DISCOVERED:CAFETERIA" }] }
  });
  const initial = prepareWorkSyncContext(at("09:00"));
  markWorkSyncDelivered(initial.cursor, at("09:00"));
  const unchanged = prepareWorkSyncContext(at("09:05"));
  assert.equal(unchanged.context, "");
  const before = snapshotFiles();
  const messages = [{ role: "system", content: "人格" }, { role: "user", content: "新窗口第一条消息" }];
  const injected = insertTransientCurrentWorkContext(messages, [baseline, buildObjectiveFactBoundaryContext()].join("\n\n"));
  assert.match(injected.at(-2).content, /^【工作基础】[\s\S]*免费早餐07:45-09:00、午餐11:30-14:00[\s\S]*员工餐厅/);
  assert.match(injected.at(-2).content, /【事实边界】[\s\S]*未提供的餐食、品质或工作经历不视为已发生/);
  assertFilesUnchanged(before);
  assert.equal(fs.existsSync(paths.kelivoCursor), true);
  assert.equal(fs.existsSync(paths.wakeCursor), false);
});

test("Today Known Experience 至多四条，未来和未知 world 事实不会进入", () => {
  reset();
  const experience = buildTodayKnownExperience({ now: at("10:30"), knowledge: { facts: [] }, routineWork: { records: [
    { id: "R1", activity_type: "inspection", equipment_id: "A01", with: [], started_at: "2026-09-14T08:30:00+08:00", completed_at: "2026-09-14T08:50:00+08:00" },
    { id: "R2", activity_type: "inspection", equipment_id: "A02", with: [], started_at: "2026-09-14T08:55:00+08:00", completed_at: "2026-09-14T09:10:00+08:00" },
    { id: "R3", activity_type: "reading_manual", equipment_id: "A03", with: [], started_at: "2026-09-14T09:15:00+08:00", completed_at: "2026-09-14T09:35:00+08:00" },
    { id: "R4", activity_type: "organizing_tools", equipment_id: null, with: [], started_at: "2026-09-14T09:40:00+08:00", completed_at: "2026-09-14T10:00:00+08:00" },
    { id: "R5", activity_type: "inspection", equipment_id: "B01", with: [], started_at: "2026-09-14T10:05:00+08:00", completed_at: "2026-09-14T10:20:00+08:00" },
    { id: "RF", activity_type: "inspection", equipment_id: "C01", with: [], started_at: "2026-09-14T11:00:00+08:00", completed_at: "2026-09-14T11:30:00+08:00" }
  ] } });
  assert.equal(experience.length, 4);
  assert.ok(experience.some(item => item.text.includes("B01")));
  assert.ok(experience.every(item => !item.text.includes("C01")));
});
