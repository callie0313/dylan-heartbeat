const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-daily-life-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";
const { runtimeDirectory } = require("../runtime_paths");
const { ticksDailyLife, loadDailyLife, isDailyLifeEventVisible } = require("../shane_work/daily_life");
const { buildContext, buildTodayContext } = require("../shane_work/context_builder");
const FILE = path.join(runtimeDirectory("shane_work", "shane_work"), "daily_life.json");

function reset() { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.mkdirSync(path.dirname(FILE), { recursive: true }); }
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("同一天重复 tick 不重复写入 Daily Life 事件", () => {
  reset();
  const now = new Date("2026-09-08T08:30:00+08:00");
  const first = ticksDailyLife(now, {});
  const before = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : null;
  const second = ticksDailyLife(new Date("2026-09-08T15:00:00+08:00"), {});
  assert.equal(second.changed, false);
  assert.equal(second.events.length, first.events.length);
  assert.equal(fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : null, before);
});

test("重启重新加载后同一天结果一致，且没有事件日合法", () => {
  reset();
  const first = ticksDailyLife(new Date("2026-09-08T08:30:00+08:00"), {});
  delete require.cache[require.resolve("../shane_work/daily_life")];
  const reloaded = require("../shane_work/daily_life").ticksDailyLife(new Date("2026-09-08T15:00:00+08:00"), {});
  assert.deepEqual(reloaded.events, first.events);
  assert.ok(Array.isArray(loadDailyLife().events));
});

test("Daily Life 只进入独立存储，不自动进入窄 Context", () => {
  reset();
  const result = ticksDailyLife(new Date("2026-09-08T08:30:00+08:00"), {});
  const context = buildContext({ state: { current_date: "2026-09-09", current_time: "2026-09-09T08:30:00+08:00", onboarding_phase: "NORMAL", work_state: "ON_DUTY", activity: "waiting" }, dailyLife: { events: result.events }, knowledge: { facts: [] }, events: [], tasks: [] });
  assert.equal(context.includes("今日经历"), false);
  assert.equal(context.includes("生活："), false);
  assert.equal(fs.existsSync(path.join(DATA_DIR, "shane_work", "events.json")), false);
  assert.equal(fs.existsSync(path.join(DATA_DIR, "shane_work", "tasks.json")), false);
});

test("当天 Daily Life 可生成短期 Today Context，次日自动失效", () => {
  const dailyLife = { events: [
    { event_id: "LIFE-1", date: "2026-09-08", category: "LUNCH", summary: "午餐期间与George交流。", secret: "DO_NOT_LEAK" },
    { event_id: "LIFE-2", date: "2026-09-07", category: "BREAK", summary: "昨天的事件不应出现。" }
  ] };
  const today = buildTodayContext({ dailyLife, date: "2026-09-08" });
  assert.match(today, /## 今日经历/);
  assert.match(today, /午餐期间与George交流/);
  assert.doesNotMatch(today, /昨天的事件|DO_NOT_LEAK/);
  assert.equal(buildTodayContext({ dailyLife, date: "2026-09-09" }), "");
});

test("Today Context 不进入 Knowledge、不创建 Wake，也不读取 Work 数据", () => {
  const context = buildContext({
    state: { current_date: "2026-09-08", work_state: "ON_DUTY", activity: "waiting" },
    dailyLife: { events: [{ event_id: "LIFE-3", date: "2026-09-08", summary: "当天有一次短暂休息。" }] },
    knowledge: { facts: [] },
    events: [],
    tasks: []
  });
  assert.match(context, /今日经历/);
  assert.doesNotMatch(context, /events\.json|tasks\.json|wake_requests/);
});

test("LUNCH 不在上午提前生成，到达午餐窗口后才生成并可见", () => {
  reset();
  const morning = ticksDailyLife(new Date("2026-09-02T11:59:00+08:00"), {});
  assert.equal(morning.events.some(event => event.category === "LUNCH"), false);
  const noon = ticksDailyLife(new Date("2026-09-02T12:00:00+08:00"), {});
  const lunch = noon.events.find(event => event.category === "LUNCH");
  assert.ok(lunch);
  assert.ok(lunch.occurred_at);
  assert.equal(buildTodayContext({ dailyLife: { events: noon.events }, date: "2026-09-02", now: new Date("2026-09-02T11:59:00+08:00") }).includes(lunch.summary), false);
  assert.equal(buildTodayContext({ dailyLife: { events: noon.events }, date: "2026-09-02", now: new Date("2026-09-02T12:00:00+08:00") }).includes(lunch.summary), true);
});

test("BREAKFAST 只在早餐窗口后生成、可见，且不触碰 Work state 或工时", () => {
  reset();
  const state = { work_state: "OFF_DUTY", activity: "waiting", location: "OFF_SITE" };
  const before = ticksDailyLife(new Date("2026-09-02T07:44:00+08:00"), state);
  assert.equal(before.events.some(event => event.category === "BREAKFAST"), false);

  const afterService = ticksDailyLife(new Date("2026-09-02T09:01:00+08:00"), state);
  assert.equal(afterService.events.some(event => event.category === "BREAKFAST"), false);

  reset();
  const atBreakfast = ticksDailyLife(new Date("2026-09-02T07:45:00+08:00"), state);
  const breakfast = atBreakfast.events.find(event => event.category === "BREAKFAST");
  assert.ok(breakfast);
  assert.match(breakfast.summary, /早餐/);
  assert.equal(state.work_state, "OFF_DUTY");
  assert.equal(state.activity, "waiting");
  assert.equal(state.location, "OFF_SITE");
  assert.equal(fs.existsSync(path.join(DATA_DIR, "shane_work", "work_hours.json")), false);
  assert.equal(buildTodayContext({ dailyLife: { events: atBreakfast.events }, date: "2026-09-02", now: new Date("2026-09-02T07:45:00+08:00") }).includes(breakfast.summary), true);
  assert.equal(buildTodayContext({ dailyLife: { events: atBreakfast.events }, date: "2026-09-03", now: new Date("2026-09-03T08:00:00+08:00") }), "");
});

test("BREAKFAST 重启与重复 tick 不会生成重复事件", () => {
  reset();
  const now = new Date("2026-09-02T08:30:00+08:00");
  const first = ticksDailyLife(now, {});
  const firstBreakfast = first.events.filter(event => event.category === "BREAKFAST");
  assert.equal(firstBreakfast.length, 1);
  const before = fs.readFileSync(FILE, "utf8");
  delete require.cache[require.resolve("../shane_work/daily_life")];
  const reloaded = require("../shane_work/daily_life").ticksDailyLife(new Date("2026-09-02T08:59:00+08:00"), {});
  assert.equal(reloaded.events.filter(event => event.category === "BREAKFAST").length, 1);
  assert.equal(fs.readFileSync(FILE, "utf8"), before);
});

test("同日分时生成多个 category 时 ID 接续且不重复", () => {
  reset();
  const morning = ticksDailyLife(new Date("2026-09-21T10:00:00+08:00"), {});
  assert.ok(morning.events.some(event => event.category === "BREAK"));
  const noon = ticksDailyLife(new Date("2026-09-21T12:00:00+08:00"), {});
  assert.ok(noon.events.some(event => event.category === "LUNCH"));
  assert.equal(new Set(noon.events.map(event => event.event_id)).size, noon.events.length);
  assert.ok(noon.events.length <= 2);
});

test("所有 Daily Life category 都只在各自最早发生时间后可见", () => {
  const checks = [
    ["WEATHER_CHANGE", "08:29", "08:30"],
    ["BREAKFAST", "07:44", "07:45"],
    ["BREAK", "09:59", "10:00"],
    ["COWORKER_ENCOUNTER", "10:29", "10:30"],
    ["LUNCH", "11:59", "12:00"],
    ["SMALL_INCIDENT", "14:59", "15:00"]
  ];
  for (const [category, before, after] of checks) {
    const event = { date: "2026-09-14", category, summary: category };
    assert.equal(isDailyLifeEventVisible(event, new Date(`2026-09-14T${before}:00+08:00`)), false);
    assert.equal(isDailyLifeEventVisible(event, new Date(`2026-09-14T${after}:00+08:00`)), true);
  }
});
