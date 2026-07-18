import {
  emptyHistory,
  emptyTaskStatuses,
  handleRequest as handleLegacyRequest,
  mergeHistory,
  mergeTaskStatuses,
  publicTaskStatuses,
} from "./index.mjs";
import {
  migrateLegacyState,
  putState,
  readState,
  updateState,
} from "./state.mjs";
import {
  DEFAULT_SETTINGS,
  beijingParts,
  nextTaskAt,
  normalizeSettings,
  scheduleSummaries,
  taskDue,
  taskSlot,
} from "./settings.mjs";
import {
  accountKey,
  checkinAccount,
  getBalance,
  getGwentStatus,
  normalizeAccounts,
  runAd,
  runQuiz,
  unlockAndDraw,
} from "./vsllm.mjs";
import {
  AccountConfigError,
  publicAccountConfiguration,
  runtimeAccountConfiguration,
  updateAccountConfiguration,
} from "./accounts.mjs";

const CONFIG_KEY = "newapi-config.json";
const HISTORY_KEY = "gwent-history-v1.json";
const LEGACY_SCHEDULE_KEY = "gwent-schedule-v1.json";
const TASK_STATUS_KEYS = Object.freeze({
  checkin: "gwent-task-status-checkin-v1.json",
  quiz: "gwent-task-status-quiz-v1.json",
  ad: "gwent-task-status-ad-v1.json",
});
const SETTINGS_KEY = "automation-settings-v1.json";
const NOTIFICATION_CONFIG_KEY = "notification-config-v1.json";
const KNOWN_LEGACY_KEYS = Object.freeze([
  CONFIG_KEY,
  HISTORY_KEY,
  LEGACY_SCHEDULE_KEY,
  "gwent-task-status-quiz-v1.json",
  "gwent-task-status-ad-v1.json",
]);
const LEGACY_API_PATHS = new Set([
  "/api/config",
  "/api/gwent/history",
  "/api/gwent/schedule",
  "/api/gwent/task-status",
]);
const LEGACY_WRITE_METHODS = Object.freeze({
  "/api/config": "PUT",
  "/api/gwent/history": "POST",
  "/api/gwent/schedule": "POST",
  "/api/gwent/task-status": "POST",
});
const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});
const STATIC_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const MAX_BODY_BYTES = 128 * 1024;
const ACCOUNT_LOCK_SECONDS = 4 * 60;
const SCHEDULE_LEASE_SECONDS = 12 * 60;
const MAX_MANUAL_IDEMPOTENCY_LENGTH = 64;
const MAX_REQUESTED_ACCOUNTS = 100;
const MAX_REWARD_QUEUE_ITEMS = 128;
const HISTORY_BATCH_SIZE = 100;
const DEFAULT_HISTORY_PAGE_SIZE = 20;
const MAX_HISTORY_PAGE_SIZE = 100;
const MANUAL_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,63}$/u;
const ACCOUNT_KEY_PATTERN = /^[a-f0-9]{16}$/u;
const HISTORY_SOURCE_FILTERS = new Set(["draw", "gwent", "checkin", "quiz", "ad"]);
const INSERT_AUTOMATION_RUN_SQL = `
  INSERT OR IGNORE INTO automation_runs (
    run_id, run_number, run_attempt, started_at, finished_at, planned_draws,
    status, source, trigger, account_count, successful_draws, total_quota
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const INSERT_AUTOMATION_EVENT_SQL = `
  INSERT OR IGNORE INTO automation_events (
    event_id, run_id, account_key, account_name, attempt, occurred_at,
    local_date, status, prize_name, prize_quota, prize_rarity,
    bonus_percent, message, task_type
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function errorResponse(error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal_error";
  const message = error instanceof HttpError ? error.message : "服务器暂时无法完成请求。";
  const payload = { error: { code, message } };
  if (error instanceof HttpError && error.details !== undefined) {
    payload.error.details = error.details;
  }
  if (!(error instanceof HttpError)) {
    console.error(JSON.stringify({ event: "request_error", error: safeError(error) }));
  }
  return json(payload, status);
}

function safeError(error) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/giu, "$1?[redacted]")
    .replace(
      /(?:authorization|cookie|session|token|password|access_token|sign|cf_clearance)\s*(?::|=)\s*(?:bearer\s+)?[^\s,;]+/giu,
      "***",
    )
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer ***")
    .slice(0, 500);
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "请求体过大。 ");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "请求体过大。 ");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体必须是有效 JSON。 ");
  }
}

async function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(leftHash, rightHash);
  }
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function requireAdmin(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthorized", "需要管理令牌。 ");
  }
  const provided = authorization.slice(7);
  const configured = env.ADMIN_TOKEN;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new HttpError(500, "admin_not_configured", "尚未配置管理令牌。 ");
  }
  const token = configured.startsWith("token:") ? configured.slice(6) : configured;
  if (!(await timingSafeEqual(provided, token))) {
    throw new HttpError(401, "unauthorized", "管理令牌不正确。 ");
  }
}

function stateKvAdapter(env) {
  return {
    async get(key) {
      const state = await readState(env, key);
      return state === null ? null : JSON.stringify(state.value);
    },
    async put(key, value) {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new HttpError(400, "invalid_json", "保存内容必须是有效 JSON。 ");
      }
      await putState(env, key, parsed);
    },
  };
}

function legacyEnv(env) {
  return {
    ...env,
    SYNC_TOKEN: env.SYNC_TOKEN || env.ADMIN_TOKEN,
    ACTIONS_TOKEN: env.ACTIONS_TOKEN || env.ADMIN_TOKEN,
    CONFIG_KV: stateKvAdapter(env),
  };
}

function requireLegacyWriteMode(env) {
  if (String(env.LEGACY_WRITES_ENABLED || "").toLowerCase() !== "true") {
    throw new HttpError(
      409,
      "legacy_writes_disabled",
      "旧版历史和任务状态写入已关闭，请使用当前 Worker 定时任务。 ",
    );
  }
  if (String(env.AUTOMATION_PAUSED || "").toLowerCase() !== "true") {
    throw new HttpError(
      409,
      "automation_must_be_paused",
      "启用旧版写入时必须先暂停 Worker 自动任务。 ",
    );
  }
}

async function settingsFor(env) {
  const stored = await readState(env, SETTINGS_KEY);
  if (stored === null) {
    const settings = normalizeSettings(DEFAULT_SETTINGS);
    await putState(env, SETTINGS_KEY, settings);
    return settings;
  }
  return normalizeSettings(stored.value);
}

async function configFor(env, { legacy = true } = {}) {
  const stored = await readState(env, CONFIG_KEY, { legacy });
  if (stored !== null) return stored.value;
  if (typeof env.ACCOUNTS_JSON === "string" && env.ACCOUNTS_JSON.trim()) {
    try {
      return JSON.parse(env.ACCOUNTS_JSON);
    } catch {
      throw new HttpError(500, "accounts_invalid", "ACCOUNTS_JSON 不是有效 JSON。 ");
    }
  }
  throw new HttpError(409, "accounts_missing", "尚未保存账号配置。 ");
}

async function accountsFor(env, options) {
  const accounts = normalizeAccounts(runtimeAccountConfiguration(await configFor(env, options)));
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new HttpError(409, "accounts_missing", "没有可运行的账号。 ");
  }
  return accounts;
}

async function editableConfigFor(env) {
  try {
    return await configFor(env);
  } catch (error) {
    if (error instanceof HttpError && error.code === "accounts_missing") {
      return { accounts: [] };
    }
    throw error;
  }
}

function accountConfigHttpError(error) {
  if (error instanceof AccountConfigError) {
    return new HttpError(400, error.code, error.message, error.details);
  }
  return error;
}

async function adminAccountConfiguration(env) {
  return publicAccountConfiguration(await editableConfigFor(env));
}

async function saveAdminAccountConfiguration(env, payload) {
  const fallback = await editableConfigFor(env);
  let publicValue;
  try {
    await updateState(env, CONFIG_KEY, fallback, async (current) => {
      const updated = await updateAccountConfiguration(current, payload);
      publicValue = updated.public;
      return updated.value;
    });
  } catch (error) {
    throw accountConfigHttpError(error);
  }
  return publicValue || adminAccountConfiguration(env);
}

async function historyFor(env) {
  const stored = await readState(env, HISTORY_KEY);
  if (stored === null || !stored.value || stored.value.schema_version !== 1) {
    return emptyHistory();
  }
  return stored.value;
}

function historyDatabase(env) {
  const database = env?.STATE_DB;
  if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") {
    throw new HttpError(500, "history_store_not_configured", "完整历史数据库尚未配置。 ");
  }
  return database;
}

function historyInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function historyIdentifier(value, name, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new HttpError(500, "history_state_invalid", `${name} 无效，无法写入完整历史。 `);
  }
  return value;
}

function historyText(value, fallback, maximumLength) {
  const text = safeError(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim();
  return (text || fallback).slice(0, maximumLength);
}

function historyTimestamp(value, fallback = new Date().toISOString()) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback;
}

function automationRunRecord(run) {
  const now = new Date().toISOString();
  const startedAt = historyTimestamp(run?.started_at, now);
  return {
    run_id: historyIdentifier(run?.run_id, "run_id", 128),
    run_number: historyInteger(run?.run_number),
    run_attempt: historyInteger(run?.run_attempt, 1),
    started_at: startedAt,
    finished_at: historyTimestamp(run?.finished_at, startedAt),
    planned_draws: historyInteger(run?.planned_draws),
    status: historyText(run?.status, "unknown", 24),
    source: historyText(run?.source, "gwent", 24),
    trigger: historyText(run?.trigger, "legacy", 24),
    account_count: historyInteger(run?.account_count),
    successful_draws: historyInteger(run?.successful_draws),
    total_quota: historyInteger(run?.total_quota),
  };
}

function automationEventRecord(event, fallbackRunId) {
  const occurredAt = historyTimestamp(event?.occurred_at);
  const prizeName = event?.prize_name === null || event?.prize_name === undefined
    ? null
    : historyText(event.prize_name, "未知奖品", 80);
  return {
    event_id: historyIdentifier(event?.event_id, "event_id", 160),
    run_id: historyIdentifier(event?.run_id || fallbackRunId || "legacy:unassigned", "run_id", 128),
    account_key: historyIdentifier(event?.account_key, "account_key", 64),
    account_name: historyText(event?.account_name, "账号", 64),
    attempt: historyInteger(event?.attempt),
    occurred_at: occurredAt,
    local_date: localDate(new Date(occurredAt)),
    status: historyText(event?.status, "unknown", 24),
    prize_name: prizeName,
    prize_quota: historyInteger(event?.prize_quota),
    prize_rarity: historyText(event?.prize_rarity, "unknown", 24),
    bonus_percent: historyInteger(event?.bonus_percent),
    message: historyText(event?.message, "", 300),
    task_type: historyText(event?.task_type, "gwent", 24),
  };
}

function automationRunInsert(database, run) {
  return database.prepare(INSERT_AUTOMATION_RUN_SQL).bind(
    run.run_id,
    run.run_number,
    run.run_attempt,
    run.started_at,
    run.finished_at,
    run.planned_draws,
    run.status,
    run.source,
    run.trigger,
    run.account_count,
    run.successful_draws,
    run.total_quota,
  );
}

function automationEventInsert(database, event) {
  return database.prepare(INSERT_AUTOMATION_EVENT_SQL).bind(
    event.event_id,
    event.run_id,
    event.account_key,
    event.account_name,
    event.attempt,
    event.occurred_at,
    event.local_date,
    event.status,
    event.prize_name,
    event.prize_quota,
    event.prize_rarity,
    event.bonus_percent,
    event.message,
    event.task_type,
  );
}

async function persistHistoryRecords(env, runs, events, { operation = "write" } = {}) {
  const database = historyDatabase(env);
  const entries = [
    ...runs.map((run) => ({ type: "run", statement: automationRunInsert(database, automationRunRecord(run)) })),
    ...events.map((event) => ({
      type: "event",
      statement: automationEventInsert(database, automationEventRecord(event)),
    })),
  ];
  const inserted = { runs: 0, events: 0 };
  try {
    for (let offset = 0; offset < entries.length; offset += HISTORY_BATCH_SIZE) {
      const chunk = entries.slice(offset, offset + HISTORY_BATCH_SIZE);
      const results = await database.batch(chunk.map((entry) => entry.statement));
      if (!Array.isArray(results) || results.length !== chunk.length) {
        throw new Error("D1 returned an invalid history batch result.");
      }
      for (let index = 0; index < results.length; index += 1) {
        if (results[index]?.success === false) {
          throw new Error("D1 rejected a history statement.");
        }
        const changes = Number(results[index]?.meta?.changes || 0);
        if (changes > 0) inserted[`${chunk[index].type}s`] += changes;
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "full_history_write_failed",
      operation,
      error: safeError(error),
    }));
    throw new HttpError(
      500,
      operation === "backfill" ? "history_backfill_failed" : "history_write_failed",
      operation === "backfill"
        ? "旧历史回填失败，可修复数据库后安全重试。 "
        : "完整历史写入失败，本次任务未能完整提交。 ",
    );
  }
  return inserted;
}

async function backfillFullHistory(env) {
  const history = await historyFor(env);
  const runs = Array.isArray(history.runs) ? history.runs : [];
  const events = Array.isArray(history.events) ? history.events : [];
  const inserted = await persistHistoryRecords(env, runs, events, { operation: "backfill" });
  return {
    runs_seen: runs.length,
    events_seen: events.length,
    runs_inserted: inserted.runs,
    events_inserted: inserted.events,
  };
}

async function taskStateFor(env, source) {
  const key = TASK_STATUS_KEYS[source];
  if (!key) return emptyTaskStatuses(source);
  const stored = await readState(env, key);
  if (stored === null || !stored.value || stored.value.schema_version !== 1) {
    return emptyTaskStatuses(source);
  }
  return stored.value;
}

async function saveTaskSnapshots(env, source, localDate, snapshots) {
  if (!TASK_STATUS_KEYS[source] || snapshots.length === 0) return;
  const input = {
    schema_version: 1,
    source,
    local_date: localDate,
    updated_at: new Date().toISOString(),
    accounts: snapshots,
  };
  await updateState(env, TASK_STATUS_KEYS[source], emptyTaskStatuses(source), (current) =>
    mergeTaskStatuses(current, input).state,
  );
}

function eventStatus(result) {
  if (typeof result?.status === "string") return result.status;
  return result?.ok ? "success" : "error";
}

function historyEvent({ runId, source, account, key, attempt, result, occurredAt, eventId }) {
  return {
    event_id: eventId || `${runId}:${key}:${attempt}`,
    account_key: key,
    account_name: String(account.name || `账号${attempt}`).slice(0, 64),
    attempt,
    occurred_at: occurredAt || result?.occurred_at || new Date().toISOString(),
    status: eventStatus(result),
    prize_name: result?.prize_name || null,
    prize_quota: Math.max(0, Number(result?.prize_quota || 0) || 0),
    prize_rarity: result?.prize_rarity || "unknown",
    bonus_percent: Math.max(0, Number(result?.bonus_percent || 0) || 0),
    message: String(result?.message || "").slice(0, 300),
    task_type: source,
  };
}

async function appendRun(env, run, events) {
  const successfulEvents = events.filter((event) => event.status === "success");
  const fullRun = {
    ...run,
    successful_draws: successfulEvents.length,
    total_quota: successfulEvents.reduce(
      (sum, event) => sum + historyInteger(event.prize_quota),
      0,
    ),
  };
  const fullEvents = events.map((event) => ({ ...event, run_id: run.run_id }));
  const persisted = await persistHistoryRecords(env, [fullRun], fullEvents);
  let outcome;
  await updateState(env, HISTORY_KEY, emptyHistory(), (history) => {
    const existingEventIds = new Set((history.events || []).map((event) => event.event_id));
    const acceptedEventIds = new Set();
    const acceptedEvents = events.filter((event) => {
      if (existingEventIds.has(event.event_id) || acceptedEventIds.has(event.event_id)) return false;
      acceptedEventIds.add(event.event_id);
      return true;
    });
    outcome = {
      ...mergeHistory(history, { run, events: acceptedEvents }),
      accepted_events: acceptedEvents,
      full_history: persisted,
    };
    return outcome.history;
  });
  return outcome;
}

function localDate(date = new Date()) {
  return beijingParts(date).dateKey;
}

function isoTimestamp(value = Date.now()) {
  return new Date(value).toISOString();
}

function statusSnapshot(source, account, key, result, checkedAt = new Date().toISOString()) {
  const task =
    result?.task_status && typeof result.task_status === "object"
      ? result.task_status
      : result?.task && typeof result.task === "object"
        ? result.task
        : {};
  const status = String(task.status || result?.status || (result?.ok ? "completed" : "error"));
  const snapshot = {
    account_key: key,
    account_name: String(account.name || "账号").slice(0, 64),
    task_type: source,
    status: ["completed", "available", "cooldown", "pending", "suspended", "error", "unknown"]
      .includes(status)
      ? status
      : result?.ok
        ? "completed"
        : "error",
    completed: Boolean(result?.completed || status === "completed"),
    message: String(result?.message || result?.reason || "").slice(0, 300),
    checked_at: checkedAt,
  };
  if (source === "ad") {
    snapshot.done_count = Number.isFinite(Number(task.done_count ?? result?.done_count))
      ? Math.max(0, Math.min(3, Math.trunc(Number(task.done_count ?? result.done_count))))
      : null;
    snapshot.daily_cap = Number.isFinite(Number(task.daily_cap ?? result?.daily_cap))
      ? Math.max(1, Math.min(3, Math.trunc(Number(task.daily_cap ?? result.daily_cap))))
      : 3;
    const nextAvailable = task.next_available_at ?? result?.next_available_at ?? null;
    snapshot.next_available_at =
      typeof nextAvailable === "number" && Number.isFinite(nextAvailable) && nextAvailable > 0
        ? new Date(nextAvailable * 1000).toISOString()
        : typeof nextAvailable === "string" && Number.isFinite(Date.parse(nextAvailable))
          ? new Date(nextAvailable).toISOString()
          : null;
  }
  return snapshot;
}

async function claimLease(env, key, owner, ttlSeconds) {
  const now = Date.now();
  let claimed = false;
  await updateState(env, key, null, (current) => {
    const terminal =
      current &&
      typeof current === "object" &&
      !key.startsWith("account-lock:") &&
      current.status !== "running";
    if (terminal) {
      claimed = false;
      return current;
    }
    const active =
      current &&
      typeof current === "object" &&
      current.owner !== owner &&
      Number(current.expires_at || 0) > now;
    if (active) {
      claimed = false;
      return current;
    }
    claimed = true;
    return {
      owner,
      status: "running",
      claimed_at: isoTimestamp(now),
      expires_at: now + ttlSeconds * 1000,
    };
  });
  return claimed;
}

async function completeLease(env, key, owner, status, details = {}) {
  await updateState(env, key, null, (current) => {
    if (!current || current.owner !== owner) return current;
    return {
      ...current,
      ...details,
      status,
      completed_at: new Date().toISOString(),
      expires_at: 0,
    };
  });
}

function okResult(result) {
  return result?.ok === true || result?.success === true;
}

function skippedResult(result) {
  return result?.skipped === true || result?.status === "cooldown";
}

function sourceForAction(action) {
  return action === "draw" ? "gwent" : action;
}

function safeDrawResult(result) {
  const status = eventStatus(result);
  const ok = okResult(result);
  return {
    ok,
    success: ok,
    skipped: Boolean(result?.skipped),
    status,
    message: String(result?.message || "").slice(0, 300),
    prize_name: result?.prize_name ? String(result.prize_name).slice(0, 80) : null,
    prize_quota: Math.max(0, Number(result?.prize_quota || 0) || 0),
    prize_rarity: String(result?.prize_rarity || "unknown").slice(0, 16),
    bonus_percent: Math.max(0, Number(result?.bonus_percent || 0) || 0),
    draw_sent: result?.draw_sent === true,
    http_status: Number.isInteger(Number(result?.http_status)) ? Number(result.http_status) : null,
    occurred_at:
      typeof result?.occurred_at === "string" && Number.isFinite(Date.parse(result.occurred_at))
        ? new Date(result.occurred_at).toISOString()
        : new Date().toISOString(),
  };
}

function restoredDrawResult(intent) {
  const stored = intent?.result && typeof intent.result === "object" ? intent.result : {};
  const fallbackStatus =
    typeof intent?.status === "string" && !["claimed", "request_sent", "running"].includes(intent.status)
      ? intent.status
      : "uncertain";
  const status = typeof stored.status === "string" ? stored.status : fallbackStatus;
  const ok = stored.ok === true || stored.success === true || status === "success";
  return {
    ok,
    success: ok,
    skipped: Boolean(stored.skipped),
    status,
    message: String(stored.message || (ok ? "已恢复此前翻牌结果。" : "已恢复此前翻牌失败结果。"))
      .slice(0, 300),
    prize_name: stored.prize_name ? String(stored.prize_name).slice(0, 80) : null,
    prize_quota: Math.max(0, Number(stored.prize_quota || 0) || 0),
    prize_rarity: String(stored.prize_rarity || "unknown").slice(0, 16),
    bonus_percent: Math.max(0, Number(stored.bonus_percent || 0) || 0),
    draw_sent: stored.draw_sent === true,
    http_status: Number.isInteger(Number(stored.http_status)) ? Number(stored.http_status) : null,
    occurred_at:
      typeof stored.occurred_at === "string" && Number.isFinite(Date.parse(stored.occurred_at))
        ? new Date(stored.occurred_at).toISOString()
        : null,
    intent_terminal: true,
    recovered: true,
  };
}

function uncertainIntentResult(message = "翻牌请求可能已经发出，结果无法确认；为避免重复翻牌不会重试。") {
  return {
    ok: false,
    success: false,
    skipped: false,
    status: "uncertain",
    message,
    prize_name: null,
    prize_quota: 0,
    prize_rarity: "unknown",
    bonus_percent: 0,
    draw_sent: true,
    intent_terminal: true,
    recovered: true,
  };
}

function drawIntentPhase(intent) {
  if (!intent || typeof intent !== "object") return null;
  if (typeof intent.phase === "string") return intent.phase;
  return typeof intent.status === "string" ? intent.status : null;
}

function isTerminalDrawIntent(intent) {
  const phase = drawIntentPhase(intent);
  if (phase === "terminal") return true;
  return Boolean(
    intent?.result &&
      typeof intent.result === "object" &&
      ![null, "claimed", "request_sent", "running"].includes(phase),
  );
}

async function claimDrawIntent(env, intentKey, owner, source, key) {
  const now = Date.now();
  const updated = await updateState(env, intentKey, null, (current) => {
    const phase = drawIntentPhase(current);
    if (["request_sent", "running"].includes(phase)) {
      const result = safeDrawResult(
        uncertainIntentResult(
          "翻牌请求可能已经发出，结果无法确认；为避免重复翻牌不会重试。",
        ),
      );
      return {
        ...current,
        schema_version: 1,
        phase: "terminal",
        status: "uncertain",
        result,
        completed_at: isoTimestamp(now),
        expires_at: 0,
      };
    }
    const expiredClaim = phase === "claimed" && Number(current?.expires_at || 0) <= now;
    if (current !== null && !expiredClaim) return current;
    return {
      schema_version: 1,
      phase: "claimed",
      status: "claimed",
      owner,
      source,
      account_key: key,
      claimed_at: isoTimestamp(now),
      expires_at: now + SCHEDULE_LEASE_SECONDS * 1000,
    };
  });
  const intent = updated.value;
  if (intent?.owner === owner && drawIntentPhase(intent) === "claimed") {
    return { kind: "claimed", intent };
  }
  if (isTerminalDrawIntent(intent)) return { kind: "terminal", intent };
  if (drawIntentPhase(intent) === "claimed") return { kind: "duplicate", intent };
  return { kind: "uncertain", intent };
}

async function markDrawIntentRequestSent(env, intentKey, owner) {
  const sentAt = new Date().toISOString();
  const updated = await updateState(env, intentKey, null, (current) => {
    if (!current || current.owner !== owner || drawIntentPhase(current) !== "claimed") {
      return current;
    }
    return {
      ...current,
      phase: "request_sent",
      status: "request_sent",
      request_sent_at: sentAt,
      expires_at: 0,
    };
  });
  return updated.value?.owner === owner && drawIntentPhase(updated.value) === "request_sent";
}

async function completeDrawIntent(env, intentKey, owner, result) {
  const safeResult = safeDrawResult(result);
  const updated = await updateState(env, intentKey, null, (current) => {
    if (!current || current.owner !== owner || drawIntentPhase(current) !== "request_sent") {
      return current;
    }
    return {
      ...current,
      phase: "terminal",
      status: safeResult.status,
      result: safeResult,
      completed_at: new Date().toISOString(),
      expires_at: 0,
    };
  });
  return isTerminalDrawIntent(updated.value) ? restoredDrawResult(updated.value) : uncertainIntentResult();
}

async function drawWithIntent(env, account, key, runId, source, attempt, options = {}) {
  const { intentId, ...drawOptions } = options;
  const intentKey = intentId
    ? `draw-intent:${intentId}`
    : `draw-intent:${runId}:${key}:${attempt}`;
  const owner = crypto.randomUUID();
  const claim = await claimDrawIntent(env, intentKey, owner, source, key);
  if (claim.kind === "terminal") return restoredDrawResult(claim.intent);
  if (claim.kind === "uncertain") return uncertainIntentResult();
  if (claim.kind !== "claimed") {
    return {
      ok: false,
      success: false,
      skipped: true,
      status: "duplicate",
      message: "这次翻牌正在由另一个任务处理。",
      intent_terminal: false,
    };
  }

  if (!(await markDrawIntentRequestSent(env, intentKey, owner))) {
    return uncertainIntentResult("未能安全确认翻牌意图状态；为避免重复翻牌，本次不会发送请求。");
  }

  let result;
  try {
    result = await unlockAndDraw(account, drawOptions);
  } catch (error) {
    result = {
      ok: false,
      success: false,
      status: "uncertain",
      message: `翻牌结果不明确：${safeError(error)}`,
      prize_quota: 0,
      prize_rarity: "unknown",
      bonus_percent: 0,
    };
  }
  return completeDrawIntent(env, intentKey, owner, result);
}

function rewardQueueKey(key) {
  return `reward-queue:${key}`;
}

function emptyRewardQueue(key) {
  return {
    schema_version: 1,
    account_key: key,
    updated_at: null,
    items: [],
  };
}

function normalizedRewardQueue(value, key) {
  if (!value || typeof value !== "object" || value.schema_version !== 1) {
    return emptyRewardQueue(key);
  }
  return {
    schema_version: 1,
    account_key: key,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
    items: Array.isArray(value.items)
      ? value.items.filter((item) => item && typeof item === "object" && typeof item.key === "string")
      : [],
  };
}

function trimRewardQueue(items) {
  if (items.length <= MAX_REWARD_QUEUE_ITEMS) return items;
  const active = items.filter((item) => item.status !== "completed");
  const completed = items.filter((item) => item.status === "completed");
  const remaining = Math.max(0, MAX_REWARD_QUEUE_ITEMS - active.length);
  return [...active, ...(remaining === 0 ? [] : completed.slice(-remaining))];
}

async function enqueueReward(env, key, reward) {
  const stateKey = rewardQueueKey(key);
  const updated = await updateState(env, stateKey, emptyRewardQueue(key), (current) => {
    const queue = normalizedRewardQueue(current, key);
    if (queue.items.some((item) => item.key === reward.key)) return queue;
    const now = new Date().toISOString();
    return {
      ...queue,
      updated_at: now,
      items: trimRewardQueue([
        ...queue.items,
        {
          key: reward.key,
          source: reward.source,
          local_date: reward.local_date,
          ordinal: reward.ordinal ?? null,
          reason: String(reward.reason || "奖励翻牌").slice(0, 80),
          status: "pending",
          created_at: now,
          history_recorded: false,
        },
      ]),
    };
  });
  return normalizedRewardQueue(updated.value, key).items.find((item) => item.key === reward.key);
}

async function rewardsAwaitingHistory(env, key, source) {
  const stored = await readState(env, rewardQueueKey(key));
  const queue = normalizedRewardQueue(stored?.value, key);
  return queue.items
    .filter(
      (item) =>
        item.source === source &&
        item.history_recorded !== true &&
        ["pending", "terminal"].includes(item.status),
    )
    .sort(
      (left, right) =>
        String(left.created_at || "").localeCompare(String(right.created_at || "")) ||
        left.key.localeCompare(right.key),
    );
}

async function markRewardTerminal(env, key, rewardKey, result) {
  const safeResult = safeDrawResult(result);
  const updated = await updateState(env, rewardQueueKey(key), emptyRewardQueue(key), (current) => {
    const queue = normalizedRewardQueue(current, key);
    const now = new Date().toISOString();
    return {
      ...queue,
      updated_at: now,
      items: queue.items.map((item) =>
        item.key !== rewardKey || item.status === "completed"
          ? item
          : {
              ...item,
              status: "terminal",
              outcome: safeResult.status,
              result: safeResult,
              terminal_at: item.terminal_at || now,
              history_recorded: false,
            },
      ),
    };
  });
  return normalizedRewardQueue(updated.value, key).items.find((item) => item.key === rewardKey);
}

async function acknowledgeRewardHistory(env, key, rewardKeys) {
  if (!Array.isArray(rewardKeys) || rewardKeys.length === 0) return;
  const accepted = new Set(rewardKeys);
  await updateState(env, rewardQueueKey(key), emptyRewardQueue(key), (current) => {
    const queue = normalizedRewardQueue(current, key);
    const now = new Date().toISOString();
    return {
      ...queue,
      updated_at: now,
      items: queue.items.map((item) =>
        accepted.has(item.key) && item.status === "terminal"
          ? {
              ...item,
              status: "completed",
              history_recorded: true,
              completed_at: now,
            }
          : item,
      ),
    };
  });
}

async function runAccountAction({
  env,
  action,
  account,
  key,
  index,
  runId,
  settings,
  drawCount,
}) {
  if (!account.isVsllm && ["draw", "quiz", "ad"].includes(action)) {
    return {
      account_key: key,
      account_name: account.name || `账号${index + 1}`,
      ok: true,
      skipped: true,
      reason: "unsupported_capability",
      message: "该账号不是 VSLLM，已跳过此任务。",
      steps: [{ action, ok: true, skipped: true, status: "unsupported" }],
      events: [],
      snapshots: [],
      reward_acks: [],
    };
  }

  const owner = crypto.randomUUID();
  const lockKey = `account-lock:${key}`;
  if (!(await claimLease(env, lockKey, owner, ACCOUNT_LOCK_SECONDS))) {
    return {
      account_key: key,
      account_name: account.name,
      ok: true,
      skipped: true,
      reason: "account_busy",
      message: "账号正在执行另一个任务。",
      steps: [],
      events: [],
      snapshots: [],
      reward_acks: [],
    };
  }

  const events = [];
  const snapshots = [];
  const steps = [];
  const rewardAcks = [];
  let drawAttempt = 0;

  function recordDrawEvent(source, result, eventId) {
    drawAttempt += 1;
    if (result?.intent_terminal === false) return;
    events.push(
      historyEvent({
        runId,
        source,
        account,
        key,
        attempt: drawAttempt,
        result,
        eventId,
      }),
    );
  }

  async function performDraw(source, reason, { intentId, eventId } = {}) {
    const attempt = drawAttempt + 1;
    const result = await drawWithIntent(env, account, key, runId, source, attempt, {
      shareBonus: settings.draw.share_bonus,
      reason,
      intentId,
    });
    drawAttempt = attempt - 1;
    recordDrawEvent(source, result, eventId);
    return result;
  }

  async function consumePendingRewards(source, enabled) {
    if (!enabled) return [];
    const items = await rewardsAwaitingHistory(env, key, source);
    const draws = [];
    for (const item of items) {
      let result;
      if (item.status === "terminal") {
        result = restoredDrawResult({
          phase: "terminal",
          status: item.outcome,
          result: item.result,
        });
        recordDrawEvent(source, result, `reward:${item.key}`);
      } else {
        result = await performDraw(source, item.reason, {
          intentId: item.key,
          eventId: `reward:${item.key}`,
        });
      }
      draws.push(result);
      if (result?.intent_terminal === true) {
        if (item.status !== "terminal") await markRewardTerminal(env, key, item.key, result);
        rewardAcks.push(item.key);
      }
    }
    return draws;
  }

  function combinedRewardResult(result, draws, fallbackMessage) {
    const failedDraw = draws.find((draw) => !okResult(draw));
    const ok = okResult(result) && !failedDraw;
    return {
      ...result,
      ok,
      success: ok,
      skipped: Boolean(result?.skipped) && draws.length === 0,
      status:
        failedDraw && okResult(result)
          ? "partial"
          : draws.length > 0 && skippedResult(result)
            ? "success"
            : result?.status,
      draw: draws.at(-1) || null,
      draws,
      message: failedDraw
        ? `${result?.message || fallbackMessage}，但奖励翻牌失败：${failedDraw.message || "未知错误"}`
        : result?.message,
    };
  }

  async function performCheckin() {
    const result = await checkinAccount(account);
    snapshots.push(statusSnapshot("checkin", account, key, result));
    steps.push({ action: "checkin", ...result });
    return result;
  }

  async function performQuiz() {
    let result;
    try {
      result = await runQuiz(account, { maxQuizAttempts: 4 });
    } catch (error) {
      result = { ok: false, success: false, status: "error", message: safeError(error) };
    }
    if (result?.reward_ready && settings.quiz.draw_after_success) {
      const date = localDate();
      await enqueueReward(env, key, {
        key: `quiz:${date}:${key}`,
        source: "quiz",
        local_date: date,
        reason: "答题奖励",
      });
    }
    const draws = await consumePendingRewards("quiz", settings.quiz.draw_after_success);
    const combined = combinedRewardResult(result, draws, "答题已完成");
    snapshots.push(statusSnapshot("quiz", account, key, combined));
    steps.push({ action: "quiz", ...combined });
    return combined;
  }

  async function performAd() {
    let result;
    try {
      result = await runAd(account, { dailyLimit: settings.ad.daily_limit });
    } catch (error) {
      result = { ok: false, success: false, status: "error", message: safeError(error) };
    }
    if (result?.reward_ready && settings.ad.draw_after_claim) {
      const date = localDate();
      const ordinal = Number(
        result?.after_done_count ?? result?.done_count ?? result?.task?.done_count,
      );
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 3) {
        result = {
          ...result,
          ok: false,
          success: false,
          status: "error",
          message: `${result?.message || "视频奖励已领取"}，但无法确定奖励序号，未执行翻牌。`,
        };
      } else {
        await enqueueReward(env, key, {
          key: `ad:${date}:${key}:${ordinal}`,
          source: "ad",
          local_date: date,
          ordinal,
          reason: `视频奖励 ${ordinal}`,
        });
      }
    }
    const draws = await consumePendingRewards("ad", settings.ad.draw_after_claim);
    const combined = combinedRewardResult(result, draws, "视频奖励已领取");
    snapshots.push(statusSnapshot("ad", account, key, combined));
    steps.push({ action: "ad", ...combined });
    return combined;
  }

  try {
    if (action === "checkin") {
      await performCheckin();
    } else if (action === "quiz") {
      await performQuiz();
    } else if (action === "ad") {
      await performAd();
    } else if (action === "draw") {
      const status = await getGwentStatus(account);
      const available = Number.isFinite(Number(status?.available)) ? Number(status.available) : null;
      const planned = available === null ? drawCount : Math.min(drawCount, Math.max(0, available));
      if (planned === 0) {
        steps.push({
          action: "draw",
          ok: true,
          skipped: true,
          status: "cooldown",
          message: "当前没有可用翻牌次数。",
        });
      } else {
        for (let attempt = 0; attempt < planned; attempt += 1) {
          const result = await performDraw("gwent", "常规翻牌");
          steps.push({ action: "draw", ...result });
          if (!okResult(result)) break;
        }
      }
    } else if (action === "all") {
      await performCheckin();
      if (account.isVsllm) {
        await performQuiz();
        await performAd();
        const result = await performDraw("gwent", "手动执行全部任务");
        steps.push({ action: "draw", ...result });
      }
    } else {
      throw new HttpError(400, "invalid_action", "不支持的任务类型。 ");
    }
  } catch (error) {
    steps.push({
      action,
      ok: false,
      status: "error",
      message: safeError(error),
    });
  } finally {
    await completeLease(env, lockKey, owner, "released");
  }

  const failed = steps.filter((step) => !okResult(step) && !skippedResult(step)).length;
  const succeeded = steps.filter((step) => okResult(step) && !skippedResult(step)).length;
  const skipped = steps.filter((step) => skippedResult(step)).length;
  return {
    account_key: key,
    account_name: account.name || `账号${index + 1}`,
    ok: failed === 0,
    failed,
    succeeded,
    skipped,
    steps,
    events,
    snapshots,
    reward_acks: rewardAcks,
  };
}

function validatedAccountKeys(value) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_account_keys", "account_keys 必须是数组。 ");
  }
  if (value.length === 0 || value.length > MAX_REQUESTED_ACCOUNTS) {
    throw new HttpError(
      400,
      "invalid_account_keys",
      `account_keys 必须包含 1-${MAX_REQUESTED_ACCOUNTS} 项。 `,
    );
  }
  const normalized = [];
  for (const item of value) {
    if (item !== "all" && (typeof item !== "string" || !ACCOUNT_KEY_PATTERN.test(item))) {
      throw new HttpError(400, "invalid_account_keys", "account_keys 包含无效账号标识。 ");
    }
    if (!normalized.includes(item)) normalized.push(item);
  }
  return normalized.includes("all") ? ["all"] : normalized;
}

function validatedManualIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_MANUAL_IDEMPOTENCY_LENGTH ||
    !MANUAL_IDEMPOTENCY_PATTERN.test(value)
  ) {
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      `手动任务必须提供 8-${MAX_MANUAL_IDEMPOTENCY_LENGTH} 位安全幂等键。 `,
    );
  }
  return value;
}

async function keyedAccounts(env, requestedKeys = ["all"]) {
  const normalizedKeys = validatedAccountKeys(requestedKeys);
  const accounts = await accountsFor(env);
  const keyed = await Promise.all(
    accounts.map(async (account, index) => ({
      account,
      index,
      key: await accountKey(account, index + 1),
    })),
  );
  const requested = new Set(normalizedKeys);
  if (requested.has("all")) return keyed;
  const selected = keyed.filter((item) => requested.has(item.key));
  if (selected.length === 0) {
    throw new HttpError(400, "accounts_not_found", "没有匹配的账号。 ");
  }
  return selected;
}

function runStatus(results) {
  const failed = results.reduce((sum, result) => sum + Number(result.failed || 0), 0);
  const succeeded = results.reduce((sum, result) => sum + Number(result.succeeded || 0), 0);
  if (failed === 0) return "success";
  return succeeded > 0 ? "partial" : "error";
}

async function runAutomation(env, {
  action,
  trigger = "manual",
  slot = null,
  accountKeys,
  drawCount,
  idempotencyKey,
} = {}) {
  const allowed = new Set(["draw", "checkin", "quiz", "ad", "all"]);
  if (!allowed.has(action)) {
    throw new HttpError(400, "invalid_action", "不支持的任务类型。 ");
  }
  const normalizedAccountKeys =
    trigger === "scheduled" ? ["all"] : validatedAccountKeys(accountKeys);
  const identity =
    trigger === "scheduled" ? slot : validatedManualIdempotencyKey(idempotencyKey);
  if (typeof identity !== "string" || identity.length === 0) {
    throw new HttpError(400, "invalid_idempotency_key", "任务缺少幂等标识。 ");
  }
  const settings = await settingsFor(env);
  const count = Math.max(1, Math.min(3, Number(drawCount || settings.draw.draw_count) || 1));
  const runId = `${trigger}:${action}:${identity}`;
  const runKey = `automation-run:${runId}`;
  const owner = crypto.randomUUID();
  if (!(await claimLease(env, runKey, owner, SCHEDULE_LEASE_SECONDS))) {
    const existing = await readState(env, runKey);
    return existing?.value?.summary || {
      run_id: runId,
      status: "running",
      duplicate: true,
    };
  }

  const startedAt = new Date().toISOString();
  let summary;
  try {
    const accounts = await keyedAccounts(env, normalizedAccountKeys);
    const results = await Promise.all(
      accounts.map(({ account, key, index }) =>
        runAccountAction({
          env,
          action,
          account,
          key,
          index,
          runId,
          settings,
          drawCount: count,
        }),
      ),
    );
    const events = results.flatMap((result) => result.events);
    const finishedAt = new Date().toISOString();
    const status = runStatus(results);
    const run = {
      run_id: runId,
      run_number: 0,
      run_attempt: 1,
      started_at: startedAt,
      finished_at: finishedAt,
      planned_draws: action === "draw" ? count : 0,
      status,
      source: sourceForAction(action),
      trigger,
      account_count: accounts.length,
    };
    const historyOutcome = await appendRun(env, run, events);
    const acceptedEvents = historyOutcome.accepted_events || [];
    await Promise.all(
      results.map((result) => acknowledgeRewardHistory(env, result.account_key, result.reward_acks)),
    );

    const today = localDate(new Date(finishedAt));
    for (const source of ["checkin", "quiz", "ad"]) {
      const snapshots = results.flatMap((result) =>
        result.snapshots.filter((snapshot) => snapshot.task_type === source),
      );
      await saveTaskSnapshots(env, source, today, snapshots);
    }

    summary = {
      success: status === "success",
      run_id: runId,
      action,
      trigger,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      total: accounts.length,
      succeeded: results.filter((result) => result.ok && !result.skipped).length,
      failed: results.filter((result) => !result.ok).length,
      skipped: results.filter((result) => result.skipped).length,
      successful_draws: acceptedEvents.filter((event) => event.status === "success").length,
      total_quota: acceptedEvents
        .filter((event) => event.status === "success")
        .reduce((sum, event) => sum + Number(event.prize_quota || 0), 0),
      results,
    };
    await completeLease(env, runKey, owner, status, { summary });
  } catch (error) {
    summary = {
      success: false,
      run_id: runId,
      action,
      trigger,
      status: "error",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error: safeError(error),
    };
    await completeLease(env, runKey, owner, "error", { summary });
    throw error;
  }

  console.log(JSON.stringify({ event: "automation_run_finished", ...summary, results: undefined }));
  return summary;
}

function dateKeyOffset(dateKey, offsetDays) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function mondayOf(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  return dateKeyOffset(dateKey, 1 - weekday);
}

function amount(quota, quotaPerCny) {
  const normalizedQuota = Math.max(0, Number(quota || 0) || 0);
  return {
    quota: normalizedQuota,
    amount_yuan: (normalizedQuota / quotaPerCny).toFixed(6),
  };
}

function positiveQueryInteger(parameters, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = parameters.get(name);
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new HttpError(400, "invalid_history_query", `${name} 必须是正整数。 `);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new HttpError(400, "invalid_history_query", `${name} 超出允许范围。 `);
  }
  return value;
}

function validatedDateQuery(parameters, name) {
  const value = parameters.get(name);
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new HttpError(400, "invalid_history_query", `${name} 必须是有效的北京时间日期。 `);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new HttpError(400, "invalid_history_query", `${name} 必须是有效的北京时间日期。 `);
  }
  return value;
}

function historyEventFilters(url) {
  const page = positiveQueryInteger(url.searchParams, "page", 1);
  const pageSize = positiveQueryInteger(
    url.searchParams,
    "page_size",
    DEFAULT_HISTORY_PAGE_SIZE,
    MAX_HISTORY_PAGE_SIZE,
  );
  const accountKeyValue = url.searchParams.get("account_key");
  const accountKeyValueNormalized = accountKeyValue === null || accountKeyValue === ""
    ? null
    : accountKeyValue;
  if (accountKeyValueNormalized !== null && !ACCOUNT_KEY_PATTERN.test(accountKeyValueNormalized)) {
    throw new HttpError(400, "invalid_history_query", "account_key 格式无效。 ");
  }
  const sourceValue = url.searchParams.get("source");
  const source = sourceValue === null || sourceValue === "" ? null : sourceValue;
  if (source !== null && !HISTORY_SOURCE_FILTERS.has(source)) {
    throw new HttpError(
      400,
      "invalid_history_query",
      "source 只支持 draw、gwent、checkin、quiz 或 ad。 ",
    );
  }
  const fromDate = validatedDateQuery(url.searchParams, "from");
  const toDate = validatedDateQuery(url.searchParams, "to");
  if (fromDate !== null && toDate !== null && fromDate > toDate) {
    throw new HttpError(400, "invalid_history_query", "from 不能晚于 to。 ");
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new HttpError(400, "invalid_history_query", "page 超出允许范围。 ");
  }
  return {
    page,
    pageSize,
    offset,
    accountKey: accountKeyValueNormalized,
    source: source === "draw" ? "gwent" : source,
    requestedSource: source,
    fromDate,
    toDate,
  };
}

function historyWhereClause(filters) {
  const conditions = [];
  const values = [];
  if (filters.accountKey !== null) {
    conditions.push("account_key = ?");
    values.push(filters.accountKey);
  }
  if (filters.source !== null) {
    conditions.push("task_type = ?");
    values.push(filters.source);
  }
  if (filters.fromDate !== null) {
    conditions.push("local_date >= ?");
    values.push(filters.fromDate);
  }
  if (filters.toDate !== null) {
    conditions.push("local_date <= ?");
    values.push(filters.toDate);
  }
  return {
    sql: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

function publicHistoryEvent(row, quotaPerCny) {
  const prizeQuota = historyInteger(row?.prize_quota);
  const taskType = historyText(row?.task_type, "gwent", 24);
  return {
    event_id: historyText(row?.event_id, "", 160),
    run_id: historyText(row?.run_id, "", 128),
    account_key: historyText(row?.account_key, "", 64),
    account_name: historyText(row?.account_name, "账号", 64),
    attempt: historyInteger(row?.attempt),
    occurred_at: historyTimestamp(row?.occurred_at),
    local_date: historyText(row?.local_date, "", 10),
    status: historyText(row?.status, "unknown", 24),
    source: taskType === "gwent" ? "draw" : taskType,
    task_type: taskType,
    prize_name: row?.prize_name === null ? null : historyText(row?.prize_name, "未知奖品", 80),
    prize_quota: prizeQuota,
    amount_yuan: (prizeQuota / quotaPerCny).toFixed(6),
    prize_rarity: historyText(row?.prize_rarity, "unknown", 24),
    bonus_percent: historyInteger(row?.bonus_percent),
    message: historyText(row?.message, "", 300),
  };
}

async function historyEventsData(env, url) {
  const filters = historyEventFilters(url);
  const where = historyWhereClause(filters);
  const database = historyDatabase(env);
  const countStatement = database
    .prepare(`SELECT COUNT(*) AS total FROM automation_events${where.sql}`)
    .bind(...where.values);
  const eventStatement = database
    .prepare(`
      SELECT event_id, run_id, account_key, account_name, attempt, occurred_at,
             local_date, status, prize_name, prize_quota, prize_rarity,
             bonus_percent, message, task_type
      FROM automation_events${where.sql}
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...where.values, filters.pageSize, filters.offset);
  let results;
  try {
    results = await database.batch([countStatement, eventStatement]);
  } catch (error) {
    console.error(JSON.stringify({ event: "full_history_read_failed", error: safeError(error) }));
    throw new HttpError(500, "history_read_failed", "完整历史读取失败。 ");
  }
  const total = historyInteger(results?.[0]?.results?.[0]?.total);
  const rows = Array.isArray(results?.[1]?.results) ? results[1].results : [];
  const totalPages = total === 0 ? 0 : Math.ceil(total / filters.pageSize);
  return {
    items: rows.map((row) => publicHistoryEvent(row, DEFAULT_SETTINGS.quota_per_cny)),
    pagination: {
      page: filters.page,
      page_size: filters.pageSize,
      total,
      total_pages: totalPages,
      has_previous: filters.page > 1,
      has_next: filters.page < totalPages,
    },
    filters: {
      account_key: filters.accountKey,
      source: filters.requestedSource,
      from: filters.fromDate,
      to: filters.toDate,
    },
  };
}

async function dailyAccountHistoryStats(env, dateKey) {
  const database = historyDatabase(env);
  let result;
  try {
    result = await database.prepare(`
      SELECT account_key,
             COUNT(*) AS today_draws,
             SUM(CASE WHEN prize_quota > 0 THEN 1 ELSE 0 END) AS today_wins,
             SUM(prize_quota) AS today_quota
      FROM automation_events
      WHERE local_date = ? AND status = 'success'
      GROUP BY account_key
    `).bind(dateKey).all();
  } catch (error) {
    console.error(JSON.stringify({ event: "daily_history_read_failed", error: safeError(error) }));
    throw new HttpError(500, "history_read_failed", "今日历史统计读取失败。 ");
  }
  return new Map(
    (Array.isArray(result?.results) ? result.results : []).map((row) => [
      String(row.account_key),
      {
        today_draws: historyInteger(row.today_draws),
        today_wins: historyInteger(row.today_wins),
        today_quota: historyInteger(row.today_quota),
      },
    ]),
  );
}

function effectiveTaskStatus(status, now = Date.now()) {
  if (!status || typeof status !== "object") return null;
  if (
    status.task_type === "ad" &&
    status.status === "cooldown" &&
    status.next_available_at &&
    Date.parse(status.next_available_at) <= now &&
    !status.completed
  ) {
    return { ...status, status: "available", message: "视频任务现在可以执行。" };
  }
  return status;
}

async function dashboardData(env) {
  const [settings, history, checkinState, quizState, adState] = await Promise.all([
    settingsFor(env),
    historyFor(env),
    taskStateFor(env, "checkin"),
    taskStateFor(env, "quiz"),
    taskStateFor(env, "ad"),
  ]);
  const now = new Date();
  const today = localDate(now);
  const weekStart = mondayOf(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const daily = Array.isArray(history.daily) ? history.daily : [];
  const quotaFor = (predicate) =>
    daily.filter((item) => predicate(item.date)).reduce((sum, item) => sum + Number(item.total_quota || 0), 0);
  const totalQuota = Number(history.totals?.total_quota || 0);
  const todayQuota = quotaFor((date) => date === today);
  const weekQuota = quotaFor((date) => date >= weekStart && date <= today);
  const monthQuota = quotaFor((date) => date >= monthStart && date <= today);
  const storedTaskStatuses = publicTaskStatuses([checkinState, quizState, adState]);
  const taskStatuses = storedTaskStatuses.local_date === today
    ? { ...storedTaskStatuses, stale: false }
    : {
        local_date: today,
        updated_at: null,
        accounts: [],
        stale: storedTaskStatuses.local_date !== null,
        previous_local_date: storedTaskStatuses.local_date,
      };
  const taskMap = new Map();
  for (const raw of taskStatuses.accounts || []) {
    const status = effectiveTaskStatus(raw);
    if (!taskMap.has(status.account_key)) taskMap.set(status.account_key, {});
    taskMap.get(status.account_key)[status.task_type] = status;
  }

  let configured = [];
  let configurationError = null;
  try {
    configured = await keyedAccounts(env);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : "账号配置不可用";
  }
  const historyAccounts = new Map(
    (history.accounts || []).map((account) => [account.account_key, account]),
  );
  const fullTodayByAccount = await dailyAccountHistoryStats(env, today);
  const recentTodayByAccount = new Map();
  for (const event of history.events || []) {
    if (event.status !== "success" || localDate(new Date(event.occurred_at)) !== today) continue;
    const current = recentTodayByAccount.get(event.account_key) || {
      today_draws: 0,
      today_wins: 0,
      today_quota: 0,
    };
    current.today_draws += 1;
    current.today_quota += Number(event.prize_quota || 0);
    if (Number(event.prize_quota || 0) > 0) current.today_wins += 1;
    recentTodayByAccount.set(event.account_key, current);
  }
  const accountKeys = new Set([
    ...configured.map((item) => item.key),
    ...historyAccounts.keys(),
    ...taskMap.keys(),
    ...fullTodayByAccount.keys(),
  ]);
  const accounts = [...accountKeys]
    .map((key) => {
      const configuredAccount = configured.find((item) => item.key === key);
      const historic = historyAccounts.get(key) || {};
      const total = Number(historic.total_quota || 0);
      const todayStats = fullTodayByAccount.get(key) || recentTodayByAccount.get(key) || {
        today_draws: 0,
        today_wins: 0,
        today_quota: 0,
      };
      const todayTotal = Number(todayStats.today_quota || 0);
      return {
        account_key: key,
        account_name:
          configuredAccount?.account?.name || historic.account_name || `账号 ${key.slice(0, 4)}`,
        configured: Boolean(configuredAccount),
        is_vsllm: Boolean(configuredAccount?.account?.isVsllm),
        capabilities: {
          checkin: Boolean(configuredAccount),
          draw: Boolean(configuredAccount?.account?.isVsllm),
          quiz: Boolean(configuredAccount?.account?.isVsllm),
          ad: Boolean(configuredAccount?.account?.isVsllm),
        },
        total_draws: Number(historic.total_draws || 0),
        total_wins: Number(historic.total_wins || 0),
        total_quota: total,
        amount_yuan: (total / settings.quota_per_cny).toFixed(6),
        today_draws: historyInteger(todayStats.today_draws),
        today_wins: historyInteger(todayStats.today_wins),
        today_quota: todayTotal,
        today_amount_yuan: (todayTotal / settings.quota_per_cny).toFixed(6),
        last_event_at: historic.last_event_at || null,
        last_status: historic.last_status || null,
        tasks: taskMap.get(key) || { checkin: null, quiz: null, ad: null },
      };
    })
    .sort((left, right) => left.account_name.localeCompare(right.account_name, "zh-CN"));

  return {
    schema_version: 2,
    as_of: now.toISOString(),
    storage: { provider: "D1", connected: true },
    conversion: {
      currency: "CNY",
      quota_per_cny: settings.quota_per_cny,
    },
    income: {
      total: amount(totalQuota, settings.quota_per_cny),
      today: amount(todayQuota, settings.quota_per_cny),
      week: amount(weekQuota, settings.quota_per_cny),
      month: amount(monthQuota, settings.quota_per_cny),
    },
    totals: history.totals || emptyHistory().totals,
    accounts,
    task_statuses: taskStatuses,
    schedules: scheduleSummaries(settings, now).map((item) => ({
      ...item,
      enabled: item.enabled && String(env.AUTOMATION_PAUSED || "").toLowerCase() !== "true",
    })),
    trend: daily.slice(-30).map((item) => ({
      ...item,
      amount_yuan: (Number(item.total_quota || 0) / settings.quota_per_cny).toFixed(6),
    })),
    recent_runs: (history.runs || []).slice(0, 30).map((run) => ({
      ...run,
      amount_yuan: (Number(run.total_quota || 0) / settings.quota_per_cny).toFixed(6),
    })),
    recent_events: (history.events || []).slice(0, 100).map((event) => ({
      ...event,
      amount_yuan: (Number(event.prize_quota || 0) / settings.quota_per_cny).toFixed(6),
    })),
    settings,
    automation_paused: String(env.AUTOMATION_PAUSED || "").toLowerCase() === "true",
    configuration_error: configurationError,
  };
}

async function balancesData(env, accountKeys = ["all"]) {
  const settings = await settingsFor(env);
  const accounts = await keyedAccounts(env, accountKeys);
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(
    accounts.map(async ({ account, key }) => {
      const [result, gwentResult] = await Promise.all([
        getBalance(account),
        account.isVsllm ? getGwentStatus(account) : Promise.resolve(null),
      ]);
      const balanceQuota = Math.max(
        0,
        Number(result?.balance_quota ?? result?.quota_raw ?? result?.quota ?? 0) || 0,
      );
      const gwentOk = account.isVsllm && okResult(gwentResult);
      const gwentInteger = (value) =>
        Number.isSafeInteger(value) && value >= 0 ? value : null;
      return {
        account_key: key,
        account_name: account.name,
        ...result,
        balance_quota: balanceQuota,
        balance_yuan: (balanceQuota / settings.quota_per_cny).toFixed(6),
        gwent: account.isVsllm
          ? {
              supported: true,
              ok: gwentOk,
              status: String(gwentResult?.status || (gwentOk ? "success" : "error")),
              message: String(
                gwentResult?.message || (gwentOk ? "翻牌状态读取成功" : "翻牌状态读取失败"),
              ),
              available: gwentOk ? gwentInteger(gwentResult?.available) : null,
              charges_current: gwentOk ? gwentInteger(gwentResult?.charges_current) : null,
              extra_draws_left: gwentOk ? gwentInteger(gwentResult?.extra_draws_left) : null,
              next_available_at: gwentOk ? gwentInteger(gwentResult?.next_available_at) : null,
              next_charge_at: gwentOk ? gwentInteger(gwentResult?.next_charge_at) : null,
              cooldown_seconds: gwentOk ? gwentInteger(gwentResult?.cooldown_seconds) : null,
              checked_at: checkedAt,
            }
          : {
              supported: false,
              ok: null,
              status: "not_applicable",
              message: "该账号不支持翻牌",
              available: null,
              charges_current: null,
              extra_draws_left: null,
              next_available_at: null,
              next_charge_at: null,
              cooldown_seconds: null,
              checked_at: checkedAt,
            },
      };
    }),
  );
  const totalQuota = results
    .filter((result) => okResult(result))
    .reduce((sum, result) => sum + Number(result.balance_quota || 0), 0);
  const supportedGwent = results.filter((result) => result.gwent.supported);
  const knownGwent = supportedGwent.filter(
    (result) => Number.isSafeInteger(result.gwent.available) && result.gwent.available >= 0,
  );
  return {
    updated_at: checkedAt,
    total: results.length,
    succeeded: results.filter((result) => okResult(result)).length,
    failed: results.filter((result) => !okResult(result)).length,
    balance_quota: totalQuota,
    balance_yuan: (totalQuota / settings.quota_per_cny).toFixed(6),
    gwent: {
      supported: supportedGwent.length,
      succeeded: supportedGwent.filter((result) => result.gwent.ok === true).length,
      failed: supportedGwent.filter((result) => result.gwent.ok !== true).length,
      known: knownGwent.length,
      available_total: knownGwent.reduce((sum, result) => sum + result.gwent.available, 0),
    },
    results,
  };
}

function mergedSettings(current, patch) {
  const input = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const checkinInput = input.checkin || {};
  const drawInput = input.draw || input.regular_draw || {};
  const quizInput = input.quiz || {};
  const adInput = input.ad || input.video || {};
  const rewardInput = input.reward_draw || input.post_reward_draw || {};
  const notificationInput = input.notifications || {};
  return normalizeSettings({
    ...current,
    ...input,
    automation_enabled:
      input.automation_enabled ?? input.master_enabled ?? input.enabled ?? current.automation_enabled,
    checkin: {
      ...current.checkin,
      ...checkinInput,
      daily_at: checkinInput.daily_at ?? checkinInput.time ?? current.checkin.daily_at,
    },
    draw: {
      ...current.draw,
      ...drawInput,
      anchor_local:
        drawInput.anchor_local ?? drawInput.anchor ?? drawInput.anchor_time ?? current.draw.anchor_local,
      share_bonus: input.share_bonus ?? drawInput.share_bonus ?? current.draw.share_bonus,
    },
    quiz: {
      ...current.quiz,
      ...quizInput,
      daily_at: quizInput.daily_at ?? quizInput.time ?? current.quiz.daily_at,
      draw_after_success:
        rewardInput.quiz ?? quizInput.draw_after_success ?? current.quiz.draw_after_success,
    },
    ad: {
      ...current.ad,
      ...adInput,
      anchor_local:
        adInput.anchor_local ?? adInput.anchor ?? adInput.anchor_time ?? current.ad.anchor_local,
      every_minutes:
        adInput.every_minutes ??
        adInput.poll_minutes ??
        adInput.poll_every_minutes ??
        current.ad.every_minutes,
      draw_after_claim:
        rewardInput.ad ?? adInput.draw_after_claim ?? current.ad.draw_after_claim,
    },
    notifications: { ...current.notifications, ...notificationInput },
  });
}

async function settingsWithAdminMetadata(env) {
  const settings = await settingsFor(env);
  const notificationConfig = await notificationConfigFor(env);
  return {
    ...settings,
    notifications: {
      ...settings.notifications,
      webhook_configured: Boolean(notificationConfig.dingtalk?.webhook),
    },
  };
}

function normalizedDingTalkConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const dingtalk = value.dingtalk && typeof value.dingtalk === "object" ? value.dingtalk : value;
  const normalized = {};
  if (typeof dingtalk.webhook === "string" && dingtalk.webhook.trim()) {
    normalized.webhook = dingtalk.webhook.trim();
  }
  if (typeof dingtalk.secret === "string" && dingtalk.secret) {
    normalized.secret = dingtalk.secret;
  }
  return normalized;
}

async function notificationConfigFor(env) {
  const stored = await readState(env, NOTIFICATION_CONFIG_KEY, { legacy: false });
  if (stored !== null) {
    return { schema_version: 1, dingtalk: normalizedDingTalkConfig(stored.value) };
  }
  try {
    const legacyConfig = await configFor(env);
    return { schema_version: 1, dingtalk: normalizedDingTalkConfig(legacyConfig?.dingtalk) };
  } catch {
    return { schema_version: 1, dingtalk: {} };
  }
}

async function updateNotificationWebhook(env, notifications) {
  if (!notifications || typeof notifications !== "object" || Array.isArray(notifications)) return;
  const clear = notifications.clear_webhook === true;
  const hasWebhook = Object.prototype.hasOwnProperty.call(notifications, "webhook");
  const hasSecret = Object.prototype.hasOwnProperty.call(notifications, "secret");
  if (!clear && !hasWebhook && !hasSecret) return;

  let normalizedUrl;
  if (!clear && hasWebhook) {
    const value = notifications.webhook;
    if (typeof value !== "string" || value.trim() === "") {
      throw new HttpError(400, "invalid_webhook", "通知 Webhook 地址无效。 ");
    }
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new HttpError(400, "invalid_webhook", "通知 Webhook 地址无效。 ");
    }
    if (url.protocol !== "https:") {
      throw new HttpError(400, "invalid_webhook", "通知 Webhook 必须使用 HTTPS。 ");
    }
    normalizedUrl = url.toString();
  }

  let normalizedSecret;
  if (!clear && hasSecret) {
    const value = notifications.secret;
    if (value === null || value === "") {
      normalizedSecret = null;
    } else if (
      typeof value !== "string" ||
      value.length > 1024 ||
      /[\r\n\u0000]/u.test(value)
    ) {
      throw new HttpError(400, "invalid_webhook_secret", "通知签名密钥无效。 ");
    } else {
      normalizedSecret = value;
    }
  }

  const current = await notificationConfigFor(env);
  const dingtalk = { ...current.dingtalk };
  if (clear) {
    delete dingtalk.webhook;
    delete dingtalk.secret;
  } else {
    if (normalizedUrl !== undefined) dingtalk.webhook = normalizedUrl;
    if (normalizedSecret === null) delete dingtalk.secret;
    else if (normalizedSecret !== undefined) dingtalk.secret = normalizedSecret;
  }
  await putState(env, NOTIFICATION_CONFIG_KEY, { schema_version: 1, dingtalk });
}

async function signedDingTalkUrl(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}\n${secret}`),
  );
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const url = new URL(webhook);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", btoa(binary));
  return url.toString();
}

async function notifyRun(env, summary, settings) {
  if (!settings.notifications.enabled) return;
  if (settings.notifications.errors_only && summary.status === "success") return;
  const dingtalk = (await notificationConfigFor(env)).dingtalk;
  if (!dingtalk?.webhook) return;
  const actionEnabled =
    summary.action === "checkin" ? settings.notifications.checkin : settings.notifications.draw;
  if (!actionEnabled && !(summary.status === "error" && settings.notifications.task_error)) return;
  try {
    const url = await signedDingTalkUrl(dingtalk.webhook, dingtalk.secret);
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        msgtype: "text",
        text: {
          content: `NewAPI 自动任务：${summary.action}\n状态：${summary.status}\n账号：${summary.total ?? "-"}\n翻牌：${summary.successful_draws ?? 0}\n额度：${summary.total_quota ?? 0}`,
        },
      }),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "notification_failed", error: safeError(error) }));
  }
}

async function executeScheduled(env, scheduledTime) {
  if (String(env.AUTOMATION_PAUSED || "").toLowerCase() === "true") {
    console.log(JSON.stringify({ event: "automation_paused", scheduled_time: scheduledTime }));
    return;
  }
  const date = new Date(scheduledTime);
  const settings = await settingsFor(env);
  const due = ["checkin", "quiz", "draw", "ad"].filter((task) => taskDue(settings, task, date));
  for (const task of due) {
    const slot = taskSlot(settings, task, date);
    const slotKey = `automation-slot:${slot}`;
    const owner = crypto.randomUUID();
    if (!(await claimLease(env, slotKey, owner, SCHEDULE_LEASE_SECONDS))) continue;
    try {
      const summary = await runAutomation(env, {
        action: task,
        trigger: "scheduled",
        slot,
        drawCount: settings.draw.draw_count,
      });
      await completeLease(env, slotKey, owner, summary.status, { run_id: summary.run_id });
      await notifyRun(env, summary, settings);
    } catch (error) {
      await completeLease(env, slotKey, owner, "error", { error: safeError(error) });
      console.error(JSON.stringify({ event: "scheduled_task_failed", task, slot, error: safeError(error) }));
    }
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  if (LEGACY_API_PATHS.has(url.pathname)) {
    if (LEGACY_WRITE_METHODS[url.pathname] === request.method) {
      requireLegacyWriteMode(env);
    }
    return handleLegacyRequest(request, legacyEnv(env), (target, init) => fetch(target, init));
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...JSON_HEADERS,
        "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key",
      },
    });
  }
  if (url.pathname === "/health" && request.method === "GET") {
    let accountCount = 0;
    let accountsConfigured = true;
    try {
      accountCount = (await accountsFor(env, { legacy: false })).length;
    } catch {
      accountsConfigured = false;
    }
    return json({
      ok: true,
      service: "NewAPI Cloudflare automation",
      storage: "D1",
      accounts_configured: accountsConfigured,
      account_count: accountCount,
      automation_paused: String(env.AUTOMATION_PAUSED || "").toLowerCase() === "true",
      now: new Date().toISOString(),
    });
  }
  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    return json(await dashboardData(env));
  }
  if (url.pathname === "/api/history/events") {
    if (request.method === "GET") return json(await historyEventsData(env, url));
    throw new HttpError(405, "method_not_allowed", "完整历史接口只支持 GET。 ");
  }
  if (url.pathname === "/api/admin/settings") {
    await requireAdmin(request, env);
    if (request.method === "GET") return json({ settings: await settingsWithAdminMetadata(env) });
    if (request.method === "PUT") {
      const payload = await readJson(request);
      const current = await settingsFor(env);
      const input = payload.settings || payload;
      const settings = mergedSettings(current, input);
      await putState(env, SETTINGS_KEY, settings);
      await updateNotificationWebhook(env, input?.notifications);
      return json({ success: true, settings: await settingsWithAdminMetadata(env) });
    }
    throw new HttpError(405, "method_not_allowed", "设置接口只支持 GET 和 PUT。 ");
  }
  if (url.pathname === "/api/admin/accounts") {
    await requireAdmin(request, env);
    if (request.method === "GET") return json(await adminAccountConfiguration(env));
    if (request.method === "PUT") {
      const payload = await readJson(request);
      return json(await saveAdminAccountConfiguration(env, payload));
    }
    throw new HttpError(405, "method_not_allowed", "账号接口只支持 GET 和 PUT。 ");
  }
  if (url.pathname === "/api/admin/run" && request.method === "POST") {
    await requireAdmin(request, env);
    const payload = await readJson(request);
    const summary = await runAutomation(env, {
      action: payload.action,
      trigger: "manual",
      accountKeys: payload.account_keys,
      drawCount: payload.draw_count,
      idempotencyKey: request.headers.get("idempotency-key") || payload.idempotency_key,
    });
    await notifyRun(env, summary, await settingsFor(env));
    return json(summary);
  }
  if (url.pathname === "/api/admin/balances" && ["GET", "POST"].includes(request.method)) {
    await requireAdmin(request, env);
    const payload = request.method === "POST" ? await readJson(request) : {};
    return json(await balancesData(env, payload.account_keys));
  }
  if (url.pathname === "/api/admin/migrate" && request.method === "POST") {
    await requireAdmin(request, env);
    const migration = await migrateLegacyState(env, KNOWN_LEGACY_KEYS);
    const historyBackfill = await backfillFullHistory(env);
    return json({ success: true, ...migration, history_backfill: historyBackfill });
  }

  const legacyManual = {
    "/run": "draw",
    "/checkin": "checkin",
    "/daily-quiz": "quiz",
    "/ad-task": "ad",
  };
  if (legacyManual[url.pathname] && request.method === "POST") {
    await requireAdmin(request, env);
    return json(
      await runAutomation(env, {
        action: legacyManual[url.pathname],
        trigger: "manual",
        accountKeys: ["all"],
        idempotencyKey: request.headers.get("idempotency-key") || crypto.randomUUID(),
      }),
    );
  }
  if (url.pathname === "/balances" && request.method === "POST") {
    await requireAdmin(request, env);
    return json(await balancesData(env));
  }
  if (url.pathname.startsWith("/api/")) {
    throw new HttpError(404, "not_found", "接口不存在。 ");
  }
  return null;
}

async function serveAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  if ((headers.get("content-type") || "").includes("text/html")) {
    headers.set("content-security-policy", STATIC_CONTENT_SECURITY_POLICY);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleRequest(request, env = {}) {
  try {
    const apiResponse = await handleApi(request, env);
    if (apiResponse !== null) return apiResponse;
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return serveAsset(request, env);
    }
    return json({
      ok: true,
      service: "NewAPI Cloudflare automation",
      dashboard: "/",
      health: "/health",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(executeScheduled(env, controller.scheduledTime));
  },
};

export {
  balancesData,
  dashboardData,
  executeScheduled,
  runAutomation,
  safeError,
};
