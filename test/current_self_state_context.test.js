const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCurrentSelfStateContext } = require("../shane_work/context_builder");

test("current self-state context only exposes the narrow current state", () => {
  const context = buildCurrentSelfStateContext({
    state: {
      work_state: "LUNCH",
      activity: "resting",
      location: "BREAK_ROOM",
      with: [],
      onboarding_phase: "NORMAL",
      secret_event: "DO_NOT_LEAK"
    },
    currentTime: "2026-09-08 12:30"
  });
  assert.match(context, /工作状态：午休/);
  assert.match(context, /当前活动：resting/);
  assert.match(context, /位置：BREAK_ROOM/);
  assert.doesNotMatch(context, /DO_NOT_LEAK/);
  assert.doesNotMatch(context, /events\.json|tasks\.json|daily_life\.json/);
});
