const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const FILE = path.join(WORK_DIR, "wake_requests.json");
const WORK_WAKE_COOLDOWN_MS = 15 * 60 * 1000;
const IN_FLIGHT_TTL_MS = 15 * 60 * 1000;
const PENDING_MERGE_MS = 15 * 60 * 1000;

function emptyStore() {
  return { schema_version: 1, requests: [], last_work_wake_at: null };
}

function loadWakeRequests() {
  if (!fs.existsSync(FILE)) return emptyStore();
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return value && Array.isArray(value.requests) ? { ...emptyStore(), ...value } : emptyStore();
  } catch {
    return emptyStore();
  }
}

function saveWakeRequests(value) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(FILE, value);
}

function millisecondsSince(value, now) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? new Date(now).getTime() - timestamp : Infinity;
}

function queueWorkWake(store, eventId, factKey, now) {
  // 一个 event 只有一个 request 生命周期；COMPLETED 后也不再重新创建。
  if (store.requests.some(request => (request.source_event_ids || []).includes(eventId))) return false;

  let request = store.requests.find(item =>
    item.status === "PENDING" && millisecondsSince(item.created_at, now) <= PENDING_MERGE_MS
  );
  if (!request) {
    request = {
      request_id: `WORK-${eventId}`,
      source_event_ids: [],
      fact_keys: [],
      reason: "SERIOUS_KNOWN_EVENT",
      priority: "HIGH",
      created_at: now,
      status: "PENDING",
      last_attempt_at: null,
      in_flight_at: null,
      retry_after_at: null,
      completed_at: null,
      outcome: null
    };
    store.requests.push(request);
  }
  request.source_event_ids.push(eventId);
  request.fact_keys.push(factKey);
  return true;
}

function queueOnboardingWake(store, onboardingId, factKey, now) {
  // The Day 1 report has one request lifecycle, including after completion.
  if (store.requests.some(request => (request.source_onboarding_ids || []).includes(onboardingId))) return false;
  store.requests.push({ request_id: `WORK-${onboardingId}`, source_event_ids: [], source_onboarding_ids: [onboardingId], fact_keys: [factKey], reason: "ONBOARDING_DAY1_REPORT", priority: "NORMAL", created_at: now, status: "PENDING", last_attempt_at: null, in_flight_at: null, retry_after_at: null, completed_at: null, outcome: null });
  return true;
}
function recoverExpiredInFlight(store, now) {
  let changed = false;
  for (const request of store.requests) {
    if (request.status === "IN_FLIGHT" && millisecondsSince(request.in_flight_at, now) >= IN_FLIGHT_TTL_MS) {
      request.status = "PENDING";
      request.in_flight_at = null;
      request.retry_after_at = null;
      changed = true;
    }
  }
  return changed;
}

function selectDispatchableRequest(store, now) {
  if (store.last_work_wake_at && millisecondsSince(store.last_work_wake_at, now) < WORK_WAKE_COOLDOWN_MS) return null;
  return store.requests.find(request =>
    request.status === "PENDING" && (!request.retry_after_at || millisecondsSince(request.retry_after_at, now) >= 0)
  ) || null;
}

function markInFlight(request, now) {
  request.status = "IN_FLIGHT";
  request.in_flight_at = now;
  request.last_attempt_at = now;
  request.attempt_count = (request.attempt_count || 0) + 1;
}

function completeRequest(store, request, outcome, now) {
  request.status = "COMPLETED";
  request.outcome = outcome;
  request.completed_at = now;
  request.in_flight_at = null;
  request.retry_after_at = null;
  store.last_work_wake_at = now;
}

function retryRequest(request, error, now) {
  request.status = "PENDING";
  request.in_flight_at = null;
  request.retry_after_at = new Date(new Date(now).getTime() + WORK_WAKE_COOLDOWN_MS).toISOString();
  request.last_error = String(error && error.message ? error.message : error || "MODEL_FAILED").slice(0, 300);
}

module.exports = {
  WORK_WAKE_COOLDOWN_MS,
  loadWakeRequests,
  saveWakeRequests,
  queueWorkWake,
  queueOnboardingWake,
  recoverExpiredInFlight,
  selectDispatchableRequest,
  markInFlight,
  completeRequest,
  retryRequest
};
