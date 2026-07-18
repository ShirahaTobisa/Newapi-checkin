import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/index.mjs";

const MAX_BODY_BYTES = 256 * 1024;

const endpoint = "https://relay.example/api/config";
const historyEndpoint = "https://relay.example/api/gwent/history";
const scheduleEndpoint = "https://relay.example/api/gwent/schedule";
const defaultEnv = {
  ALLOWED_ORIGINS: "https://app.example, null",
  JIANGUO_USERNAME: "user@example.com",
  JIANGUO_APP_PASSWORD: "应用密码",
  SYNC_TOKEN: "sync-secret",
};

function request(method, { origin = "https://app.example", headers = {}, body } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== null) {
    requestHeaders.set("Origin", origin);
  }
  if ((method === "GET" || method === "PUT") && !requestHeaders.has("Authorization")) {
    requestHeaders.set("Authorization", "Bearer sync-secret");
  }

  return new Request(endpoint, { method, headers: requestHeaders, body });
}

async function errorBody(response) {
  assert.match(response.headers.get("Content-Type"), /^application\/json/u);
  return response.json();
}

function historyRequest(method, { origin = "https://app.example", headers = {}, body } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== null) requestHeaders.set("Origin", origin);
  if (method === "POST" && !requestHeaders.has("Authorization")) {
    requestHeaders.set("Authorization", "Bearer actions-secret");
  }
  return new Request(historyEndpoint, { method, headers: requestHeaders, body });
}

function scheduleRequest(method, { origin = "https://app.example", headers = {}, body } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== null) requestHeaders.set("Origin", origin);
  if (method === "POST" && !requestHeaders.has("Authorization")) {
    requestHeaders.set("Authorization", "Bearer actions-secret");
  }
  return new Request(scheduleEndpoint, { method, headers: requestHeaders, body });
}

function mockKv(initialValue = null) {
  let value = initialValue;
  return {
    async get(key) {
      assert.equal(key, "newapi-config.json");
      return value;
    },
    async put(key, nextValue) {
      assert.equal(key, "newapi-config.json");
      value = nextValue;
    },
  };
}

function mockHistoryKv(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set("gwent-history-v1.json", initialValue);
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    value(key) {
      return values.get(key) ?? null;
    },
  };
}

function mockScheduleKv(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set("gwent-schedule-v1.json", initialValue);
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    value(key) {
      return values.get(key) ?? null;
    },
  };
}

function historyPayload() {
  return {
    schema_version: 1,
    run: {
      run_id: "12345:1",
      run_number: 9,
      run_attempt: 1,
      started_at: "2026-07-17T01:00:00Z",
      finished_at: "2026-07-17T01:00:10Z",
      planned_draws: 3,
      status: "partial",
    },
    events: [
      {
        event_id: "12345:1:abcdef1234567890:1",
        account_key: "abcdef1234567890",
        account_name: "账号1",
        attempt: 1,
        occurred_at: "2026-07-17T01:00:02Z",
        status: "success",
        prize_name: "小额惊喜",
        prize_quota: 1000,
        prize_rarity: "rare",
        bonus_percent: 50,
        message: "翻牌成功",
      },
      {
        event_id: "12345:1:abcdef1234567890:2",
        account_key: "abcdef1234567890",
        account_name: "账号1",
        attempt: 2,
        occurred_at: "2026-07-17T01:00:03Z",
        status: "cooldown",
        prize_name: null,
        prize_quota: 0,
        prize_rarity: "unknown",
        bonus_percent: 0,
        message: "还在冷却中",
      },
    ],
  };
}

test("schedule endpoint exposes only POST and OPTIONS and requires Actions token", async () => {
  const env = { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: mockScheduleKv() };
  const options = await handleRequest(scheduleRequest("OPTIONS"), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");

  const badPreflight = await handleRequest(
    scheduleRequest("OPTIONS", { headers: { "Access-Control-Request-Method": "GET" } }),
    env,
  );
  assert.equal(badPreflight.status, 405);

  const unauthorized = await handleRequest(
    scheduleRequest("POST", {
      headers: { Authorization: "Bearer wrong" },
      body: JSON.stringify({ action: "claim", lease_token: "1:1" }),
    }),
    env,
  );
  assert.equal(unauthorized.status, 401);

  const method = await handleRequest(new Request(scheduleEndpoint, { method: "GET" }), env);
  assert.equal(method.status, 405);
  assert.equal((await errorBody(method)).error.code, "method_not_allowed");
});

test("schedule claim persists a lease and blocks other runs", async () => {
  const kv = mockScheduleKv();
  const env = { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: kv };
  const claim = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T00",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );
  const claimBody = await claim.json();
  assert.equal(claim.status, 200);
  assert.equal(claimBody.due, true);
  assert.equal(claimBody.claimed, true);
  assert.match(claimBody.lease_expires_at, /^\d{4}-\d{2}-\d{2}T/u);

  const stored = JSON.parse(kv.value("gwent-schedule-v1.json"));
  assert.equal(stored.lease.token, "scheduled:20260718T00");
  assert.equal(stored.last_claimed_at, stored.lease.claimed_at);
  assert.equal(stored.last_claimed_token, "scheduled:20260718T00");

  const blocked = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T02",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );
  const blockedBody = await blocked.json();
  assert.equal(blocked.status, 200);
  assert.equal(blockedBody.due, false);
  assert.equal(blockedBody.reason, "lease_active");

  const retry = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T00",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.due, true);
  assert.equal(retryBody.claimed, false);
  assert.equal(retryBody.reused, true);
});

test("schedule complete validates ownership, is idempotent, and blocks completed slot replay", async () => {
  const kv = mockScheduleKv();
  const env = { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: kv };
  await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T00",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );

  const wrong = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({ action: "complete", lease_token: "scheduled:20260718T02" }),
    }),
    env,
  );
  assert.equal(wrong.status, 409);
  assert.equal((await errorBody(wrong)).error.code, "schedule_lease_not_owned");

  const complete = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({ action: "complete", lease_token: "scheduled:20260718T00" }),
    }),
    env,
  );
  const completeBody = await complete.json();
  assert.equal(complete.status, 200);
  assert.equal(completeBody.completed, true);

  const repeat = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({ action: "complete", lease_token: "scheduled:20260718T00" }),
    }),
    env,
  );
  const repeatBody = await repeat.json();
  assert.equal(repeat.status, 200);
  assert.equal(repeatBody.idempotent, true);

  const duplicate = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T00",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );
  const duplicateBody = await duplicate.json();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.due, false);
  assert.equal(duplicateBody.reason, "duplicate_slot");
});

test("a new two-hour slot is due even when the previous run completed recently", async () => {
  const now = Date.now();
  const completedAt = new Date(now - 60_000).toISOString();
  const claimedAt = new Date(now - 120_000).toISOString();
  const kv = mockScheduleKv(
    JSON.stringify({
      schema_version: 1,
      completed_at: completedAt,
      last_claimed_at: claimedAt,
      last_claimed_token: "scheduled:20260718T00",
      last_completed_token: "scheduled:20260718T00",
      lease: null,
      updated_at: completedAt,
    }),
  );
  const env = { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: kv };
  const response = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T02",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.due, true);
  assert.equal(body.claimed, true);

  const stored = JSON.parse(kv.value("gwent-schedule-v1.json"));
  assert.equal(stored.completed_at, completedAt);
  assert.equal(stored.last_claimed_token, "scheduled:20260718T02");
});

test("an expired legacy lease fails closed for the same slot but permits the next slot", async () => {
  const now = Date.now();
  const claimedAt = new Date(now - 16 * 60_000).toISOString();
  const kv = mockScheduleKv(
    JSON.stringify({
      schema_version: 1,
      completed_at: null,
      last_claimed_at: claimedAt,
      last_completed_token: null,
      lease: {
        token: "scheduled:20260718T02",
        claimed_at: claimedAt,
        expires_at: new Date(now - 60_000).toISOString(),
      },
      updated_at: claimedAt,
    }),
  );
  const env = { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: kv };
  const duplicate = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T02",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );
  const duplicateBody = await duplicate.json();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.due, false);
  assert.equal(duplicateBody.reason, "duplicate_slot");

  const nextSlot = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T04",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );
  const nextSlotBody = await nextSlot.json();
  assert.equal(nextSlot.status, 200);
  assert.equal(nextSlotBody.due, true);
  assert.equal(nextSlotBody.claimed, true);
});

test("old schema-v1 completed state derives the claimed token safely", async () => {
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  const kv = mockScheduleKv(
    JSON.stringify({
      schema_version: 1,
      completed_at: completedAt,
      last_claimed_at: completedAt,
      last_completed_token: "scheduled:20260718T00",
      lease: null,
      updated_at: completedAt,
    }),
  );
  const env = { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: kv };
  const response = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "scheduled:20260718T00",
        min_interval_seconds: 0,
      }),
    }),
    env,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.due, false);
  assert.equal(body.reason, "duplicate_slot");
});

test("legacy clients default to two hours and manual force can bypass the interval", async () => {
  const now = new Date().toISOString();
  const kv = mockScheduleKv(
    JSON.stringify({
      schema_version: 1,
      completed_at: now,
      last_claimed_at: now,
      last_claimed_token: "legacy:200",
      last_completed_token: "legacy:200",
      lease: null,
      updated_at: now,
    }),
  );
  const env = { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: kv };
  const tooSoon = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "legacy:201",
      }),
    }),
    env,
  );
  const tooSoonBody = await tooSoon.json();
  assert.equal(tooSoon.status, 200);
  assert.equal(tooSoonBody.due, false);
  assert.equal(tooSoonBody.reason, "interval");
  assert.ok(tooSoonBody.retry_after_seconds >= 7199);
  assert.ok(tooSoonBody.retry_after_seconds <= 7200);

  const forced = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({ action: "claim", lease_token: "manual:20260718T0205", force: true }),
    }),
    env,
  );
  assert.equal(forced.status, 200);
  const forcedBody = await forced.json();
  assert.equal(forcedBody.due, true);
  assert.equal(forcedBody.claimed, true);
});

test("schedule rejects malformed payloads and fails closed on corrupt state", async () => {
  const env = { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: mockScheduleKv() };
  const invalid = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({ action: "claim", lease_token: "bad token" }),
    }),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.equal((await errorBody(invalid)).error.code, "invalid_schedule");

  const shortInterval = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "claim",
        lease_token: "401:1",
        min_interval_seconds: 7199,
      }),
    }),
    env,
  );
  assert.equal(shortInterval.status, 400);
  assert.equal((await errorBody(shortInterval)).error.code, "invalid_schedule");

  const future = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({
        action: "complete",
        lease_token: "402:1",
        completed_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    }),
    env,
  );
  assert.equal(future.status, 400);
  assert.equal((await errorBody(future)).error.code, "invalid_schedule");

  const corruptEnv = {
    ...defaultEnv,
    ACTIONS_TOKEN: "actions-secret",
    CONFIG_KV: mockScheduleKv("not-json"),
  };
  const corrupt = await handleRequest(
    scheduleRequest("POST", {
      body: JSON.stringify({ action: "claim", lease_token: "400:1" }),
    }),
    corruptEnv,
  );
  assert.equal(corrupt.status, 500);
  assert.equal((await errorBody(corrupt)).error.code, "schedule_corrupt");
});

test("public history GET returns an empty safe document", async () => {
  const response = await handleRequest(
    historyRequest("GET"),
    { ...defaultEnv, CONFIG_KV: mockHistoryKv(), ACTIONS_TOKEN: "actions-secret" },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  assert.equal(body.totals.total_draws, 0);
  assert.deepEqual(body.events, []);
});

test("history POST aggregates events and is idempotent per run", async () => {
  const kv = mockHistoryKv();
  const env = { ...defaultEnv, CONFIG_KV: kv, ACTIONS_TOKEN: "actions-secret" };
  const payload = JSON.stringify(historyPayload());

  const first = await handleRequest(historyRequest("POST", { body: payload }), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, false);

  const duplicate = await handleRequest(historyRequest("POST", { body: payload }), env);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const stored = JSON.parse(kv.value("gwent-history-v1.json"));
  assert.equal(stored.totals.total_runs, 1);
  assert.equal(stored.totals.total_draws, 1);
  assert.equal(stored.totals.total_wins, 1);
  assert.equal(stored.totals.total_quota, 1000);
  assert.equal(stored.accounts[0].total_draws, 1);
  assert.equal(stored.prizes[0].prize_name, "小额惊喜");
  assert.equal(stored.prizes[0].total_draws, 1);
  assert.equal(stored.events.length, 2);
  assert.equal(stored.daily[0].date, "2026-07-17");
});

test("history accepts task sources without changing draw aggregation", async () => {
  const kv = mockHistoryKv();
  const env = { ...defaultEnv, CONFIG_KV: kv, ACTIONS_TOKEN: "actions-secret" };
  const payload = historyPayload();
  payload.run.run_id = "quiz:12345:1";
  payload.run.source = "quiz";
  payload.events = [payload.events[0]];
  payload.events[0].event_id = "quiz:12345:1:abcdef1234567890:1";
  payload.events[0].task_type = "quiz";

  const response = await handleRequest(
    historyRequest("POST", { body: JSON.stringify(payload) }),
    env,
  );
  assert.equal(response.status, 200);

  const stored = JSON.parse(kv.value("gwent-history-v1.json"));
  assert.equal(stored.runs[0].source, "quiz");
  assert.equal(stored.events[0].task_type, "quiz");
  assert.equal(stored.totals.total_draws, 1);
});

test("history POST requires the Actions token and rejects sensitive fields", async () => {
  const env = { ...defaultEnv, CONFIG_KV: mockHistoryKv(), ACTIONS_TOKEN: "actions-secret" };
  const unauthorized = await handleRequest(
    historyRequest("POST", {
      headers: { Authorization: "Bearer sync-secret" },
      body: JSON.stringify(historyPayload()),
    }),
    env,
  );
  assert.equal(unauthorized.status, 401);

  const payload = historyPayload();
  payload.events[0].session = "must-not-be-accepted";
  const sensitive = await handleRequest(
    historyRequest("POST", { body: JSON.stringify(payload) }),
    env,
  );
  assert.equal(sensitive.status, 400);
  assert.equal((await errorBody(sensitive)).error.code, "sensitive_history_field");
});

test("Actions token can read config but cannot overwrite it", async () => {
  const env = {
    ...defaultEnv,
    ACTIONS_TOKEN: "actions-secret",
    CONFIG_KV: mockKv('{"accounts":[]}'),
  };
  const read = await handleRequest(
    request("GET", { headers: { Authorization: "Bearer actions-secret" } }),
    env,
  );
  assert.equal(read.status, 200);

  const write = await handleRequest(
    request("PUT", {
      headers: { Authorization: "Bearer actions-secret" },
      body: '{"accounts":[]}',
    }),
    env,
  );
  assert.equal(write.status, 401);
});

test("KV binding stores and retrieves config without WebDAV", async () => {
  const kv = mockKv();
  const env = { ...defaultEnv, CONFIG_KV: kv };
  const payload = '{"accounts":[{"name":"test"}]}';
  let upstreamCalled = false;

  const putResponse = await handleRequest(
    request("PUT", { body: payload }),
    env,
    async () => {
      upstreamCalled = true;
      throw new Error("must not call WebDAV");
    },
  );
  assert.equal(putResponse.status, 204);

  const getResponse = await handleRequest(request("GET"), env, async () => {
    upstreamCalled = true;
    throw new Error("must not call WebDAV");
  });
  assert.equal(getResponse.status, 200);
  assert.equal(await getResponse.text(), payload);
  assert.equal(getResponse.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  assert.equal(upstreamCalled, false);
});

test("KV returns 404 before the first save and rejects invalid JSON", async () => {
  const env = { ...defaultEnv, CONFIG_KV: mockKv() };
  const missing = await handleRequest(request("GET"), env);
  assert.equal(missing.status, 404);
  assert.equal((await errorBody(missing)).error.code, "config_not_found");

  const invalid = await handleRequest(request("PUT", { body: "not-json" }), env);
  assert.equal(invalid.status, 400);
  assert.equal((await errorBody(invalid)).error.code, "invalid_json");
});

test("OPTIONS returns CORS headers without requiring authorization", async () => {
  let called = false;
  const response = await handleRequest(
    request("OPTIONS", {
      headers: { "Access-Control-Request-Method": "PUT" },
    }),
    defaultEnv,
    async () => {
      called = true;
      throw new Error("must not be called");
    },
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, PUT, OPTIONS");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(called, false);
});

test("the literal null origin is allowed only when explicitly listed", async () => {
  const allowed = await handleRequest(request("OPTIONS", { origin: "null" }), defaultEnv);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "null");

  const denied = await handleRequest(request("OPTIONS", { origin: "null" }), {
    ...defaultEnv,
    ALLOWED_ORIGINS: "https://app.example",
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await errorBody(denied)).error.code, "origin_not_allowed");
});

test("origin matching is exact", async () => {
  const response = await handleRequest(
    request("GET", { origin: "https://sub.app.example" }),
    defaultEnv,
  );

  assert.equal(response.status, 403);
  assert.equal((await errorBody(response)).error.code, "origin_not_allowed");
});

test("GET requires the configured Bearer token", async () => {
  let called = false;
  const badRequest = request("GET", { headers: { Authorization: "Bearer wrong" } });
  const response = await handleRequest(badRequest, defaultEnv, async () => {
    called = true;
    return new Response();
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("WWW-Authenticate"), 'Bearer realm="newapi-config"');
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  assert.equal((await errorBody(response)).error.code, "unauthorized");
  assert.equal(called, false);
});

test("GET reads only the fixed WebDAV URL and forwards safe response headers", async () => {
  let observed;
  const response = await handleRequest(
    new Request(`${endpoint}?url=https://attacker.example/steal`, {
      headers: {
        Authorization: "Bearer sync-secret",
        Origin: "https://app.example",
      },
    }),
    defaultEnv,
    async (url, init) => {
      observed = { url, init };
      return new Response('{"accounts":[]}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: '"abc"',
          "Set-Cookie": "must-not-leak=1",
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"accounts":[]}');
  assert.equal(observed.url, "https://dav.jianguoyun.com/dav/newapi-config.json");
  assert.equal(observed.init.method, "GET");
  assert.equal(observed.init.redirect, "manual");
  assert.equal(
    observed.init.headers.get("Authorization"),
    `Basic ${Buffer.from("user@example.com:应用密码", "utf8").toString("base64")}`,
  );
  assert.equal(response.headers.get("ETag"), '"abc"');
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("PUT forwards the body to an allowed custom path", async () => {
  const payload = '{"enabled":true}';
  let observed;
  const response = await handleRequest(
    request("PUT", {
      headers: { "Content-Type": "application/json" },
      body: payload,
    }),
    { ...defaultEnv, JIANGUO_CONFIG_PATH: "/dav/folder/config.json" },
    async (url, init) => {
      observed = { url, init };
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(response.status, 204);
  assert.equal(observed.url, "https://dav.jianguoyun.com/dav/folder/config.json");
  assert.equal(observed.init.method, "PUT");
  assert.equal(new TextDecoder().decode(observed.init.body), payload);
  assert.equal(observed.init.headers.get("Content-Type"), "application/json; charset=utf-8");
});

test("JIANGUO_CONFIG_PATH cannot turn the Worker into an arbitrary proxy", async () => {
  for (const invalidPath of [
    "https://attacker.example/config.json",
    "//attacker.example/dav/config.json",
    "/dav/../outside.json",
    "/dav/config.json?target=https://attacker.example",
  ]) {
    let called = false;
    const response = await handleRequest(
      request("GET"),
      { ...defaultEnv, JIANGUO_CONFIG_PATH: invalidPath },
      async () => {
        called = true;
        return new Response();
      },
    );

    assert.equal(response.status, 500, invalidPath);
    assert.equal((await errorBody(response)).error.code, "invalid_worker_config", invalidPath);
    assert.equal(called, false, invalidPath);
  }
});

test("PUT rejects a request larger than 256 KiB before calling upstream", async () => {
  let called = false;
  const response = await handleRequest(
    request("PUT", { body: new Uint8Array(MAX_BODY_BYTES + 1) }),
    defaultEnv,
    async () => {
      called = true;
      return new Response();
    },
  );

  assert.equal(response.status, 413);
  assert.equal((await errorBody(response)).error.code, "payload_too_large");
  assert.equal(called, false);
});

test("GET rejects an upstream response larger than 256 KiB", async () => {
  const response = await handleRequest(request("GET"), defaultEnv, async () =>
    new Response(new Uint8Array(MAX_BODY_BYTES + 1)),
  );

  assert.equal(response.status, 502);
  assert.equal((await errorBody(response)).error.code, "upstream_payload_too_large");
});

test("GET preserves upstream 404 to represent a config that has not been saved", async () => {
  const response = await handleRequest(request("GET"), defaultEnv, async () =>
    new Response("not found", { status: 404 }),
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  assert.equal((await errorBody(response)).error.code, "config_not_found");
});

test("GET accepts the optional Actions-only Bearer token", async () => {
  const response = await handleRequest(
    request("GET", { headers: { Authorization: "Bearer actions-secret" } }),
    { ...defaultEnv, ACTIONS_TOKEN: "actions-secret", CONFIG_KV: mockKv('{"accounts":[]}') },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"accounts":[]}');
});

test("GET treats JianGuoYun's Cloudflare-facing 520 as a missing config", async () => {
  const response = await handleRequest(request("GET"), defaultEnv, async () =>
    new Response("webdav error", { status: 520 }),
  );

  assert.equal(response.status, 404);
  assert.equal((await errorBody(response)).error.code, "config_not_found");
});

test("upstream failures and unsupported routes use JSON errors", async () => {
  const upstreamFailure = await handleRequest(request("GET"), defaultEnv, async () =>
    new Response("bad credentials", { status: 401 }),
  );
  assert.equal(upstreamFailure.status, 502);
  assert.deepEqual((await errorBody(upstreamFailure)).error.details, { upstreamStatus: 401 });

  const putNotFound = await handleRequest(request("PUT"), defaultEnv, async () =>
    new Response("not found", { status: 404 }),
  );
  assert.equal(putNotFound.status, 502);
  assert.equal((await errorBody(putNotFound)).error.code, "upstream_error");

  const notFound = await handleRequest(
    new Request("https://relay.example/anything", {
      headers: { Origin: "https://app.example" },
    }),
    defaultEnv,
  );
  assert.equal(notFound.status, 404);
  assert.equal((await errorBody(notFound)).error.code, "not_found");
});

test("requests without Origin are supported for non-browser clients", async () => {
  const response = await handleRequest(
    request("GET", { origin: null }),
    { ...defaultEnv, ALLOWED_ORIGINS: "" },
    async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});
