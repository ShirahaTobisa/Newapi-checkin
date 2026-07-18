import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest, safeError } from "../src/app.mjs";
import { emptyHistory } from "../src/index.mjs";
import { DEFAULT_SETTINGS } from "../src/settings.mjs";
import { accountKey } from "../src/vsllm.mjs";

function compactSql(sql) {
  return sql.replace(/\s+/gu, " ").trim();
}

class MockStatement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = compactSql(sql);
    this.values = values;
  }

  bind(...values) {
    return new MockStatement(this.db, this.sql, values);
  }

  async first() {
    this.db.reads += 1;
    assert.equal(
      this.sql,
      "SELECT value_json, version FROM state_documents WHERE state_key = ?",
    );
    const row = this.db.rows.get(this.values[0]);
    return row ? { value_json: row.value_json, version: row.version } : null;
  }

  async run() {
    this.db.writes += 1;
    if (this.sql.startsWith("INSERT OR IGNORE INTO state_documents")) {
      const [key, valueJson, updatedAt] = this.values;
      if (this.db.rows.has(key)) return this.db.result(0);
      this.db.rows.set(key, { value_json: valueJson, version: 1, updated_at: updatedAt });
      return this.db.result(1);
    }
    if (this.sql.startsWith("UPDATE state_documents SET value_json = ?")) {
      const [valueJson, updatedAt, key, expectedVersion] = this.values;
      const current = this.db.rows.get(key);
      if (!current || current.version !== expectedVersion) return this.db.result(0);
      this.db.rows.set(key, {
        value_json: valueJson,
        version: current.version + 1,
        updated_at: updatedAt,
      });
      return this.db.result(1);
    }
    if (this.sql.startsWith("INSERT OR IGNORE INTO automation_runs")) {
      if (this.db.failHistoryWrites) throw new Error("history write failed");
      const [
        run_id,
        run_number,
        run_attempt,
        started_at,
        finished_at,
        planned_draws,
        status,
        source,
        trigger,
        account_count,
        successful_draws,
        total_quota,
      ] = this.values;
      if (this.db.automationRuns.has(run_id)) return this.db.result(0);
      this.db.automationRuns.set(run_id, {
        run_id,
        run_number,
        run_attempt,
        started_at,
        finished_at,
        planned_draws,
        status,
        source,
        trigger,
        account_count,
        successful_draws,
        total_quota,
      });
      return this.db.result(1);
    }
    if (this.sql.startsWith("INSERT OR IGNORE INTO automation_events")) {
      if (this.db.failHistoryWrites) throw new Error("history write failed");
      const [
        event_id,
        run_id,
        account_key,
        account_name,
        attempt,
        occurred_at,
        local_date,
        status,
        prize_name,
        prize_quota,
        prize_rarity,
        bonus_percent,
        message,
        task_type,
      ] = this.values;
      if (this.db.automationEvents.has(event_id)) return this.db.result(0);
      this.db.automationEvents.set(event_id, {
        event_id,
        run_id,
        account_key,
        account_name,
        attempt,
        occurred_at,
        local_date,
        status,
        prize_name,
        prize_quota,
        prize_rarity,
        bonus_percent,
        message,
        task_type,
      });
      return this.db.result(1);
    }
    throw new Error(`Unexpected SQL: ${this.sql}`);
  }

  async all() {
    this.db.reads += 1;
    if (this.db.failHistoryReads) throw new Error("history read failed");
    if (this.sql.startsWith("SELECT account_key, COUNT(*) AS today_draws")) {
      const date = this.values[0];
      const grouped = new Map();
      for (const event of this.db.automationEvents.values()) {
        if (event.local_date !== date || event.status !== "success") continue;
        const current = grouped.get(event.account_key) || {
          account_key: event.account_key,
          today_draws: 0,
          today_wins: 0,
          today_quota: 0,
        };
        current.today_draws += 1;
        current.today_quota += Number(event.prize_quota || 0);
        if (Number(event.prize_quota || 0) > 0) current.today_wins += 1;
        grouped.set(event.account_key, current);
      }
      return this.db.queryResult([...grouped.values()]);
    }
    if (this.sql.startsWith("SELECT COUNT(*) AS total FROM automation_events")) {
      return this.db.queryResult([{ total: this.db.filteredEvents(this.sql, this.values).length }]);
    }
    if (this.sql.startsWith("SELECT event_id, run_id, account_key")) {
      const events = this.db.filteredEvents(this.sql, this.values);
      const pageSize = Number(this.values.at(-2));
      const offset = Number(this.values.at(-1));
      return this.db.queryResult(events.slice(offset, offset + pageSize));
    }
    throw new Error(`Unexpected SQL: ${this.sql}`);
  }
}

class MockD1 {
  constructor(initial = {}) {
    this.reads = 0;
    this.writes = 0;
    this.failHistoryReads = false;
    this.failHistoryWrites = false;
    this.automationRuns = new Map();
    this.automationEvents = new Map();
    this.rows = new Map(
      Object.entries(initial).map(([key, value]) => [
        key,
        { value_json: JSON.stringify(value), version: 1, updated_at: new Date().toISOString() },
      ]),
    );
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  result(changes) {
    return { success: true, results: [], meta: { changes } };
  }

  queryResult(results) {
    return { success: true, results, meta: { changes: 0 } };
  }

  filteredEvents(sql, values) {
    let valueIndex = 0;
    const accountKey = sql.includes("account_key = ?") ? values[valueIndex++] : null;
    const source = sql.includes("task_type = ?") ? values[valueIndex++] : null;
    const from = sql.includes("local_date >= ?") ? values[valueIndex++] : null;
    const to = sql.includes("local_date <= ?") ? values[valueIndex++] : null;
    return [...this.automationEvents.values()]
      .filter((event) => accountKey === null || event.account_key === accountKey)
      .filter((event) => source === null || event.task_type === source)
      .filter((event) => from === null || event.local_date >= from)
      .filter((event) => to === null || event.local_date <= to)
      .sort(
        (left, right) =>
          right.occurred_at.localeCompare(left.occurred_at) ||
          right.event_id.localeCompare(left.event_id),
      );
  }

  async batch(statements) {
    const runSnapshot = new Map(this.automationRuns);
    const eventSnapshot = new Map(this.automationEvents);
    try {
      const results = [];
      for (const statement of statements) {
        results.push(statement.sql.startsWith("SELECT ")
          ? await statement.all()
          : await statement.run());
      }
      return results;
    } catch (error) {
      this.automationRuns = runSnapshot;
      this.automationEvents = eventSnapshot;
      throw error;
    }
  }

  value(key) {
    const row = this.rows.get(key);
    return row ? JSON.parse(row.value_json) : null;
  }
}

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request(path, { method = "GET", token, body, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set("authorization", `Bearer ${token}`);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  return new Request(`https://example.test${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function envWith(initial = {}) {
  return {
    STATE_DB: new MockD1(initial),
    CONFIG_KV: { async get() { return null; } },
    ADMIN_TOKEN: "admin-secret",
    SYNC_TOKEN: "admin-secret",
    ACTIONS_TOKEN: "actions-secret",
    AUTOMATION_PAUSED: "true",
  };
}

function fullHistoryEvent(overrides = {}) {
  const eventId = overrides.event_id || "event-1";
  return {
    event_id: eventId,
    run_id: overrides.run_id || "run-1",
    account_key: overrides.account_key || "aaaaaaaaaaaaaaaa",
    account_name: overrides.account_name || "一号",
    attempt: overrides.attempt ?? 1,
    occurred_at: overrides.occurred_at || "2026-07-18T01:00:00.000Z",
    local_date: overrides.local_date || "2026-07-18",
    status: overrides.status || "success",
    prize_name: overrides.prize_name === undefined ? "测试奖品" : overrides.prize_name,
    prize_quota: overrides.prize_quota ?? 500000,
    prize_rarity: overrides.prize_rarity || "rare",
    bonus_percent: overrides.bonus_percent ?? 50,
    message: overrides.message || "翻牌成功",
    task_type: overrides.task_type || "gwent",
  };
}

test("dashboard converts 500000 quota to one yuan and returns D1 status", async () => {
  const config = {
    accounts: [
      { name: "一号", url: "https://vsllm.com", user_id: "101", session: "cookie-value" },
    ],
  };
  const key = await accountKey(config.accounts[0], 1);
  const history = emptyHistory();
  history.updated_at = "2026-07-18T01:00:00Z";
  history.totals = {
    total_runs: 1,
    total_draws: 1,
    total_wins: 1,
    total_quota: 500000,
    total_accounts: 1,
  };
  history.accounts = [{
    account_key: key,
    account_name: "一号",
    total_draws: 1,
    total_wins: 1,
    total_quota: 500000,
    last_event_at: "2026-07-18T01:00:00Z",
    last_status: "success",
  }];
  history.daily = [{ date: "2026-07-18", total_draws: 1, total_wins: 1, total_quota: 500000 }];
  const env = envWith({
    "newapi-config.json": config,
    "gwent-history-v1.json": history,
    "automation-settings-v1.json": { ...DEFAULT_SETTINGS, quota_per_cny: 123 },
  });
  const response = await handleRequest(request("/api/dashboard"), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.storage.provider, "D1");
  assert.equal(data.conversion.quota_per_cny, 500000);
  assert.equal(data.income.total.amount_yuan, "1.000000");
  assert.equal(data.accounts[0].amount_yuan, "1.000000");
});

test("admin settings accepts the dashboard aliases and never exposes the webhook", async () => {
  const env = envWith({
    "newapi-config.json": { accounts: [], dingtalk: {} },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  const response = await handleRequest(
    request("/api/admin/settings", {
      method: "PUT",
      token: "admin-secret",
      body: {
        master_enabled: false,
        checkin: { time: "01:05" },
        draw: { anchor: "00:25", every_minutes: 120 },
        reward_draw: { quiz: false, ad: true },
        notifications: {
          enabled: true,
          errors_only: true,
          webhook: "https://oapi.dingtalk.com/robot/send?access_token=x",
        },
      },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.settings.automation_enabled, false);
  assert.equal(data.settings.checkin.daily_at, "01:05");
  assert.equal(data.settings.draw.anchor_local, "00:25");
  assert.equal(data.settings.quiz.draw_after_success, false);
  assert.equal(data.settings.notifications.errors_only, true);
  assert.equal(data.settings.notifications.webhook_configured, true);
  assert.equal("webhook" in data.settings.notifications, false);
  assert.equal(
    env.STATE_DB.value("notification-config-v1.json").dingtalk.webhook.includes("access_token=x"),
    true,
  );
  assert.deepEqual(env.STATE_DB.value("newapi-config.json").dingtalk, {});

  const cleared = await handleRequest(
    request("/api/admin/settings", {
      method: "PUT",
      token: "admin-secret",
      body: { notifications: { clear_webhook: true } },
    }),
    env,
  );
  assert.equal(cleared.status, 200);
  const clearedData = await cleared.json();
  assert.equal(clearedData.settings.notifications.webhook_configured, false);
  assert.equal("webhook" in env.STATE_DB.value("notification-config-v1.json").dingtalk, false);
  assert.deepEqual(env.STATE_DB.value("newapi-config.json").dingtalk, {});
});

test("admin account API is secret-safe and preserves an existing cookie when left blank", async () => {
  const existing = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "session=existing-secret; cf_clearance=clearance-secret",
  };
  const env = envWith({
    "newapi-config.json": { accounts: [existing], metadata: "keep-me" },
  });

  const listed = await handleRequest(
    request("/api/admin/accounts", { token: "admin-secret" }),
    env,
  );
  assert.equal(listed.status, 200);
  const listedData = await listed.json();
  assert.equal(listedData.accounts.length, 1);
  assert.equal(listedData.accounts[0].cookie_configured, true);
  assert.equal(JSON.stringify(listedData).includes("existing-secret"), false);
  assert.equal(JSON.stringify(listedData).includes("clearance-secret"), false);

  const saved = await handleRequest(
    request("/api/admin/accounts", {
      method: "PUT",
      token: "admin-secret",
      body: {
        accounts: [
          {
            account_key: listedData.accounts[0].account_key,
            name: "主账号",
            base_url: "https://vsllm.com",
            user_id: "101",
          },
          {
            name: "普通签到",
            base_url: "https://example.test",
            user_id: "",
            cookie: "session=new-secret",
          },
        ],
      },
    }),
    env,
  );
  assert.equal(saved.status, 200);
  const savedData = await saved.json();
  assert.equal(savedData.accounts.length, 2);
  assert.equal(JSON.stringify(savedData).includes("existing-secret"), false);
  assert.equal(JSON.stringify(savedData).includes("new-secret"), false);
  const stored = env.STATE_DB.value("newapi-config.json");
  assert.equal(stored.metadata, "keep-me");
  assert.equal(stored.accounts[0].name, "主账号");
  assert.equal(stored.accounts[0].session.includes("existing-secret"), true);
  assert.equal(stored.accounts[1].session.includes("new-secret"), true);
});

test("admin balance refresh includes safe draw charges only for VSLLM accounts", async () => {
  const vsllm = {
    name: "维云一号",
    url: "https://vsllm.com",
    user_id: "sensitive-user-101",
    session: "session=vsllm-cookie-secret",
  };
  const generic = {
    name: "普通签到站",
    url: "https://generic.example",
    user_id: "sensitive-user-202",
    session: "session=generic-cookie-secret",
  };
  const env = envWith({
    "newapi-config.json": { accounts: [vsllm, generic] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const headers = new Headers(options.headers);
    calls.push({
      url: value,
      userId: headers.get("new-api-user"),
      cookie: headers.get("cookie"),
    });
    if (value === "https://vsllm.com/api/user/self") {
      return responseJson({
        success: true,
        data: {
          quota: 1_000_000,
          used_quota: 250_000,
          request_count: 12,
          raw_secret: "balance-raw-secret",
        },
      });
    }
    if (value === "https://vsllm.com/api/gwent/status") {
      return responseJson({
        success: true,
        data: {
          charges_current: 2,
          extra_draws_left: 1,
          raw_secret: "gwent-raw-secret",
          tasks: {},
        },
      });
    }
    if (value === "https://generic.example/api/user/self") {
      return responseJson({
        success: true,
        data: { quota: 500_000, used_quota: 0, request_count: 3 },
      });
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  try {
    const response = await handleRequest(
      request("/api/admin/balances", {
        method: "POST",
        token: "admin-secret",
        body: { account_keys: ["all"] },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.total, 2);
    assert.equal(data.succeeded, 2);

    const vsllmResult = data.results.find((result) => result.account_name === "维云一号");
    assert.equal(vsllmResult.ok, true);
    assert.equal(vsllmResult.balance_quota, 1_000_000);
    assert.equal(vsllmResult.gwent.supported, true);
    assert.equal(vsllmResult.gwent.ok, true);
    assert.equal(vsllmResult.gwent.available, 3);
    assert.equal(vsllmResult.gwent.charges_current, 2);
    assert.equal(vsllmResult.gwent.extra_draws_left, 1);

    const genericResult = data.results.find((result) => result.account_name === "普通签到站");
    assert.equal(genericResult.ok, true);
    assert.equal(genericResult.balance_quota, 500_000);
    assert.equal(genericResult.gwent.supported, false);
    assert.equal(
      calls.some((call) => call.url === "https://generic.example/api/gwent/status"),
      false,
    );
    assert.deepEqual(
      calls.map((call) => [call.url, call.userId, call.cookie]).sort(),
      [
        ["https://generic.example/api/user/self", "sensitive-user-202", "session=generic-cookie-secret"],
        ["https://vsllm.com/api/gwent/status", "sensitive-user-101", "session=vsllm-cookie-secret"],
        ["https://vsllm.com/api/user/self", "sensitive-user-101", "session=vsllm-cookie-secret"],
      ].sort(),
    );

    const serialized = JSON.stringify(data);
    for (const sensitive of [
      "sensitive-user-101",
      "sensitive-user-202",
      "vsllm-cookie-secret",
      "generic-cookie-secret",
      "balance-raw-secret",
      "gwent-raw-secret",
    ]) {
      assert.equal(serialized.includes(sensitive), false, `response leaked ${sensitive}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin balance refresh preserves balance when the VSLLM charge lookup fails", async () => {
  const account = {
    name: "过期账号",
    url: "https://vsllm.com",
    user_id: "sensitive-user-303",
    session: "session=expired-cookie-secret",
  };
  const env = envWith({
    "newapi-config.json": { accounts: [account] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === "https://vsllm.com/api/user/self") {
      return responseJson({
        success: true,
        data: { quota: 750_000, used_quota: 125_000, request_count: 9 },
      });
    }
    if (value === "https://vsllm.com/api/gwent/status") {
      return responseJson({
        success: false,
        message: "授权已过期",
        data: { raw_secret: "failed-status-raw-secret" },
      }, 401);
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  try {
    const response = await handleRequest(
      request("/api/admin/balances", {
        method: "POST",
        token: "admin-secret",
        body: { account_keys: ["all"] },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.succeeded, 1);
    assert.equal(data.failed, 0);
    assert.equal(data.balance_quota, 750_000);
    assert.equal(data.results[0].ok, true);
    assert.equal(data.results[0].balance_quota, 750_000);
    assert.equal(data.results[0].gwent.supported, true);
    assert.equal(data.results[0].gwent.ok, false);
    assert.equal(data.results[0].gwent.available, null);
    assert.equal(data.results[0].gwent.charges_current, null);
    assert.equal(data.results[0].gwent.extra_draws_left, null);

    const serialized = JSON.stringify(data);
    for (const sensitive of [
      "sensitive-user-303",
      "expired-cookie-secret",
      "failed-status-raw-secret",
    ]) {
      assert.equal(serialized.includes(sensitive), false, `response leaked ${sensitive}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard does not reuse yesterday task status and marks removed accounts historical", async () => {
  const active = { name: "当前账号", url: "https://vsllm.com", user_id: "101", session: "cookie-value" };
  const activeKey = await accountKey(active, 1);
  const history = emptyHistory();
  history.accounts = [
    {
      account_key: "aaaaaaaaaaaaaaaa",
      account_name: "旧账号",
      total_draws: 2,
      total_wins: 2,
      total_quota: 1000,
      last_event_at: "2020-01-01T00:00:00.000Z",
      last_status: "success",
    },
  ];
  const env = envWith({
    "newapi-config.json": { accounts: [active] },
    "gwent-history-v1.json": history,
    "automation-settings-v1.json": DEFAULT_SETTINGS,
    "gwent-task-status-quiz-v1.json": {
      schema_version: 1,
      source: "quiz",
      local_date: "2000-01-01",
      updated_at: "2000-01-01T00:00:00.000Z",
      accounts: [{
        account_key: activeKey,
        account_name: "当前账号",
        task_type: "quiz",
        status: "completed",
        completed: true,
        next_available_at: null,
        message: "昨日已完成",
        checked_at: "2000-01-01T00:00:00.000Z",
      }],
    },
  });

  const response = await handleRequest(request("/api/dashboard"), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.task_statuses.stale, true);
  assert.deepEqual(data.task_statuses.accounts, []);
  assert.equal(data.accounts.find((account) => account.account_key === activeKey).tasks.quiz, null);
  assert.equal(data.accounts.find((account) => account.account_key === activeKey).configured, true);
  assert.equal(data.accounts.find((account) => account.account_key === "aaaaaaaaaaaaaaaa").configured, false);
});

test("manual draw is idempotent and records a 500000 quota prize once", async () => {
  const env = envWith({
    "newapi-config.json": {
      accounts: [
        { name: "一号", url: "https://vsllm.com", user_id: "101", session: "cookie-value" },
      ],
    },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/gwent/status")) {
      return responseJson({
        success: true,
        data: { charges_current: 1, extra_draws_left: 0, tasks: {} },
      });
    }
    if (String(url).endsWith("/api/gwent/share_unlock")) {
      return responseJson({ success: true, message: "已激活" });
    }
    if (String(url).endsWith("/api/gwent/draw")) {
      return responseJson({
        success: true,
        message: "翻牌成功",
        data: {
          prize: { name: "测试奖励", quota: 500000, rarity: "rare" },
          bonus_percent: 50,
          charges_current: 0,
          extra_draws_left: 0,
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const first = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "manual-test-0001" },
        body: { action: "draw", account_keys: ["all"], draw_count: 1 },
      }),
      env,
    );
    assert.equal(first.status, 200);
    const firstData = await first.json();
    assert.equal(firstData.total_quota, 500000);
    assert.equal(firstData.successful_draws, 1);

    const second = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "manual-test-0001" },
        body: { action: "draw", account_keys: ["all"], draw_count: 1 },
      }),
      env,
    );
    assert.equal(second.status, 200);
    const secondData = await second.json();
    assert.equal(secondData.total_quota, 500000);
    assert.equal(calls.length, 3);
    assert.equal(env.STATE_DB.value("gwent-history-v1.json").totals.total_quota, 500000);
    assert.equal(env.STATE_DB.automationRuns.size, 1);
    assert.equal(env.STATE_DB.automationEvents.size, 1);
    assert.equal([...env.STATE_DB.automationEvents.values()][0].prize_quota, 500000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin APIs accept only ADMIN_TOKEN and fail explicitly when it is missing", async () => {
  const env = envWith({ "automation-settings-v1.json": DEFAULT_SETTINGS });
  env.SYNC_TOKEN = "sync-secret";
  env.ACTIONS_TOKEN = "actions-secret";

  for (const token of [env.SYNC_TOKEN, env.ACTIONS_TOKEN]) {
    const denied = await handleRequest(request("/api/admin/settings", { token }), env);
    assert.equal(denied.status, 401);
  }

  delete env.ADMIN_TOKEN;
  const missing = await handleRequest(
    request("/api/admin/settings", { token: "admin-secret" }),
    env,
  );
  assert.equal(missing.status, 500);
  assert.equal((await missing.json()).error.code, "admin_not_configured");
});

test("manual runs require strict account keys and a bounded idempotency key", async () => {
  const env = envWith({
    "newapi-config.json": {
      accounts: [
        { name: "一号", url: "https://vsllm.com", user_id: "101", session: "cookie-value" },
      ],
    },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called");
  };

  try {
    const missingKey = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        body: { action: "draw", account_keys: ["all"], draw_count: 1 },
      }),
      env,
    );
    assert.equal(missingKey.status, 400);
    assert.equal((await missingKey.json()).error.code, "invalid_idempotency_key");

    const malformedAccounts = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "manual-validation-01" },
        body: { action: "draw", account_keys: "all", draw_count: 1 },
      }),
      env,
    );
    assert.equal(malformedAccounts.status, 400);
    assert.equal((await malformedAccounts.json()).error.code, "invalid_account_keys");

    const oversizedKey = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": `manual-${"x".repeat(65)}` },
        body: { action: "draw", account_keys: ["all"], draw_count: 1 },
      }),
      env,
    );
    assert.equal(oversizedKey.status, 400);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health is read-only and never touches legacy KV", async () => {
  const env = envWith();
  let legacyReads = 0;
  env.CONFIG_KV = {
    async get() {
      legacyReads += 1;
      throw new Error("health must not access legacy KV");
    },
  };
  env.ACCOUNTS_JSON = JSON.stringify({
    accounts: [
      { name: "一号", url: "https://vsllm.com", user_id: "101", session: "cookie-value" },
    ],
  });

  const response = await handleRequest(request("/health"), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.account_count, 1);
  assert.equal("migration" in data, false);
  assert.equal(legacyReads, 0);
  assert.equal(env.STATE_DB.writes, 0);
  assert.equal(env.STATE_DB.value("newapi-config.json"), null);
});

test("notification settings use an isolated state document with ACCOUNTS_JSON", async () => {
  const env = envWith({ "automation-settings-v1.json": DEFAULT_SETTINGS });
  env.ACCOUNTS_JSON = JSON.stringify({
    accounts: [
      { name: "一号", url: "https://vsllm.com", user_id: "101", session: "cookie-value" },
    ],
  });

  const saved = await handleRequest(
    request("/api/admin/settings", {
      method: "PUT",
      token: "admin-secret",
      body: {
        notifications: {
          webhook: "https://oapi.dingtalk.com/robot/send?access_token=isolated",
          secret: "signing-secret",
        },
      },
    }),
    env,
  );
  assert.equal(saved.status, 200);
  assert.equal(env.STATE_DB.value("newapi-config.json"), null);
  assert.deepEqual(env.STATE_DB.value("notification-config-v1.json"), {
    schema_version: 1,
    dingtalk: {
      webhook: "https://oapi.dingtalk.com/robot/send?access_token=isolated",
      secret: "signing-secret",
    },
  });

  const dashboard = await handleRequest(request("/api/dashboard"), env);
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).accounts.length, 1);
});

test("safeError redacts signed URLs, bearer tokens, cookies, and sessions", () => {
  const message = safeError(
    new Error(
      "POST https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp=1&sign=secret " +
        "Authorization: Bearer bearer-secret Cookie=session-cookie session=session-secret",
    ),
  );
  for (const secret of ["abc", "secret", "bearer-secret", "session-cookie", "session-secret"]) {
    assert.equal(message.includes(secret), false);
  }
  assert.match(message, /\?\[redacted\]/u);
});

test("all legacy writes are disabled for old Sync and Actions tokens by default", async () => {
  const env = envWith({ "newapi-config.json": { accounts: [] } });
  env.SYNC_TOKEN = "sync-secret";
  const writes = [
    { path: "/api/config", method: "PUT", token: "sync-secret" },
    { path: "/api/gwent/history", method: "POST", token: "actions-secret" },
    { path: "/api/gwent/task-status", method: "POST", token: "actions-secret" },
    { path: "/api/gwent/schedule", method: "POST", token: "actions-secret" },
  ];
  for (const write of writes) {
    const response = await handleRequest(
      request(write.path, {
        method: write.method,
        token: write.token,
        body: {},
      }),
      env,
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "legacy_writes_disabled");
  }

  const configRead = await handleRequest(
    request("/api/config", { token: "sync-secret" }),
    env,
  );
  assert.equal(configRead.status, 200);
  const historyRead = await handleRequest(request("/api/gwent/history"), env);
  assert.equal(historyRead.status, 200);
  const preflight = await handleRequest(
    request("/api/gwent/schedule", { method: "OPTIONS" }),
    env,
  );
  assert.notEqual(preflight.status, 409);
  assert.equal(env.STATE_DB.writes, 0);
});

test("an expired request_sent draw intent is uncertain and never redraws", async () => {
  const account = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "cookie-value",
  };
  const key = await accountKey(account, 1);
  const idempotencyKey = "intent-request-sent-01";
  const runId = `manual:draw:${idempotencyKey}`;
  const intentKey = `draw-intent:${runId}:${key}:1`;
  const env = envWith({
    "newapi-config.json": { accounts: [account] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
    [intentKey]: {
      schema_version: 1,
      phase: "request_sent",
      status: "request_sent",
      owner: "crashed-owner",
      request_sent_at: "2026-07-18T00:00:00.000Z",
      expires_at: 0,
    },
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/gwent/status")) {
      return responseJson({
        success: true,
        data: { charges_current: 1, extra_draws_left: 0, tasks: {} },
      });
    }
    throw new Error(`draw must not be retried: ${url}`);
  };

  try {
    const response = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": idempotencyKey },
        body: { action: "draw", account_keys: ["all"], draw_count: 1 },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status, "error");
    assert.equal(data.results[0].steps[0].status, "uncertain");
    assert.deepEqual(calls, ["https://vsllm.com/api/gwent/status"]);
    assert.equal(env.STATE_DB.value(intentKey).phase, "terminal");
    assert.equal(env.STATE_DB.value(intentKey).status, "uncertain");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an expired claimed draw intent can be reclaimed exactly once", async () => {
  const account = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "cookie-value",
  };
  const key = await accountKey(account, 1);
  const idempotencyKey = "intent-claimed-expired-01";
  const runId = `manual:draw:${idempotencyKey}`;
  const intentKey = `draw-intent:${runId}:${key}:1`;
  const env = envWith({
    "newapi-config.json": { accounts: [account] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
    [intentKey]: {
      schema_version: 1,
      phase: "claimed",
      status: "claimed",
      owner: "expired-owner",
      expires_at: Date.now() - 1,
    },
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/gwent/status")) {
      return responseJson({
        success: true,
        data: { charges_current: 1, extra_draws_left: 0, tasks: {} },
      });
    }
    if (String(url).endsWith("/api/gwent/share_unlock")) {
      return responseJson({ success: true, message: "已激活" });
    }
    if (String(url).endsWith("/api/gwent/draw")) {
      return responseJson({
        success: true,
        message: "翻牌成功",
        data: {
          prize: { name: "恢复奖励", quota: 500000, rarity: "rare" },
          bonus_percent: 50,
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const response = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": idempotencyKey },
        body: { action: "draw", account_keys: ["all"], draw_count: 1 },
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "success");
    assert.equal(calls.filter((url) => url.endsWith("/api/gwent/draw")).length, 1);
    assert.equal(env.STATE_DB.value(intentKey).phase, "terminal");
    assert.equal(env.STATE_DB.value(intentKey).result.prize_quota, 500000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a pending quiz reward is consumed even when the quiz is already completed", async () => {
  const account = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "cookie-value",
  };
  const key = await accountKey(account, 1);
  const rewardKey = `quiz:2026-07-18:${key}`;
  const env = envWith({
    "newapi-config.json": { accounts: [account] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
    [`reward-queue:${key}`]: {
      schema_version: 1,
      account_key: key,
      updated_at: "2026-07-18T00:00:00.000Z",
      items: [{
        key: rewardKey,
        source: "quiz",
        local_date: "2026-07-18",
        ordinal: null,
        reason: "答题奖励",
        status: "pending",
        created_at: "2026-07-18T00:00:00.000Z",
        history_recorded: false,
      }],
    },
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/gwent/status")) {
      return responseJson({
        success: true,
        data: {
          charges_current: 1,
          extra_draws_left: 0,
          tasks: { task3: { status: "completed" } },
        },
      });
    }
    if (String(url).endsWith("/api/gwent/share_unlock")) {
      return responseJson({ success: true, message: "已激活" });
    }
    if (String(url).endsWith("/api/gwent/draw")) {
      return responseJson({
        success: true,
        message: "翻牌成功",
        data: { prize: { name: "答题奖励", quota: 500000, rarity: "rare" } },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const response = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "quiz-pending-reward-01" },
        body: { action: "quiz", account_keys: ["all"] },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status, "success");
    assert.equal(data.successful_draws, 1);
    assert.equal(calls.some((url) => url.endsWith("/api/gwent/task3/start")), false);
    assert.equal(calls.filter((url) => url.endsWith("/api/gwent/draw")).length, 1);
    assert.equal(env.STATE_DB.value(`reward-queue:${key}`).items[0].status, "completed");
    assert.equal(env.STATE_DB.value("gwent-history-v1.json").events[0].event_id, `reward:${rewardKey}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a terminal reward intent is reconciled into history without another draw", async () => {
  const account = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "cookie-value",
  };
  const key = await accountKey(account, 1);
  const rewardKey = `quiz:2026-07-18:${key}`;
  const env = envWith({
    "newapi-config.json": { accounts: [account] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
    [`reward-queue:${key}`]: {
      schema_version: 1,
      account_key: key,
      updated_at: "2026-07-18T00:00:00.000Z",
      items: [{
        key: rewardKey,
        source: "quiz",
        local_date: "2026-07-18",
        ordinal: null,
        reason: "答题奖励",
        status: "pending",
        created_at: "2026-07-18T00:00:00.000Z",
        history_recorded: false,
      }],
    },
    [`draw-intent:${rewardKey}`]: {
      schema_version: 1,
      phase: "terminal",
      status: "success",
      owner: "crashed-owner",
      result: {
        ok: true,
        success: true,
        skipped: false,
        status: "success",
        message: "此前已经翻牌成功",
        prize_name: "恢复奖品",
        prize_quota: 123456,
        prize_rarity: "epic",
        bonus_percent: 50,
        draw_sent: true,
        http_status: 200,
        occurred_at: "2026-07-18T00:01:00.000Z",
      },
      completed_at: "2026-07-18T00:01:00.000Z",
      expires_at: 0,
    },
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/gwent/status")) {
      return responseJson({
        success: true,
        data: { charges_current: 0, extra_draws_left: 0, tasks: { task3: { status: "completed" } } },
      });
    }
    throw new Error(`share/draw must not be called: ${url}`);
  };

  try {
    const response = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "quiz-terminal-recovery-01" },
        body: { action: "quiz", account_keys: ["all"] },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.total_quota, 123456);
    assert.deepEqual(calls, ["https://vsllm.com/api/gwent/status"]);
    const history = env.STATE_DB.value("gwent-history-v1.json");
    assert.equal(history.events[0].event_id, `reward:${rewardKey}`);
    assert.equal(history.events[0].occurred_at, "2026-07-18T00:01:00.000Z");
    assert.equal(env.STATE_DB.value(`reward-queue:${key}`).items[0].status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed reward draw makes the quiz run non-successful", async () => {
  const account = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "cookie-value",
  };
  const key = await accountKey(account, 1);
  const rewardKey = `quiz:2026-07-18:${key}`;
  const env = envWith({
    "newapi-config.json": { accounts: [account] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
    [`reward-queue:${key}`]: {
      schema_version: 1,
      account_key: key,
      updated_at: "2026-07-18T00:00:00.000Z",
      items: [{
        key: rewardKey,
        source: "quiz",
        local_date: "2026-07-18",
        reason: "答题奖励",
        status: "pending",
        created_at: "2026-07-18T00:00:00.000Z",
        history_recorded: false,
      }],
    },
    [`draw-intent:${rewardKey}`]: {
      schema_version: 1,
      phase: "terminal",
      status: "error",
      result: {
        ok: false,
        success: false,
        skipped: false,
        status: "error",
        message: "奖励翻牌失败",
        prize_name: null,
        prize_quota: 0,
        prize_rarity: "unknown",
        bonus_percent: 0,
        draw_sent: false,
      },
      expires_at: 0,
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/gwent/status")) {
      return responseJson({
        success: true,
        data: { charges_current: 0, extra_draws_left: 0, tasks: { task3: { status: "completed" } } },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const response = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "quiz-terminal-error-01" },
        body: { action: "quiz", account_keys: ["all"] },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.notEqual(data.status, "success");
    assert.equal(data.results[0].ok, false);
    assert.equal(data.results[0].steps[0].status, "partial");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("app-level quiz automation limits each account to four answer attempts", async () => {
  const account = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "cookie-value",
  };
  const env = envWith({
    "newapi-config.json": { accounts: [account] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  let startCalls = 0;
  let answerCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = { delay };
    if (Number(delay) < 30_000) queueMicrotask(() => callback(...args));
    return handle;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/api/gwent/status")) {
      return responseJson({
        success: true,
        data: { charges_current: 0, extra_draws_left: 0, tasks: { task3: { status: "pending" } } },
      });
    }
    if (value.endsWith("/api/gwent/task3/start")) {
      startCalls += 1;
      return responseJson({
        success: true,
        data: {
          question: {
            text: "未知测试题",
            options: ["A", "B", "C", "D", "E"],
          },
        },
      });
    }
    if (value.endsWith("/api/gwent/task3/answer")) {
      answerCalls += 1;
      return responseJson({ success: true, data: { correct: false } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const response = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "quiz-four-attempt-limit-01" },
        body: { action: "quiz", account_keys: ["all"] },
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "error");
    assert.equal(answerCalls, 4);
    assert.equal(startCalls, 4);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("VSLLM-only tasks skip generic accounts while all still checks them in", async () => {
  const accounts = [
    ...[1, 2, 3].map((index) => ({
      name: `VSLLM ${index}`,
      url: "https://vsllm.com",
      user_id: String(100 + index),
      session: `vs-session-${index}`,
    })),
    {
      name: "普通站点 1",
      url: "https://generic-one.example",
      user_id: "201",
      session: "generic-session-1",
    },
    {
      name: "普通站点 2",
      url: "https://generic-two.example",
      user_id: "202",
      session: "generic-session-2",
    },
  ];
  const genericKey = await accountKey(accounts[3], 4);
  const env = envWith({
    "newapi-config.json": { accounts },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === "https://vsllm.com/api/gwent/status") {
      return responseJson({
        success: true,
        data: { charges_current: 0, extra_draws_left: 0, tasks: {} },
      });
    }
    if (value === "https://generic-one.example/api/user/checkin") {
      return responseJson({
        success: true,
        message: "签到成功",
        data: { checkin_date: "2026-07-18", quota_awarded: 100 },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const drawResponse = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "mixed-draw-capabilities-01" },
        body: { action: "draw", account_keys: ["all"], draw_count: 1 },
      }),
      env,
    );
    assert.equal(drawResponse.status, 200);
    const drawData = await drawResponse.json();
    assert.equal(drawData.status, "success");
    assert.equal(drawData.results.filter((result) => result.reason === "unsupported_capability").length, 2);
    assert.equal(calls.filter((url) => url.endsWith("/api/gwent/status")).length, 3);

    const dashboard = await handleRequest(request("/api/dashboard"), env);
    const dashboardData = await dashboard.json();
    assert.equal(dashboardData.accounts.filter((account) => account.is_vsllm).length, 3);
    assert.equal(dashboardData.accounts.filter((account) => account.capabilities.draw).length, 3);
    assert.equal(dashboardData.accounts.filter((account) => account.capabilities.checkin).length, 5);

    const allResponse = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "generic-all-checkin-only-01" },
        body: { action: "all", account_keys: [genericKey] },
      }),
      env,
    );
    assert.equal(allResponse.status, 200);
    const allData = await allResponse.json();
    assert.equal(allData.status, "success");
    assert.deepEqual(allData.results[0].steps.map((step) => step.action), ["checkin"]);
    assert.equal(calls.filter((url) => url.includes("generic-one.example")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("full history API paginates all records and filters by account, source, and Beijing date", async () => {
  const env = envWith();
  const dates = ["2026-07-17", "2026-07-18", "2026-07-19"];
  const sources = ["gwent", "checkin", "quiz", "ad"];
  const accountKeys = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"];
  const seeded = [];
  for (let index = 0; index < 135; index += 1) {
    const date = dates[Math.floor(index / 5) % dates.length];
    const event = fullHistoryEvent({
      event_id: `event-${String(index).padStart(3, "0")}`,
      run_id: `run-${String(Math.floor(index / 3)).padStart(3, "0")}`,
      account_key: accountKeys[index % accountKeys.length],
      account_name: index % 2 === 0 ? "一号" : "二号",
      occurred_at: `${date}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      local_date: date,
      task_type: sources[index % sources.length],
      prize_quota: index * 100,
      message: index === 0 ? "Cookie=session=must-not-leak" : "翻牌成功",
    });
    event.user_id = `secret-user-${index}`;
    event.cookie = `secret-cookie-${index}`;
    seeded.push(event);
    env.STATE_DB.automationEvents.set(event.event_id, event);
  }

  const firstResponse = await handleRequest(
    request("/api/history/events?page=1&page_size=25"),
    env,
  );
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(Array.isArray(first.items), true);
  assert.equal("events" in first, false);
  assert.equal(first.items.length, 25);
  assert.deepEqual(first.pagination, {
    page: 1,
    page_size: 25,
    total: 135,
    total_pages: 6,
    has_previous: false,
    has_next: true,
  });
  assert.equal(typeof first.items[0].amount_yuan, "string");
  assert.equal(JSON.stringify(first).includes("secret-cookie"), false);
  assert.equal(JSON.stringify(first).includes("secret-user"), false);

  const lastResponse = await handleRequest(
    request("/api/history/events?page=6&page_size=25"),
    env,
  );
  const last = await lastResponse.json();
  assert.equal(last.items.length, 10);
  assert.equal(last.pagination.total, 135);
  assert.equal(last.pagination.has_next, false);

  const expected = seeded.filter(
    (event) =>
      event.account_key === accountKeys[0] &&
      event.task_type === "gwent" &&
      event.local_date >= "2026-07-18" &&
      event.local_date <= "2026-07-19",
  );
  const filteredResponse = await handleRequest(
    request(
      `/api/history/events?page_size=100&account_key=${accountKeys[0]}` +
        "&source=draw&from=2026-07-18&to=2026-07-19",
    ),
    env,
  );
  assert.equal(filteredResponse.status, 200);
  const filtered = await filteredResponse.json();
  assert.equal(filtered.pagination.total, expected.length);
  assert.equal(filtered.items.length, expected.length);
  assert.equal(filtered.items.every((item) => item.source === "draw"), true);
  assert.equal(filtered.items.every((item) => item.task_type === "gwent"), true);
  assert.equal(filtered.items.every((item) => item.account_key === accountKeys[0]), true);

  const checkinResponse = await handleRequest(
    request("/api/history/events?page_size=100&source=checkin"),
    env,
  );
  assert.equal(checkinResponse.status, 200);
  const checkins = await checkinResponse.json();
  assert.equal(checkins.items.length > 0, true);
  assert.equal(checkins.items.every((item) => item.source === "checkin"), true);
});

test("full history API rejects malformed pagination and filters", async () => {
  const env = envWith();
  const invalidQueries = [
    "?page=0",
    "?page=1.5",
    "?page_size=0",
    "?page_size=101",
    "?account_key=all",
    "?source=unknown",
    "?from=2026-02-30",
    "?to=18-07-2026",
    "?from=2026-07-19&to=2026-07-18",
  ];
  for (const query of invalidQueries) {
    const response = await handleRequest(request(`/api/history/events${query}`), env);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "invalid_history_query");
  }
});

test("admin migrate imports legacy history and backfills full tables idempotently", async () => {
  const history = emptyHistory();
  history.runs = [
    {
      run_id: "legacy-run-1",
      run_number: 1,
      run_attempt: 1,
      started_at: "2026-07-17T00:00:00.000Z",
      finished_at: "2026-07-17T00:01:00.000Z",
      planned_draws: 2,
      status: "success",
      source: "gwent",
      account_count: 1,
      successful_draws: 2,
      total_quota: 750000,
    },
    {
      run_id: "legacy-run-2",
      run_number: 2,
      run_attempt: 1,
      started_at: "2026-07-18T00:00:00.000Z",
      finished_at: "2026-07-18T00:01:00.000Z",
      planned_draws: 1,
      status: "success",
      source: "quiz",
      account_count: 1,
      successful_draws: 1,
      total_quota: 500000,
    },
  ];
  history.events = [
    fullHistoryEvent({ event_id: "legacy-event-1", run_id: "legacy-run-1" }),
    fullHistoryEvent({
      event_id: "legacy-event-2",
      run_id: "legacy-run-1",
      prize_quota: 250000,
    }),
    fullHistoryEvent({
      event_id: "legacy-event-3",
      run_id: "legacy-run-2",
      task_type: "quiz",
    }),
  ];
  const env = envWith();
  env.CONFIG_KV = {
    async get(key) {
      return key === "gwent-history-v1.json" ? JSON.stringify(history) : null;
    },
  };

  const firstResponse = await handleRequest(
    request("/api/admin/migrate", { method: "POST", token: "admin-secret", body: {} }),
    env,
  );
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.deepEqual(first.history_backfill, {
    runs_seen: 2,
    events_seen: 3,
    runs_inserted: 2,
    events_inserted: 3,
  });
  assert.equal(env.STATE_DB.automationRuns.size, 2);
  assert.equal(env.STATE_DB.automationEvents.size, 3);

  const secondResponse = await handleRequest(
    request("/api/admin/migrate", { method: "POST", token: "admin-secret", body: {} }),
    env,
  );
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal(second.history_backfill.runs_inserted, 0);
  assert.equal(second.history_backfill.events_inserted, 0);
  assert.equal(env.STATE_DB.automationRuns.size, 2);
  assert.equal(env.STATE_DB.automationEvents.size, 3);
});

test("history write and backfill failures return explicit retryable errors", async () => {
  const account = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "cookie-value",
  };
  const writeEnv = envWith({
    "newapi-config.json": { accounts: [account] },
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  writeEnv.STATE_DB.failHistoryWrites = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/api/gwent/status")) {
      return responseJson({
        success: true,
        data: { charges_current: 1, extra_draws_left: 0, tasks: {} },
      });
    }
    if (value.endsWith("/api/gwent/share_unlock")) {
      return responseJson({ success: true, message: "已激活" });
    }
    if (value.endsWith("/api/gwent/draw")) {
      return responseJson({
        success: true,
        data: { prize: { name: "测试奖励", quota: 500000, rarity: "rare" } },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const failedWrite = await handleRequest(
      request("/api/admin/run", {
        method: "POST",
        token: "admin-secret",
        headers: { "idempotency-key": "history-write-failure-01" },
        body: { action: "draw", account_keys: ["all"], draw_count: 1 },
      }),
      writeEnv,
    );
    assert.equal(failedWrite.status, 500);
    assert.equal((await failedWrite.json()).error.code, "history_write_failed");
    assert.equal(writeEnv.STATE_DB.value("gwent-history-v1.json"), null);
    assert.equal(writeEnv.STATE_DB.automationEvents.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const history = emptyHistory();
  history.runs = [{
    run_id: "backfill-run",
    started_at: "2026-07-18T00:00:00.000Z",
    finished_at: "2026-07-18T00:01:00.000Z",
    status: "success",
    source: "gwent",
  }];
  history.events = [fullHistoryEvent({ event_id: "backfill-event", run_id: "backfill-run" })];
  const backfillEnv = envWith({ "gwent-history-v1.json": history });
  backfillEnv.STATE_DB.failHistoryWrites = true;
  const failedBackfill = await handleRequest(
    request("/api/admin/migrate", { method: "POST", token: "admin-secret", body: {} }),
    backfillEnv,
  );
  assert.equal(failedBackfill.status, 500);
  assert.equal((await failedBackfill.json()).error.code, "history_backfill_failed");
  backfillEnv.STATE_DB.failHistoryWrites = false;
  const retried = await handleRequest(
    request("/api/admin/migrate", { method: "POST", token: "admin-secret", body: {} }),
    backfillEnv,
  );
  assert.equal(retried.status, 200);
  assert.equal(backfillEnv.STATE_DB.automationEvents.size, 1);
});

test("dashboard exposes SQL-backed today draws and wins without changing totals", async () => {
  const account = {
    name: "一号",
    url: "https://vsllm.com",
    user_id: "101",
    session: "cookie-value",
  };
  const key = await accountKey(account, 1);
  const history = emptyHistory();
  history.totals = {
    total_runs: 9,
    total_draws: 10,
    total_wins: 8,
    total_quota: 4000000,
    total_accounts: 1,
  };
  history.accounts = [{
    account_key: key,
    account_name: "一号",
    total_draws: 10,
    total_wins: 8,
    total_quota: 4000000,
    last_event_at: "2026-07-18T01:00:00.000Z",
    last_status: "success",
  }];
  const env = envWith({
    "newapi-config.json": { accounts: [account] },
    "gwent-history-v1.json": history,
    "automation-settings-v1.json": DEFAULT_SETTINGS,
  });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  for (const event of [
    fullHistoryEvent({ event_id: "today-win", account_key: key, local_date: today }),
    fullHistoryEvent({
      event_id: "today-empty",
      account_key: key,
      local_date: today,
      prize_quota: 0,
    }),
    fullHistoryEvent({
      event_id: "today-error",
      account_key: key,
      local_date: today,
      status: "error",
    }),
  ]) {
    env.STATE_DB.automationEvents.set(event.event_id, event);
  }

  const response = await handleRequest(request("/api/dashboard"), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  const accountData = data.accounts.find((item) => item.account_key === key);
  assert.equal(accountData.today_draws, 2);
  assert.equal(accountData.today_wins, 1);
  assert.equal(accountData.today_quota, 500000);
  assert.deepEqual(data.totals, history.totals);
});
