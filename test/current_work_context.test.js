const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCurrentWorkContext,
  getEffectiveCurrentState,
  insertTransientCurrentWorkContext,
  stateSyncSignature
} = require("../shane_work/context_builder");
const { getScheduleState } = require("../shane_work/shane_work");

const base = {
  work_state: "ON_DUTY",
  activity: "inspection",
  location: "A区",
  with: [],
  onboarding_phase: "NORMAL",
  is_workday: true,
  on_call: false,
  work_session: null
};

function at(time) { return new Date(`2026-09-14T${time}:00+08:00`); }
function context(time, state = base, isOnLeave = false) {
  return buildCurrentWorkContext({ state, dailyLife: { events: [] }, now: at(time), isOnLeave });
}

test("普通工作日最近班次边界无 off-by-one", () => {
  assert.match(context("08:29", { ...base, work_state: "OFF_DUTY" }), /正在前往工作地点[\s\S]*距离上班：1分钟[\s\S]*尚未到厂/);
  assert.match(context("08:30"), /工作状态：工作中[\s\S]*当前班次结束：12:00/);
  assert.match(context("11:59"), /距离午休：1分钟/);
  assert.match(context("12:00", { ...base, work_state: "LUNCH", activity: "eating", location: "CAFETERIA" }), /工作状态：午休[\s\S]*下午班开始：14:30/);
  assert.match(context("14:29", { ...base, work_state: "LUNCH" }), /距离下午上班：1分钟/);
  assert.match(context("14:30"), /工作状态：工作中[\s\S]*当前班次结束：17:30/);
  assert.match(context("17:29"), /距离正常下班：1分钟/);
  assert.match(context("17:30", { ...base, work_state: "OFF_DUTY", activity: "off_duty", location: "OFF_SITE" }), /工作状态：已下班[\s\S]*正常班次已结束/);
});

test("工作日班前准备与通勤只读投影准确，并进入独立同步签名", () => {
  assert.equal(getScheduleState(at("08:14")).workState, "OFF_DUTY");
  assert.equal(getScheduleState(at("08:15")).workState, "PRE_WORK");
  assert.equal(getScheduleState(at("08:19")).workState, "PRE_WORK");
  assert.equal(getScheduleState(at("08:20")).workState, "COMMUTING_TO_WORK");
  assert.equal(getScheduleState(at("08:29")).workState, "COMMUTING_TO_WORK");
  assert.equal(getScheduleState(at("08:30")).workState, "ON_DUTY");

  const preWork = getEffectiveCurrentState({ state: { ...base, work_state: "OFF_DUTY" }, now: at("08:15") });
  const commute = getEffectiveCurrentState({ state: { ...base, work_state: "OFF_DUTY" }, now: at("08:20") });
  const onDuty = getEffectiveCurrentState({ state: { ...base, work_state: "OFF_DUTY" }, now: at("08:30") });
  assert.deepEqual([preWork.work_state, preWork.activity, preWork.location], ["PRE_WORK", "preparing_for_work", "OFF_SITE"]);
  assert.deepEqual([commute.work_state, commute.activity, commute.location], ["COMMUTING_TO_WORK", "commuting_to_work", "COMMUTE"]);
  assert.equal(onDuty.work_state, "ON_DUTY");
  assert.notEqual(stateSyncSignature(preWork, at("08:15")), stateSyncSignature(commute, at("08:20")));
  assert.notEqual(stateSyncSignature(commute, at("08:20")), stateSyncSignature(onDuty, at("08:30")));
  assert.match(context("08:20", { ...base, work_state: "OFF_DUTY" }), /正在前往工作地点[\s\S]*尚未到厂/);
});

test("周末、请假与已有特殊工作段优先于班前通勤", () => {
  const weekend = new Date("2026-09-13T08:20:00+08:00");
  assert.equal(getScheduleState(weekend).workState, "OFF_DUTY");
  assert.equal(getScheduleState(at("08:20"), true).workState, "LEAVE");
  const calledOut = getEffectiveCurrentState({
    state: { ...base, work_state: "OFF_DUTY", work_session: { type: "CALL_OUT", session_id: "CALL-1" } },
    now: at("08:20")
  });
  assert.equal(calledOut.work_state, "CALLED_OUT");
});

test("滞后的 ON_DUTY state 在 17:31 只读投影为安全下班状态", () => {
  const effective = getEffectiveCurrentState({ state: base, now: at("17:31") });
  assert.equal(effective.work_state, "OFF_DUTY");
  assert.equal(effective.activity, "off_duty");
  assert.equal(effective.location, "OFF_SITE");
});

test("LEAVE、OVERTIME、CALLED_OUT 与 on-call 使用最终状态优先级", () => {
  assert.match(context("09:00", base, true), /工作状态：请假[\s\S]*今日请假/);
  const overtime = { ...base, work_state: "OVERTIME", work_session: { type: "OVERTIME", deadline_at: "2026-09-14T19:30:00+08:00" } };
  assert.match(context("18:00", overtime), /加班中[\s\S]*安全截止/);
  assert.doesNotMatch(context("18:00", overtime), /正常班次已结束/);
  const calledOut = { ...base, work_state: "CALLED_OUT", work_session: { type: "CALL_OUT", deadline_at: "2026-09-14T22:00:00+08:00" } };
  assert.match(context("20:00", calledOut), /被召回工作中[\s\S]*当前处于召回工作/);
  const onCall = { ...base, work_state: "OFF_DUTY", activity: "off_duty", location: "OFF_SITE", on_call: true };
  assert.match(context("18:00", onCall), /值班轮值：是（当前未被召回）[\s\S]*正常班次已结束/);
});

test("周末只显示非工作日，不计算下一班次", () => {
  const result = buildCurrentWorkContext({ state: base, dailyLife: { events: [] }, now: new Date("2026-09-13T09:00:00+08:00") });
  assert.match(result, /今日非工作日/);
  assert.doesNotMatch(result, /下一班次开始|距离上班/);
});

test("transient context 位于最后 user 前且不会累积或改写原消息", () => {
  const original = [{ role: "system", content: "人格" }, { role: "assistant", content: "旧回复" }, { role: "user", content: "新消息" }];
  const work = context("09:00");
  const first = insertTransientCurrentWorkContext(original, work);
  const second = insertTransientCurrentWorkContext(first, work);
  assert.equal(original.length, 3);
  assert.equal(first.at(-2).role, "system");
  assert.equal(first.at(-1).content, "新消息");
  assert.equal(second.filter(message => /^(## 当前工作上下文|【工作同步】)/.test(String(message.content))).length, 1);
});

test("最近完成与已确定后续只使用 Shane 已知的窄事实", () => {
  const knowledge = {
    facts: [
      {
        fact_key: "TASK:TASK-000001",
        subject_type: "TASK",
        last_known_at: "2026-09-14T15:20:00+08:00",
        known_snapshot: { equipment_id: "A02", category: "PLANNED_INSPECTION", status: "DONE", completed_at: "2026-09-14T15:10:00+08:00" }
      },
      {
        fact_key: "EVENT:EVT-000002",
        subject_type: "EVENT",
        last_known_at: "2026-09-14T15:20:00+08:00",
        known_snapshot: { equipment_id: "B02", category: "SENSOR_CHECK", status: "RECHECK" }
      }
    ]
  };
  const result = buildCurrentWorkContext({ state: base, knowledge, dailyLife: { events: [] }, now: at("15:20") });
  assert.match(result, /最近完成：A02 例行检查已完成/);
  assert.match(result, /已确定后续：B02 传感器检查待复查/);
  assert.doesNotMatch(result, /EVT-UNKNOWN|George 私下处理/);
});

test("最近完成按实际完成时间排序，而不是后续 knowledge 同步时间", () => {
  const knowledge = {
    facts: [
      { fact_key: "TASK:TASK-OLDER", subject_type: "TASK", last_known_at: "2026-09-14T16:00:00+08:00", known_snapshot: { equipment_id: "A01", category: "PLANNED_INSPECTION", status: "DONE", completed_at: "2026-09-14T14:00:00+08:00" } },
      { fact_key: "EVENT:EVT-NEWER", subject_type: "EVENT", last_known_at: "2026-09-14T16:00:00+08:00", known_snapshot: { equipment_id: "B02", category: "SENSOR_CHECK", status: "RESOLVED", resolved_at: "2026-09-14T15:30:00+08:00" } }
    ]
  };
  const result = buildCurrentWorkContext({ state: base, knowledge, dailyLife: { events: [] }, now: at("16:00") });
  assert.match(result, /最近完成：B02 传感器检查已处理完成/);
  assert.doesNotMatch(result, /最近完成：A01/);
});

test("未知未来事项不会进入纸条，缺少确定后续时明确显示暂无", () => {
  const knownDone = {
    facts: [{
      fact_key: "EVENT:EVT-000010",
      subject_type: "EVENT",
      learned_at: "2026-09-14T14:00:00+08:00",
      last_known_at: "2026-09-14T14:30:00+08:00",
      known_snapshot: { equipment_id: "C02", category: "PUMP_OR_PNEUMATIC_CHECK", status: "RESOLVED" }
    }]
  };
  const result = buildCurrentWorkContext({ state: base, knowledge: knownDone, dailyLife: { events: [] }, now: at("15:20") });
  assert.match(result, /最近完成：C02 泵或气动检查已处理完成/);
  assert.match(result, /已确定后续：暂无/);
  assert.doesNotMatch(result, /未来随机故障|TASK-UNKNOWN/);
});
