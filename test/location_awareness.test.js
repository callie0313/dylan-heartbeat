const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-location-awareness-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");
const { tick } = require("../shane_work/shane_work");
const { loadKnowledge } = require("../shane_work/knowledge");
const { buildBaselineAwarenessContext } = require("../shane_work/context_builder");

function seedCompletedDay2() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.rmSync(path.join(WORK_DIR, "knowledge.json"), { force: true });
  writeJsonAtomicSync(STATE_PATH, {
    schema_version: 6,
    employment_started_at: "2026-09-08T08:30:00+08:00",
    onboarding_day: 2,
    onboarding_phase: "GUIDED",
    work_day_started_date: "2026-09-09",
    work_state: "OFF_DUTY",
    activity: "off_duty",
    location: "OFF_SITE",
    with: [],
    known_npc_ids: ["george_nelson", "erin_walker"],
    onboarding_session: {
      session_id: "SHANE-ONBOARDING-2026-09-08", status: "COMPLETED", active: false,
      history: [
        "ONBOARDING_DAY1_REPORT", "MEET_ERIN_AND_GEORGE", "LUNCH_DAY1", "FACTORY_ORIENTATION",
        "BASIC_WORK_TRAINING", "DAY1_REVIEW", "DAY1_COMPLETED", "DAY2_START", "SHADOW_GEORGE",
        "LUNCH_DAY2", "FIRST_PRACTICAL_TASK", "ONBOARDING_REVIEW", "ONBOARDING_COMPLETED"
      ].map(step_id => ({ step_id, occurred_at: "2026-09-09T17:00:00+08:00" }))
    },
    equipment: []
  });
  writeJsonAtomicSync(path.join(WORK_DIR, "events.json"), []);
  writeJsonAtomicSync(path.join(WORK_DIR, "tasks.json"), { schema_version: 1, tasks: [] });
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("旧 Day2 存档恢复已接触地点，但不自动获得 BREAK_ROOM", () => {
  seedCompletedDay2();
  const state = tick(new Date("2026-09-09T12:30:00+08:00"));
  assert.deepEqual(state.known_location_ids.sort(), ["CAFETERIA", "FACTORY_FLOOR", "MAINTENANCE_ROOM", "OFF_SITE", "SAFETY_EXIT", "WAREHOUSE"]);
  assert.notEqual(state.location, "BREAK_ROOM");
  assert.equal(state.onboarding_phase, "GUIDED");
});

test("Day3 首次午休由 George 带领认识 BREAK_ROOM，并持久化个人设施", () => {
  seedCompletedDay2();
  tick(new Date("2026-09-09T12:30:00+08:00"));
  const state = tick(new Date("2026-09-10T12:30:00+08:00"));
  assert.ok(state.known_location_ids.includes("BREAK_ROOM"));
  assert.deepEqual(state.personal_facilities, { rest_bed_id: "SHANE_BED_04", locker_id: "SHANE_LOCKER_04" });
  assert.equal(state.location, "BREAK_ROOM");
  assert.equal(state.activity, "chatting");
  assert.deepEqual(state.with, ["george_nelson"]);
  assert.equal(state.onboarding_phase, "NORMAL");
});

test("BREAK_ROOM 认知在重复 tick 后保持稳定且不创建新认知文件", () => {
  seedCompletedDay2();
  tick(new Date("2026-09-10T12:30:00+08:00"));
  const first = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const second = tick(new Date("2026-09-10T12:45:00+08:00"));
  assert.deepEqual(second.known_location_ids, first.known_location_ids);
  assert.deepEqual(second.personal_facilities, first.personal_facilities);
  assert.equal(fs.existsSync(path.join(WORK_DIR, "location_knowledge.json")), false);
});

test("首次认识 BREAK_ROOM 只建立一条窄地点认知事实", () => {
  seedCompletedDay2();
  tick(new Date("2026-09-10T12:30:00+08:00"));
  const facts = loadKnowledge().facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM");
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].known_snapshot, { location_id: "BREAK_ROOM", label: "厂内休息室" });
  assert.doesNotMatch(JSON.stringify(facts[0]), /SHANE_BED_04|SHANE_LOCKER_04|personal_facilities/);

  tick(new Date("2026-09-10T12:45:00+08:00"));
  assert.equal(loadKnowledge().facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM").length, 1);
});

test("首次认识 BREAK_ROOM 同步建立一次个人设施认知，并只在基础认知中窄暴露", () => {
  seedCompletedDay2();
  const state = tick(new Date("2026-09-10T12:30:00+08:00"));
  const facts = loadKnowledge().facts;
  const locationFact = facts.find(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM");
  const facilityFacts = facts.filter(fact => fact.fact_key === "PERSONAL_FACILITY_AWARENESS:BREAK_ROOM");
  assert.equal(facilityFacts.length, 1);
  assert.equal(facilityFacts[0].subject_type, "FACILITY");
  assert.equal(facilityFacts[0].learned_at, locationFact.learned_at);
  assert.deepEqual(facilityFacts[0].known_snapshot, {
    rest_bed_id: "SHANE_BED_04",
    locker_id: "SHANE_LOCKER_04",
    label: "4号休息床位和4号储物柜"
  });
  const baseline = buildBaselineAwarenessContext({ state, knowledge: loadKnowledge() });
  assert.match(baseline, /个人设施：4号休息床、4号储物柜/);
  assert.doesNotMatch(baseline, /SHANE_BED_04|SHANE_LOCKER_04|桌椅|饮水机|小冰箱|微波炉|插座/);

  tick(new Date("2026-09-10T12:45:00+08:00"));
  assert.equal(loadKnowledge().facts.filter(fact => fact.fact_key === "PERSONAL_FACILITY_AWARENESS:BREAK_ROOM").length, 1);
});

test("已有 BREAK_ROOM 的旧状态只补建一次地点认知事实", () => {
  seedCompletedDay2();
  const prior = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  prior.known_location_ids = ["CAFETERIA", "FACTORY_FLOOR", "MAINTENANCE_ROOM", "OFF_SITE", "BREAK_ROOM"];
  prior.personal_facilities = { rest_bed_id: "SHANE_BED_04", locker_id: "SHANE_LOCKER_04" };
  writeJsonAtomicSync(STATE_PATH, prior);

  tick(new Date("2026-09-10T10:00:00+08:00"));
  let facts = loadKnowledge().facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM");
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].known_snapshot, { location_id: "BREAK_ROOM", label: "厂内休息室" });

  tick(new Date("2026-09-10T10:30:00+08:00"));
  facts = loadKnowledge().facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM");
  assert.equal(facts.length, 1);
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  assert.ok(state.known_location_ids.includes("BREAK_ROOM"));
  assert.deepEqual(state.personal_facilities, prior.personal_facilities);
});

test("已有 BREAK_ROOM 和个人设施的旧状态只补建个人设施认知，并复用发现时间", () => {
  seedCompletedDay2();
  const prior = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  prior.known_location_ids = ["CAFETERIA", "FACTORY_FLOOR", "MAINTENANCE_ROOM", "OFF_SITE", "BREAK_ROOM"];
  prior.personal_facilities = { rest_bed_id: "SHANE_BED_04", locker_id: "SHANE_LOCKER_04" };
  prior.activity = "waiting";
  prior.location = "MAINTENANCE_ROOM";
  writeJsonAtomicSync(STATE_PATH, prior);
  writeJsonAtomicSync(path.join(WORK_DIR, "knowledge.json"), { schema_version: 1, facts: [{
    knowledge_id: "KN-000001", fact_key: "LOCATION_DISCOVERED:BREAK_ROOM", subject_type: "LOCATION",
    learned_at: "2026-09-09T12:30:00+08:00", last_known_at: "2026-09-09T12:30:00+08:00",
    known_snapshot: { location_id: "BREAK_ROOM", label: "厂内休息室" }
  }] });

  const state = tick(new Date("2026-09-10T10:00:00+08:00"));
  const facilityFact = loadKnowledge().facts.find(fact => fact.fact_key === "PERSONAL_FACILITY_AWARENESS:BREAK_ROOM");
  assert.equal(facilityFact.learned_at, "2026-09-09T12:30:00+08:00");
  assert.equal(state.location, "MAINTENANCE_ROOM");
  assert.notEqual(state.location, "BREAK_ROOM");
  assert.doesNotMatch(JSON.stringify(state.with), /george_nelson/);
  tick(new Date("2026-09-10T10:30:00+08:00"));
  assert.equal(loadKnowledge().facts.filter(fact => fact.fact_key === "PERSONAL_FACILITY_AWARENESS:BREAK_ROOM").length, 1);
});

test("已有 BREAK_ROOM 但缺个人设施的旧状态确定性补齐且不重放发现", () => {
  seedCompletedDay2();
  const prior = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  prior.known_location_ids = ["CAFETERIA", "FACTORY_FLOOR", "MAINTENANCE_ROOM", "OFF_SITE", "BREAK_ROOM"];
  prior.activity = "waiting";
  prior.location = "MAINTENANCE_ROOM";
  delete prior.personal_facilities;
  writeJsonAtomicSync(STATE_PATH, prior);
  writeJsonAtomicSync(path.join(WORK_DIR, "knowledge.json"), { schema_version: 1, facts: [{
    knowledge_id: "KN-000001", fact_key: "LOCATION_DISCOVERED:BREAK_ROOM", subject_type: "LOCATION",
    learned_at: "2026-09-09T12:30:00+08:00", last_known_at: "2026-09-09T12:30:00+08:00",
    known_snapshot: { location_id: "BREAK_ROOM", label: "厂内休息室" }
  }] });

  const state = tick(new Date("2026-09-10T10:00:00+08:00"));
  assert.deepEqual(state.personal_facilities, { rest_bed_id: "SHANE_BED_04", locker_id: "SHANE_LOCKER_04" });
  assert.equal(state.location, "MAINTENANCE_ROOM");
  assert.notEqual(state.location, "BREAK_ROOM");
  const facilityFact = loadKnowledge().facts.find(fact => fact.fact_key === "PERSONAL_FACILITY_AWARENESS:BREAK_ROOM");
  assert.equal(facilityFact.learned_at, "2026-09-09T12:30:00+08:00");
});
test("已完成 onboarding 的旧状态补齐基础厂区认知，但不自动获得 BREAK_ROOM", () => {
  seedCompletedDay2();
  const state = tick(new Date("2026-09-10T10:00:00+08:00"));
  for (const locationId of ["FACTORY_FLOOR", "MAINTENANCE_ROOM", "WAREHOUSE", "SAFETY_EXIT"]) {
    assert.ok(state.known_location_ids.includes(locationId));
  }
  assert.equal(state.known_location_ids.includes("BREAK_ROOM"), false);
  assert.equal(state.onboarding_session.status, "COMPLETED");
  const facts = loadKnowledge().facts.filter(fact => fact.fact_key === "ONBOARDING:CORE_FACILITY_AWARENESS");
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].known_snapshot, { label: "生产区域、维修间、仓库、安全出口及主要设备区域的基本划分" });

  tick(new Date("2026-09-10T10:30:00+08:00"));
  assert.equal(loadKnowledge().facts.filter(fact => fact.fact_key === "ONBOARDING:CORE_FACILITY_AWARENESS").length, 1);
});

test("已完成 onboarding 的旧状态只补建一次员工餐厅与工作餐福利认知", () => {
  seedCompletedDay2();
  tick(new Date("2026-09-10T10:00:00+08:00"));
  const facts = loadKnowledge().facts;
  const cafeteria = facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:CAFETERIA");
  const benefit = facts.filter(fact => fact.fact_key === "ONBOARDING:MEAL_BENEFIT_AWARENESS");
  assert.equal(cafeteria.length, 1);
  assert.deepEqual(cafeteria[0].known_snapshot, { location_id: "CAFETERIA", label: "员工餐厅" });
  assert.equal(cafeteria[0].learned_at, "2026-09-09T17:00:00+08:00");
  assert.equal(benefit.length, 1);
  assert.deepEqual(benefit[0].known_snapshot, {
    workdays_only: true,
    breakfast: "07:45-09:00",
    lunch: "11:30-14:00",
    included: ["基础餐食", "汤", "水", "咖啡", "茶"],
    free: true
  });
  tick(new Date("2026-09-10T10:30:00+08:00"));
  const repeated = loadKnowledge().facts;
  assert.equal(repeated.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:CAFETERIA").length, 1);
  assert.equal(repeated.filter(fact => fact.fact_key === "ONBOARDING:MEAL_BENEFIT_AWARENESS").length, 1);
});

test("基础认知只输出已知设施、福利和已知个人设施，不包含完整 fixtures", () => {
  const state = {
    company: "星果食品有限公司",
    role: "设备维修技师",
    onboarding_phase: "NORMAL"
  };
  const incomplete = buildBaselineAwarenessContext({ state, knowledge: { facts: [] } });
  assert.match(incomplete, /星果食品有限公司设备维修技师/);
  assert.doesNotMatch(incomplete, /员工餐厅|免费早餐|休息室/);
  assert.doesNotMatch(incomplete, /个人设施|4号休息床|4号储物柜/);

  const complete = buildBaselineAwarenessContext({ state, knowledge: { facts: [
    { fact_key: "ONBOARDING:CORE_FACILITY_AWARENESS" },
    { fact_key: "ONBOARDING:MEAL_BENEFIT_AWARENESS" },
    { fact_key: "LOCATION_DISCOVERED:CAFETERIA" },
    { fact_key: "LOCATION_DISCOVERED:BREAK_ROOM" },
    { fact_key: "PERSONAL_FACILITY_AWARENESS:BREAK_ROOM" }
  ] } });
  assert.match(complete, /正常班次08:30–12:00、14:30–17:30，12:00–14:30午休/);
  assert.match(complete, /免费早餐07:45-09:00、午餐11:30-14:00/);
  assert.match(complete, /已知：员工餐厅/);
  assert.match(complete, /已熟悉：厂内休息室/);
  assert.match(complete, /个人设施：4号休息床、4号储物柜/);
  assert.doesNotMatch(complete, /菜单|好吃|难吃|SHANE_BED_04|SHANE_LOCKER_04|厕所|桌椅|饮水机|小冰箱|微波炉|插座/);
});
