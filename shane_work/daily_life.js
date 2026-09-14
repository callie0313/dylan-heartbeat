const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const { getDatePartsInTimeZone, resolveTimeZone } = require("../time_utils");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const FILE = path.join(WORK_DIR, "daily_life.json");
const TIME_ZONE = resolveTimeZone();

const DEFINITIONS = [
  {
    category: "BREAKFAST",
    probability: 12,
    cooldownDays: 2,
    availableMinute: 7 * 60 + 45,
    availableUntilMinute: 9 * 60,
    summaryOptions: [
      "早餐时段在员工餐厅吃了早餐。",
      "早餐时碰到同事，简单打了招呼。",
      "今天早餐有一样东西意外不错。"
    ],
    weekdaysOnly: true
  },
  { category: "LUNCH", probability: 22, cooldownDays: 2, availableMinute: 720, summary: "午餐时段有一顿正常的员工餐。", weekdaysOnly: true },
  { category: "BREAK", seedKey: "COMMUTE_HOME", probability: 18, cooldownDays: 3, availableMinute: 600, summary: "工厂工作时段出现了一次正常的短暂休息。", weekdaysOnly: true },
  { category: "WEATHER_CHANGE", probability: 10, cooldownDays: 2, availableMinute: 510, summary: "当天出现了轻微天气变化。", weekdaysOnly: false },
  { category: "COWORKER_ENCOUNTER", probability: 14, cooldownDays: 2, availableMinute: 630, summary: "在日常活动中偶遇一位同事。", weekdaysOnly: true },
  { category: "SMALL_INCIDENT", probability: 4, cooldownDays: 5, availableMinute: 900, summary: "发生了一件很小的日常插曲。", weekdaysOnly: true }
];

function emptyStore() { return { schema_version: 1, events: [] }; }
function loadDailyLife() {
  if (!fs.existsSync(FILE)) return emptyStore();
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return value && Array.isArray(value.events) ? { schema_version: 1, events: value.events } : emptyStore();
  } catch (error) {
    console.error("Daily Life 读取 daily_life.json 失败:", error.message);
    return emptyStore();
  }
}
function saveDailyLife(store) { fs.mkdirSync(WORK_DIR, { recursive: true }); writeJsonAtomicSync(FILE, store); }
function dateKey(now) {
  const parts = getDatePartsInTimeZone(now, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function localMinutes(now) { const parts = getDatePartsInTimeZone(now, TIME_ZONE); return Number(parts.hour) * 60 + Number(parts.minute); }
function weekday(date) { return new Date(`${date}T00:00:00Z`).getUTCDay(); }
function hashText(value) { let hash = 0; for (const char of String(value)) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0; return hash; }
function dayDistance(left, right) { return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86400000); }

function isCoolingDown(events, definition, date) {
  return events.some(event => event.category === definition.category && dayDistance(event.date, date) < definition.cooldownDays);
}

function summaryFor(definition, date) {
  if (!Array.isArray(definition.summaryOptions) || !definition.summaryOptions.length) return definition.summary;
  return definition.summaryOptions[hashText(`${date}|daily-life-summary|${definition.category}`) % definition.summaryOptions.length];
}

function ticksDailyLife(now = new Date(), state = null) {
  const date = dateKey(now);
  const store = loadDailyLife();
  const day = weekday(date);
  const minutes = localMinutes(now);
  const created = [];
  const existingCount = store.events.filter(event => event.date === date).length;
  for (const definition of DEFINITIONS) {
    if (existingCount + created.length >= 2) break;
    if (store.events.some(event => event.date === date && event.category === definition.category)) continue;
    if (definition.weekdaysOnly && (day === 0 || day === 6)) continue;
    if (minutes < definition.availableMinute) continue;
    if (definition.availableUntilMinute != null && minutes > definition.availableUntilMinute) continue;
    if (isCoolingDown(store.events, definition, date)) continue;
    if (hashText(`${date}|daily-life|${definition.seedKey || definition.category}`) % 100 >= definition.probability) continue;
    created.push({
      event_id: `LIFE-${date.replace(/-/g, "")}-${String(existingCount + created.length + 1).padStart(3, "0")}`,
      date,
      category: definition.category,
      importance: "LOW",
      summary: summaryFor(definition, date),
      created_at: now.toISOString(),
      occurred_at: now.toISOString()
    });
  }
  if (created.length) {
    store.events.push(...created);
    saveDailyLife(store);
  }
  return { date, events: store.events.filter(event => event.date === date), created, changed: created.length > 0 };
}

function isDailyLifeEventVisible(event, now = new Date()) {
  if (!event || event.date !== dateKey(now)) return false;
  const definition = DEFINITIONS.find(item => item.category === event.category);
  if (definition && localMinutes(now) < definition.availableMinute) return false;
  if (event.occurred_at && new Date(event.occurred_at) > now) return false;
  return true;
}

module.exports = { ticksDailyLife, loadDailyLife, saveDailyLife, dateKey, DEFINITIONS, isDailyLifeEventVisible };
