const CONFIG_API_PATH = "/api/config";
const HISTORY_API_PATH = "/api/gwent/history";
const SCHEDULE_API_PATH = "/api/gwent/schedule";
const UPSTREAM_ORIGIN = "https://dav.jianguoyun.com";
const DEFAULT_CONFIG_PATH = "/dav/newapi-config.json";
const KV_CONFIG_KEY = "newapi-config.json";
const KV_HISTORY_KEY = "gwent-history-v1.json";
const KV_SCHEDULE_KEY = "gwent-schedule-v1.json";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_HISTORY_EVENTS = 500;
const MAX_HISTORY_RUNS = 120;
const MAX_HISTORY_DAYS = 90;
const MAX_EVENTS_PER_RUN = 100;
const HISTORY_SOURCES = new Set(["gwent", "quiz", "ad"]);
const DEFAULT_GWENT_INTERVAL_SECONDS = 21_900;
const MAX_GWENT_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
const GWENT_LEASE_SECONDS = 15 * 60;
const MAX_SCHEDULE_TOKEN_LENGTH = 128;
const SENSITIVE_HISTORY_FIELD = /(?:authorization|cf_clearance|cookie|password|session|token)/iu;

class HttpError extends Error {
  constructor(status, code, message, details, headers) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

function allowedOrigins(value) {
  if (typeof value !== "string") {
    return new Set();
  }

  return new Set(
    value
      .split(/[\r\n,]+/u)
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function corsOriginFor(request, env) {
  const origin = request.headers.get("Origin");
  if (origin === null) {
    return undefined;
  }

  if (!allowedOrigins(env.ALLOWED_ORIGINS).has(origin)) {
    throw new HttpError(403, "origin_not_allowed", "This origin is not allowed.");
  }

  return origin;
}

function addCommonHeaders(headers, corsOrigin) {
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Origin");
  headers.set("X-Content-Type-Options", "nosniff");

  if (corsOrigin !== undefined) {
    headers.set("Access-Control-Allow-Origin", corsOrigin);
  }

  return headers;
}

function jsonError(error, corsOrigin) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal_error";
  const message =
    error instanceof HttpError ? error.message : "The Worker could not complete the request.";
  const payload = { error: { code, message } };

  if (error instanceof HttpError && error.details !== undefined) {
    payload.error.details = error.details;
  }

  const headers = new Headers(error instanceof HttpError ? error.headers : undefined);
  headers.set("Content-Type", "application/json; charset=utf-8");
  addCommonHeaders(headers, corsOrigin);

  return new Response(JSON.stringify(payload), { status, headers });
}

function optionsResponse(corsOrigin, methods) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": methods.join(", "),
  });
  addCommonHeaders(headers, corsOrigin);
  return new Response(null, { status: 204, headers });
}

function jsonResponse(payload, status, corsOrigin) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  addCommonHeaders(headers, corsOrigin);
  return new Response(JSON.stringify(payload), { status, headers });
}

function requiredSecret(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(
      500,
      "worker_not_configured",
      `Required Worker secret ${name} is not configured.`,
    );
  }
  return value;
}

function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return mismatch === 0;
}

function requireBearerToken(request, expectedTokens) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  const tokens = expectedTokens.filter(
    (token) => typeof token === "string" && token.length > 0,
  );
  const valid =
    match !== null &&
    tokens.reduce(
      (matched, token) => constantTimeEqual(match[1], token) || matched,
      false,
    );

  if (!valid) {
    throw new HttpError(401, "unauthorized", "A valid Bearer token is required.", undefined, {
      "WWW-Authenticate": 'Bearer realm="newapi-config"',
    });
  }
}

function resolveUpstreamUrl(value) {
  const path =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : DEFAULT_CONFIG_PATH;

  if (!path.startsWith("/dav/") || path.includes("\\")) {
    throw new HttpError(
      500,
      "invalid_worker_config",
      "JIANGUO_CONFIG_PATH must be an absolute path below /dav/.",
    );
  }

  let url;
  try {
    url = new URL(path, UPSTREAM_ORIGIN);
  } catch {
    throw new HttpError(
      500,
      "invalid_worker_config",
      "JIANGUO_CONFIG_PATH is not a valid path.",
    );
  }

  if (
    url.origin !== UPSTREAM_ORIGIN ||
    !url.pathname.startsWith("/dav/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new HttpError(
      500,
      "invalid_worker_config",
      "JIANGUO_CONFIG_PATH must stay on dav.jianguoyun.com below /dav/.",
    );
  }

  return url.toString();
}

function base64Encode(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    output += alphabet[(combined >>> 18) & 63];
    output += alphabet[(combined >>> 12) & 63];
    output += second === undefined ? "=" : alphabet[(combined >>> 6) & 63];
    output += third === undefined ? "=" : alphabet[combined & 63];
  }

  return output;
}

function basicAuthorization(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${base64Encode(bytes)}`;
}

function assertDeclaredSize(headers) {
  const contentLength = headers.get("Content-Length");
  if (contentLength === null || !/^\d+$/u.test(contentLength)) {
    return;
  }

  if (BigInt(contentLength) > BigInt(MAX_BODY_BYTES)) {
    throw new HttpError(
      413,
      "payload_too_large",
      `Request and response bodies are limited to ${MAX_BODY_BYTES} bytes.`,
    );
  }
}

async function readLimitedBody(message, tooLargeStatus = 413) {
  try {
    assertDeclaredSize(message.headers);
  } catch (error) {
    if (error instanceof HttpError && tooLargeStatus !== error.status) {
      throw new HttpError(
        tooLargeStatus,
        "upstream_payload_too_large",
        `The upstream response exceeds the ${MAX_BODY_BYTES} byte limit.`,
      );
    }
    throw error;
  }

  if (message.body === null) {
    return new Uint8Array();
  }

  const reader = message.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The size error below is the useful result even if cancellation fails.
      }

      if (tooLargeStatus === 413) {
        throw new HttpError(
          413,
          "payload_too_large",
          `Request and response bodies are limited to ${MAX_BODY_BYTES} bytes.`,
        );
      }

      throw new HttpError(
        tooLargeStatus,
        "upstream_payload_too_large",
        `The upstream response exceeds the ${MAX_BODY_BYTES} byte limit.`,
      );
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

async function callUpstream(request, env, upstreamFetch) {
  if (typeof upstreamFetch !== "function") {
    throw new HttpError(500, "worker_not_configured", "The Worker fetch API is unavailable.");
  }

  const username = requiredSecret(env, "JIANGUO_USERNAME");
  const password = requiredSecret(env, "JIANGUO_APP_PASSWORD");
  const upstreamUrl = resolveUpstreamUrl(env.JIANGUO_CONFIG_PATH);
  const headers = new Headers({
    Accept: "application/json",
    Authorization: basicAuthorization(username, password),
    "Cache-Control": "no-cache",
  });
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method === "PUT") {
    init.body = await readLimitedBody(request);
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  let upstream;
  try {
    upstream = await upstreamFetch(upstreamUrl, init);
  } catch {
    throw new HttpError(502, "upstream_unavailable", "The JianGuoYun WebDAV service is unavailable.");
  }

  const upstreamStatus = upstream.status === 520 ? 404 : upstream.status;

  if (!upstream.ok) {
    // JianGuoYun may expose a missing WebDAV object as 520 to Cloudflare's
    // egress while returning 404 to ordinary clients. For GET, both mean the
    // config has not been saved yet; PUT still treats 520 as an upstream error.
    if (request.method === "GET" && upstreamStatus === 404) {
      throw new HttpError(404, "config_not_found", "The config file has not been saved yet.");
    }

    throw new HttpError(502, "upstream_error", "The JianGuoYun WebDAV request failed.", {
      upstreamStatus: upstream.status,
    });
  }

  const body = await readLimitedBody(upstream, 502);
  return { upstream, body };
}

function upstreamResponse(upstream, body, corsOrigin) {
  const headers = new Headers();
  const contentType = upstream.headers.get("Content-Type");
  headers.set("Content-Type", contentType || "application/json; charset=utf-8");

  const exposed = [];
  for (const name of ["ETag", "Last-Modified"]) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
      exposed.push(name);
    }
  }
  if (exposed.length > 0) {
    headers.set("Access-Control-Expose-Headers", exposed.join(", "));
  }

  addCommonHeaders(headers, corsOrigin);
  const bodyless = [204, 205, 304].includes(upstream.status);
  return new Response(bodyless ? null : body, {
    status: upstream.status,
    headers,
  });
}

async function callKv(request, env) {
  if (request.method === "GET") {
    const value = await env.CONFIG_KV.get(KV_CONFIG_KEY);
    if (value === null) {
      throw new HttpError(404, "config_not_found", "The config file has not been saved yet.");
    }

    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    addCommonHeaders(headers);
    return new Response(value, { status: 200, headers });
  }

  const body = await readLimitedBody(request);
  const value = new TextDecoder().decode(body);
  try {
    JSON.parse(value);
  } catch {
    throw new HttpError(400, "invalid_json", "The config must be valid JSON.");
  }
  await env.CONFIG_KV.put(KV_CONFIG_KEY, value);

  const headers = new Headers();
  addCommonHeaders(headers);
  return new Response(null, { status: 204, headers });
}

function emptySchedule() {
  return {
    schema_version: 1,
    completed_at: null,
    last_claimed_at: null,
    last_completed_token: null,
    lease: null,
    updated_at: null,
  };
}

function parseScheduleTimestamp(value, name, status = 500) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) {
    const code = status === 400 ? "invalid_schedule" : "schedule_corrupt";
    throw new HttpError(status, code, `${name} is invalid.`);
  }
  return value;
}

function normalizeStoredSchedule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1) {
    throw new HttpError(500, "schedule_corrupt", "Stored schedule state is invalid.");
  }

  const completedAt =
    value.completed_at === null || value.completed_at === undefined
      ? null
      : parseScheduleTimestamp(value.completed_at, "completed_at");
  const lastClaimedAt =
    value.last_claimed_at === null || value.last_claimed_at === undefined
      ? null
      : parseScheduleTimestamp(value.last_claimed_at, "last_claimed_at");
  const lastCompletedToken =
    value.last_completed_token === null || value.last_completed_token === undefined
      ? null
      : scheduleToken(value.last_completed_token, "last_completed_token", 500);
  let lease = null;
  if (value.lease !== null && value.lease !== undefined) {
    if (!value.lease || typeof value.lease !== "object" || Array.isArray(value.lease)) {
      throw new HttpError(500, "schedule_corrupt", "Stored schedule lease is invalid.");
    }
    const token = value.lease.token;
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > MAX_SCHEDULE_TOKEN_LENGTH ||
      !/^[A-Za-z0-9:_-]+$/u.test(token)
    ) {
      throw new HttpError(500, "schedule_corrupt", "Stored schedule lease token is invalid.");
    }
    lease = {
      token,
      claimed_at: parseScheduleTimestamp(value.lease.claimed_at, "lease.claimed_at"),
      expires_at: parseScheduleTimestamp(value.lease.expires_at, "lease.expires_at"),
    };
  }

  return {
    schema_version: 1,
    completed_at: completedAt,
    last_claimed_at: lastClaimedAt || (lease === null ? null : lease.claimed_at),
    last_completed_token: lastCompletedToken,
    lease,
    updated_at:
      value.updated_at === null || value.updated_at === undefined
        ? null
        : parseScheduleTimestamp(value.updated_at, "updated_at"),
  };
}

async function readSchedule(env) {
  const value = await env.CONFIG_KV.get(KV_SCHEDULE_KEY);
  if (value === null) {
    return emptySchedule();
  }

  try {
    return normalizeStoredSchedule(JSON.parse(value));
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(500, "schedule_corrupt", "Stored schedule state is not valid JSON.");
  }
}

async function writeSchedule(env, state) {
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(500, "schedule_too_large", "Stored schedule state exceeds the size limit.");
  }
  await env.CONFIG_KV.put(KV_SCHEDULE_KEY, serialized);
}

function scheduleToken(value, name = "lease_token", status = 400) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SCHEDULE_TOKEN_LENGTH ||
    !/^[A-Za-z0-9:_-]+$/u.test(value)
  ) {
    throw new HttpError(
      status,
      status === 400 ? "invalid_schedule" : "schedule_corrupt",
      `${name} is invalid.`,
    );
  }
  return value;
}

function normalizeSchedulePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "invalid_schedule", "Schedule payload must be an object.");
  }
  if (payload.action !== "claim" && payload.action !== "complete") {
    throw new HttpError(400, "invalid_schedule", "action must be claim or complete.");
  }

  const normalized = {
    action: payload.action,
    lease_token: scheduleToken(payload.lease_token),
    min_interval_seconds: DEFAULT_GWENT_INTERVAL_SECONDS,
    force: false,
    completed_at: null,
  };

  if (payload.min_interval_seconds !== undefined) {
    if (
      !Number.isSafeInteger(payload.min_interval_seconds) ||
      payload.min_interval_seconds < DEFAULT_GWENT_INTERVAL_SECONDS ||
      payload.min_interval_seconds > MAX_GWENT_INTERVAL_SECONDS
    ) {
      throw new HttpError(
        400,
        "invalid_schedule",
        `min_interval_seconds must be at least ${DEFAULT_GWENT_INTERVAL_SECONDS}.`,
      );
    }
    normalized.min_interval_seconds = payload.min_interval_seconds;
  }

  if (payload.force !== undefined) {
    if (typeof payload.force !== "boolean") {
      throw new HttpError(400, "invalid_schedule", "force is invalid.");
    }
    normalized.force = payload.force;
  }

  if (payload.completed_at !== undefined && payload.completed_at !== null) {
    normalized.completed_at = parseScheduleTimestamp(payload.completed_at, "completed_at", 400);
  }

  return normalized;
}

function secondsUntil(timestampMs, nowMs) {
  return Math.max(1, Math.ceil((timestampMs - nowMs) / 1000));
}

async function handleSchedule(request, env, corsOrigin) {
  if (!env.CONFIG_KV || typeof env.CONFIG_KV.get !== "function" || typeof env.CONFIG_KV.put !== "function") {
    throw new HttpError(500, "worker_not_configured", "CONFIG_KV is not configured.");
  }

  const actionsToken = requiredSecret(env, "ACTIONS_TOKEN");
  requireBearerToken(request, [actionsToken]);

  const body = await readLimitedBody(request);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "invalid_json", "Schedule payload must be valid JSON.");
  }

  const input = normalizeSchedulePayload(payload);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  if (input.completed_at !== null && Date.parse(input.completed_at) > nowMs) {
    throw new HttpError(400, "invalid_schedule", "completed_at cannot be in the future.");
  }
  const state = await readSchedule(env);

  if (input.action === "claim") {
    if (state.lease !== null) {
      const leaseExpiresMs = Date.parse(state.lease.expires_at);
      if (leaseExpiresMs > nowMs) {
        if (constantTimeEqual(state.lease.token, input.lease_token)) {
          // A retry after a lost response is safe to treat as the original claim.
          return jsonResponse(
            {
              success: true,
              due: true,
              claimed: false,
              reused: true,
              completed_at: state.completed_at,
              lease_expires_at: state.lease.expires_at,
              lease_seconds: secondsUntil(leaseExpiresMs, nowMs),
            },
            200,
            corsOrigin,
          );
        }
        return jsonResponse(
          {
            success: true,
            due: false,
            claimed: false,
            reason: "lease_active",
            completed_at: state.completed_at,
            lease_expires_at: state.lease.expires_at,
            retry_after_seconds: secondsUntil(leaseExpiresMs, nowMs),
          },
          200,
          corsOrigin,
        );
      }
      // An expired lease cannot block a new scheduled run. It is replaced below.
    }

    const completedMs = state.completed_at === null ? null : Date.parse(state.completed_at);
    const claimedMs = state.last_claimed_at === null ? null : Date.parse(state.last_claimed_at);
    const gateMs = Math.max(completedMs ?? Number.NEGATIVE_INFINITY, claimedMs ?? Number.NEGATIVE_INFINITY);
    if (
      !input.force &&
      Number.isFinite(gateMs) &&
      nowMs < gateMs + input.min_interval_seconds * 1000
    ) {
      return jsonResponse(
        {
          success: true,
          due: false,
          claimed: false,
          reason: "interval",
          completed_at: state.completed_at,
          lease_expires_at: null,
          retry_after_seconds: secondsUntil(
            gateMs + input.min_interval_seconds * 1000,
            nowMs,
          ),
        },
        200,
        corsOrigin,
      );
    }

    const leaseExpiresAt = new Date(nowMs + GWENT_LEASE_SECONDS * 1000).toISOString();
    const nextState = {
      schema_version: 1,
      completed_at: state.completed_at,
      last_claimed_at: now,
      last_completed_token: state.last_completed_token,
      lease: {
        token: input.lease_token,
        claimed_at: now,
        expires_at: leaseExpiresAt,
      },
      updated_at: now,
    };
    await writeSchedule(env, nextState);
    return jsonResponse(
      {
        success: true,
        due: true,
        claimed: true,
        completed_at: nextState.completed_at,
        lease_expires_at: leaseExpiresAt,
        lease_seconds: GWENT_LEASE_SECONDS,
      },
      200,
      corsOrigin,
    );
  }

  if (state.lease === null) {
    if (
      state.last_completed_token !== null &&
      constantTimeEqual(state.last_completed_token, input.lease_token)
    ) {
      return jsonResponse(
        {
          success: true,
          completed: true,
          idempotent: true,
          completed_at: state.completed_at,
        },
        200,
        corsOrigin,
      );
    }
    throw new HttpError(409, "schedule_lease_missing", "No active schedule lease exists.");
  }
  if (!constantTimeEqual(state.lease.token, input.lease_token)) {
    throw new HttpError(409, "schedule_lease_not_owned", "The schedule lease belongs to another run.");
  }

  const completedAt = input.completed_at || now;
  const nextState = {
    schema_version: 1,
    completed_at: completedAt,
    last_claimed_at: state.last_claimed_at,
    last_completed_token: input.lease_token,
    lease: null,
    updated_at: now,
  };
  await writeSchedule(env, nextState);
  return jsonResponse(
    {
      success: true,
      completed: true,
      completed_at: completedAt,
    },
    200,
    corsOrigin,
  );
}

function emptyHistory() {
  return {
    schema_version: 1,
    updated_at: null,
    totals: {
      total_runs: 0,
      total_draws: 0,
      total_wins: 0,
      total_quota: 0,
      total_accounts: 0,
    },
    accounts: [],
    prizes: [],
    events: [],
    runs: [],
    daily: [],
  };
}

function containsSensitiveHistoryField(value) {
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveHistoryField(item));
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    ([key, item]) => SENSITIVE_HISTORY_FIELD.test(key) || containsSensitiveHistoryField(item),
  );
}

function requiredHistoryString(value, name, maxLength, pattern) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, "invalid_history", `${name} is invalid.`);
  }
  if (pattern && !pattern.test(value)) {
    throw new HttpError(400, "invalid_history", `${name} is invalid.`);
  }
  return value;
}

function optionalHistoryString(value, name, maxLength) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpError(400, "invalid_history", `${name} is invalid.`);
  }
  return value;
}

function historyInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new HttpError(400, "invalid_history", `${name} is invalid.`);
  }
  return value;
}

function historyTimestamp(value, name) {
  const timestamp = requiredHistoryString(value, name, 40);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new HttpError(400, "invalid_history", `${name} is invalid.`);
  }
  return timestamp;
}

function normalizeHistoryPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "invalid_history", "History payload must be an object.");
  }
  if (containsSensitiveHistoryField(payload)) {
    throw new HttpError(400, "sensitive_history_field", "History payload contains a sensitive field.");
  }
  if (payload.schema_version !== 1 || !payload.run || !Array.isArray(payload.events)) {
    throw new HttpError(400, "invalid_history", "History payload schema is invalid.");
  }
  if (payload.events.length > MAX_EVENTS_PER_RUN) {
    throw new HttpError(400, "invalid_history", "History payload has too many events.");
  }

  const runStatuses = new Set(["success", "partial", "error"]);
  const eventStatuses = new Set(["success", "cooldown", "auth", "error"]);
  const rarities = new Set(["common", "rare", "epic", "legendary", "unknown"]);
  const source = optionalHistoryString(payload.run.source, "run.source", 16) || "gwent";
  if (!HISTORY_SOURCES.has(source)) {
    throw new HttpError(400, "invalid_history", "run.source is invalid.");
  }
  const run = {
    run_id: requiredHistoryString(payload.run.run_id, "run.run_id", 96, /^[A-Za-z0-9:_-]+$/u),
    run_number: historyInteger(payload.run.run_number, "run.run_number"),
    run_attempt: historyInteger(payload.run.run_attempt, "run.run_attempt", 1000),
    started_at: historyTimestamp(payload.run.started_at, "run.started_at"),
    finished_at: historyTimestamp(payload.run.finished_at, "run.finished_at"),
    planned_draws: historyInteger(payload.run.planned_draws, "run.planned_draws", 20),
    status: requiredHistoryString(payload.run.status, "run.status", 16),
    source,
  };
  if (!runStatuses.has(run.status)) {
    throw new HttpError(400, "invalid_history", "run.status is invalid.");
  }

  const events = payload.events.map((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new HttpError(400, "invalid_history", `events[${index}] is invalid.`);
    }
    const normalized = {
      event_id: requiredHistoryString(
        event.event_id,
        `events[${index}].event_id`,
        128,
        /^[A-Za-z0-9:_-]+$/u,
      ),
      account_key: requiredHistoryString(
        event.account_key,
        `events[${index}].account_key`,
        32,
        /^[a-f0-9]{16,32}$/u,
      ),
      account_name: requiredHistoryString(event.account_name, `events[${index}].account_name`, 64),
      attempt: historyInteger(event.attempt, `events[${index}].attempt`, 20),
      occurred_at: historyTimestamp(event.occurred_at, `events[${index}].occurred_at`),
      status: requiredHistoryString(event.status, `events[${index}].status`, 16),
      prize_name: optionalHistoryString(event.prize_name, `events[${index}].prize_name`, 80),
      prize_quota: historyInteger(event.prize_quota ?? 0, `events[${index}].prize_quota`, 1e12),
      prize_rarity: optionalHistoryString(
        event.prize_rarity,
        `events[${index}].prize_rarity`,
        16,
      ) || "unknown",
      bonus_percent: historyInteger(
        event.bonus_percent ?? 0,
        `events[${index}].bonus_percent`,
        1000,
      ),
      message: optionalHistoryString(event.message, `events[${index}].message`, 240),
      task_type: optionalHistoryString(event.task_type, `events[${index}].task_type`, 16) || source,
    };
    if (
      !eventStatuses.has(normalized.status) ||
      !rarities.has(normalized.prize_rarity) ||
      !HISTORY_SOURCES.has(normalized.task_type)
    ) {
      throw new HttpError(400, "invalid_history", `events[${index}] has an invalid enum value.`);
    }
    return normalized;
  });

  return { run, events };
}

function beijingDate(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

async function readHistory(env) {
  const value = await env.CONFIG_KV.get(KV_HISTORY_KEY);
  if (value === null) {
    return emptyHistory();
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && parsed.schema_version === 1 ? parsed : emptyHistory();
  } catch {
    throw new HttpError(500, "history_corrupt", "Stored history is not valid JSON.");
  }
}

function mergeHistory(history, input) {
  if (history.runs.some((run) => run.run_id === input.run.run_id)) {
    return { history, duplicate: true };
  }

  const accounts = new Map(history.accounts.map((account) => [account.account_key, account]));
  const prizes = new Map((history.prizes || []).map((prize) => [prize.prize_name, prize]));
  const daily = new Map(history.daily.map((day) => [day.date, day]));
  let successfulDraws = 0;
  let totalQuota = 0;

  for (const event of input.events) {
    const account = accounts.get(event.account_key) || {
      account_key: event.account_key,
      account_name: event.account_name,
      total_draws: 0,
      total_wins: 0,
      total_quota: 0,
      last_event_at: null,
      last_status: null,
    };
    account.account_name = event.account_name;
    account.last_event_at = event.occurred_at;
    account.last_status = event.status;

    if (event.status === "success") {
      successfulDraws += 1;
      totalQuota += event.prize_quota;
      history.totals.total_draws += 1;
      history.totals.total_quota += event.prize_quota;
      account.total_draws += 1;
      account.total_quota += event.prize_quota;
      if (event.prize_quota > 0) {
        history.totals.total_wins += 1;
        account.total_wins += 1;
      }

      const prizeName = event.prize_name || "未知奖品";
      const prize = prizes.get(prizeName) || {
        prize_name: prizeName,
        prize_rarity: event.prize_rarity,
        total_draws: 0,
        total_quota: 0,
      };
      prize.prize_rarity = event.prize_rarity;
      prize.total_draws += 1;
      prize.total_quota += event.prize_quota;
      prizes.set(prizeName, prize);

      const date = beijingDate(event.occurred_at);
      const day = daily.get(date) || { date, total_draws: 0, total_wins: 0, total_quota: 0 };
      day.total_draws += 1;
      day.total_quota += event.prize_quota;
      if (event.prize_quota > 0) day.total_wins += 1;
      daily.set(date, day);
    }
    accounts.set(event.account_key, account);
  }

  history.totals.total_runs += 1;
  history.totals.total_accounts = accounts.size;
  history.accounts = [...accounts.values()].sort((left, right) =>
    left.account_name.localeCompare(right.account_name, "zh-CN"),
  );
  history.prizes = [...prizes.values()].sort((left, right) =>
    right.total_draws - left.total_draws || right.total_quota - left.total_quota,
  );
  history.events = [
    ...input.events.map((event) => ({ ...event, run_id: input.run.run_id })),
    ...history.events,
  ].slice(0, MAX_HISTORY_EVENTS);
  history.runs = [
    {
      ...input.run,
      account_count: new Set(input.events.map((event) => event.account_key)).size,
      successful_draws: successfulDraws,
      total_quota: totalQuota,
    },
    ...history.runs,
  ].slice(0, MAX_HISTORY_RUNS);
  history.daily = [...daily.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-MAX_HISTORY_DAYS);
  history.updated_at = input.run.finished_at;
  return { history, duplicate: false };
}

async function handleHistory(request, env, corsOrigin) {
  if (!env.CONFIG_KV || typeof env.CONFIG_KV.get !== "function") {
    throw new HttpError(500, "worker_not_configured", "CONFIG_KV is not configured.");
  }
  if (request.method === "GET") {
    return jsonResponse(await readHistory(env), 200, corsOrigin);
  }

  const actionsToken = requiredSecret(env, "ACTIONS_TOKEN");
  requireBearerToken(request, [actionsToken]);
  const body = await readLimitedBody(request);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "invalid_json", "History payload must be valid JSON.");
  }

  const input = normalizeHistoryPayload(payload);
  const current = await readHistory(env);
  const { history, duplicate } = mergeHistory(current, input);
  const serialized = JSON.stringify(history);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(500, "history_too_large", "Stored history exceeds the size limit.");
  }
  if (!duplicate) {
    await env.CONFIG_KV.put(KV_HISTORY_KEY, serialized);
  }
  return jsonResponse({ success: true, duplicate, updated_at: history.updated_at }, 200, corsOrigin);
}

export async function handleRequest(request, env = {}, upstreamFetch) {
  let corsOrigin;

  try {
    const url = new URL(request.url);
    if (![CONFIG_API_PATH, HISTORY_API_PATH, SCHEDULE_API_PATH].includes(url.pathname)) {
      throw new HttpError(404, "not_found", "Endpoint not found.");
    }

    corsOrigin = corsOriginFor(request, env);

    if (url.pathname === HISTORY_API_PATH) {
      if (request.method === "OPTIONS") {
        return optionsResponse(corsOrigin, ["GET", "POST", "OPTIONS"]);
      }
      if (!["GET", "POST"].includes(request.method)) {
        throw new HttpError(405, "method_not_allowed", "Only GET, POST, and OPTIONS are supported.", undefined, {
          Allow: "GET, POST, OPTIONS",
        });
      }
      return await handleHistory(request, env, corsOrigin);
    }

    if (url.pathname === SCHEDULE_API_PATH) {
      if (request.method === "OPTIONS") {
        const requestedMethod = request.headers.get("Access-Control-Request-Method");
        if (requestedMethod !== null && requestedMethod.toUpperCase() !== "POST") {
          throw new HttpError(
            405,
            "method_not_allowed",
            "Only POST may be preflighted.",
            undefined,
            { Allow: "POST, OPTIONS" },
          );
        }
        return optionsResponse(corsOrigin, ["POST", "OPTIONS"]);
      }
      if (request.method !== "POST") {
        throw new HttpError(
          405,
          "method_not_allowed",
          "Only POST and OPTIONS are supported.",
          undefined,
          { Allow: "POST, OPTIONS" },
        );
      }
      return await handleSchedule(request, env, corsOrigin);
    }

    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("Access-Control-Request-Method");
      if (requestedMethod !== null && !["GET", "PUT"].includes(requestedMethod.toUpperCase())) {
        throw new HttpError(405, "method_not_allowed", "Only GET and PUT may be preflighted.", undefined, {
          Allow: "GET, PUT, OPTIONS",
        });
      }
      return optionsResponse(corsOrigin, ["GET", "PUT", "OPTIONS"]);
    }

    if (!["GET", "PUT"].includes(request.method)) {
      throw new HttpError(405, "method_not_allowed", "Only GET, PUT, and OPTIONS are supported.", undefined, {
        Allow: "GET, PUT, OPTIONS",
      });
    }

    const syncToken = requiredSecret(env, "SYNC_TOKEN");
    requireBearerToken(
      request,
      request.method === "GET" ? [syncToken, env.ACTIONS_TOKEN] : [syncToken],
    );

    if (env.CONFIG_KV && typeof env.CONFIG_KV.get === "function") {
      const response = await callKv(request, env);
      const headers = new Headers(response.headers);
      if (corsOrigin !== undefined) {
        headers.set("Access-Control-Allow-Origin", corsOrigin);
      }
      return new Response(response.body, { status: response.status, headers });
    }

    const { upstream, body } = await callUpstream(request, env, upstreamFetch);
    return upstreamResponse(upstream, body, corsOrigin);
  } catch (error) {
    return jsonError(error, corsOrigin);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env, (url, init) => fetch(url, init));
  },
};
