const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTodayContext } = require("../shane_work/context_builder");

test("Wake 使用当天 Today Context，不泄漏次日事件", () => {
  const context = buildTodayContext({
    dailyLife: { events: [
      { event_id: "LIFE-TODAY", date: "2026-09-08", summary: "当天有一次短暂休息。" },
      { event_id: "LIFE-TOMORROW", date: "2026-09-09", summary: "次日事件不应出现。" }
    ] },
    date: "2026-09-08"
  });
  assert.match(context, /## 今日经历/);
  assert.match(context, /当天有一次短暂休息/);
  assert.doesNotMatch(context, /次日事件/);
});

test("Wake 无当天生活事件时不生成 Today Context", () => {
  assert.equal(buildTodayContext({ dailyLife: { events: [] }, date: "2026-09-08" }), "");
});
