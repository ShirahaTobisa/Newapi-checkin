import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  accountKey,
  checkinAccount,
  getBalance,
  getGwentStatus,
  normalizeAccounts,
  runAd,
  runQuiz,
  unlockAndDraw,
} from "../src/vsllm.mjs";

const existingAccount = {
  url: "https://vsllm.com",
  session: "session-secret",
  user_id: "123",
  cf_clearance: "clearance-secret",
  name: "主号",
};

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function queuedFetch(entries) {
  const queue = [...entries];
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (!queue.length) throw new Error(`Unexpected fetch: ${url}`);
    const entry = queue.shift();
    if (entry instanceof Error) throw entry;
    if (typeof entry === "function") return entry(url, init, calls.length - 1);
    return entry;
  };
  return { fetch, calls, remaining: () => queue.length };
}

function statusPayload({ quiz, ad, ...data } = {}) {
  return {
    success: true,
    data: {
      charges_current: 2,
      extra_draws_left: 1,
      ...data,
      tasks: {
        ...(quiz ? { task3: quiz } : {}),
        ...(ad ? { task2: ad } : {}),
      },
    },
  };
}

test("normalizeAccounts accepts existing and reference secret shapes", () => {
  const accounts = normalizeAccounts(JSON.stringify([
    existingAccount,
    { cookie: "session=reference-cookie", userId: 456, name: "副号" },
  ]));

  assert.deepEqual(accounts[0], {
    name: "主号",
    baseUrl: "https://vsllm.com",
    userId: "123",
    cookie: "session=session-secret; cf_clearance=clearance-secret",
    isVsllm: true,
  });
  assert.equal(accounts[1].baseUrl, "https://vsllm.com");
  assert.equal(accounts[1].userId, "456");
  assert.equal(accounts[1].cookie, "session=reference-cookie");
  assert.throws(
    () => normalizeAccounts([{ url: "http://vsllm.com", session: "x" }]),
    /HTTPS/u,
  );
  assert.throws(
    () => normalizeAccounts([{ url: "https://vsllm.com", session: "x\r\nInjected: yes" }]),
    /Cookie/u,
  );
});

test("accountKey preserves the existing host and user-id SHA-256 identity", async () => {
  const expected = createHash("sha256").update("vsllm.com:123").digest("hex").slice(0, 16);
  assert.equal(await accountKey(existingAccount, 1), expected);

  const changedCookie = { ...existingAccount, session: "rotated-cookie" };
  assert.equal(await accountKey(changedCookie, 1), expected);
});

test("generic check-in uses safe headers and returns only allowlisted data", async () => {
  const account = {
    url: "https://api.example.com",
    session: "private-session",
    user_id: "77",
    name: "通用站点",
  };
  const mock = queuedFetch([
    jsonResponse({
      success: true,
      message: "签到成功 cookie=private-session",
      data: { checkin_date: "2026-07-18", quota_awarded: "500,000", token: "do-not-return" },
    }),
  ]);

  const result = await checkinAccount(account, { fetch: mock.fetch });
  assert.equal(result.ok, true);
  assert.equal(result.quota_awarded, 500000);
  assert.equal(result.checkin_date, "2026-07-18");
  assert.doesNotMatch(JSON.stringify(result), /private-session|do-not-return/u);
  assert.equal(mock.calls[0].init.headers.get("Cookie"), "session=private-session");
  assert.equal(mock.calls[0].init.headers.get("new-api-user"), "77");
  assert.equal(mock.calls[0].init.redirect, "manual");
  assert.equal(mock.calls[0].url, "https://api.example.com/api/user/checkin");
});

test("bounded response parsing rejects oversized bodies without exposing them", async () => {
  const secretBody = JSON.stringify({ success: true, data: "secret".repeat(400) });
  const mock = queuedFetch([
    new Response(secretBody, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(secretBody.length) },
    }),
  ]);

  const result = await checkinAccount(existingAccount, {
    fetch: mock.fetch,
    maxResponseBytes: 1024,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.doesNotMatch(JSON.stringify(result), /secretsecret/u);
});

test("getBalance keeps raw quota and converts 500000 quota to one yuan", async () => {
  const mock = queuedFetch([
    jsonResponse({
      success: true,
      data: { quota: 500000, used_quota: 1250000, request_count: 9 },
    }),
  ]);

  const result = await getBalance(existingAccount, { fetch: mock.fetch });
  assert.equal(result.ok, true);
  assert.equal(result.quota_raw, 500000);
  assert.equal(result.balance_quota, 500000);
  assert.equal(result.balance_microyuan, 1_000_000);
  assert.equal(result.balance_yuan, "1.000000");
  assert.equal(result.used_yuan, "2.500000");
  assert.equal(result.request_count, 9);
});

test("global fetch keeps the Cloudflare Workers receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiver;
  globalThis.fetch = async function fetchWithReceiver() {
    receiver = this;
    return jsonResponse({ success: true, data: { quota: 500000 } });
  };

  try {
    const result = await getBalance(existingAccount);
    assert.equal(result.ok, true);
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("balance transport diagnostics are admin-safe and redact account secrets", async () => {
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await getBalance(existingAccount, {
      fetch: async () => {
        throw new TypeError("connection failed for session-secret");
      },
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /TypeError/u);
  assert.doesNotMatch(result.diagnostic, /session-secret/u);
});

test("getGwentStatus exposes only normalized charges and task state", async () => {
  const mock = queuedFetch([
    jsonResponse(statusPayload({
      quiz: { status: "pending", debug_token: "hidden" },
      ad: { done_count: 1, daily_cap: 99, next_available_at: 2_000, duration_sec: 12 },
      next_charge_at: 3_000,
      secret: "not-public",
    })),
  ]);

  const result = await getGwentStatus(existingAccount, { fetch: mock.fetch, now: 1_000 });
  assert.equal(result.ok, true);
  assert.equal(result.available, 3);
  assert.deepEqual(result.quiz, { status: "pending", suspended: false });
  assert.equal(result.ad.status, "cooldown");
  assert.equal(result.ad.done_count, 1);
  assert.equal(result.ad.daily_cap, 3);
  assert.equal(result.ad.next_available_at, 2_000);
  assert.doesNotMatch(JSON.stringify(result), /hidden|not-public/u);
});

test("unlockAndDraw activates share bonus before one draw and parses the prize", async () => {
  const mock = queuedFetch([
    jsonResponse({ success: true, message: "50% 加成已激活" }),
    jsonResponse({
      success: true,
      message: "翻牌成功",
      data: {
        prize: { name: "黄金卡", quota: "1,250", rarity: "rare" },
        bonus_pct: 0.5,
        charges_current: 1,
        extra_draws_left: 2,
      },
    }),
  ]);

  const result = await unlockAndDraw(existingAccount, { fetch: mock.fetch });
  assert.equal(result.ok, true);
  assert.equal(result.prize_name, "黄金卡");
  assert.equal(result.prize_quota, 1250);
  assert.equal(result.bonus_percent, 50);
  assert.equal(result.available_after, 3);
  assert.deepEqual(
    mock.calls.map((call) => new URL(call.url).pathname),
    ["/api/gwent/share_unlock", "/api/gwent/draw"],
  );
  assert.equal(mock.remaining(), 0);
});

test("unlock failure prevents the draw request", async () => {
  const mock = queuedFetch([
    jsonResponse({ success: false, message: "解锁失败" }, 409),
  ]);

  const result = await unlockAndDraw(existingAccount, { fetch: mock.fetch });
  assert.equal(result.ok, false);
  assert.equal(result.draw_sent, false);
  assert.equal(mock.calls.length, 1);
});

test("unlockAndDraw skips share unlock when shareBonus is disabled", async () => {
  const mock = queuedFetch([
    jsonResponse({
      success: true,
      data: { prize: { name: "普通卡", quota: 10, rarity: "common" } },
    }),
  ]);

  const result = await unlockAndDraw(existingAccount, {
    fetch: mock.fetch,
    shareBonus: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.unlock, {
    ok: true,
    status: "skipped",
    message: "未启用加成",
  });
  assert.equal(result.draw_sent, true);
  assert.equal(result.bonus_percent, 0);
  assert.deepEqual(mock.calls.map((call) => new URL(call.url).pathname), ["/api/gwent/draw"]);
});

test("network failure after draw request is uncertain and is never retried", async () => {
  const networkError = new TypeError("socket closed with session-secret");
  const mock = queuedFetch([
    jsonResponse({ success: true, message: "加成已激活" }),
    networkError,
  ]);
  const originalError = console.error;
  const errorLogs = [];
  console.error = (...values) => errorLogs.push(values.join(" "));

  let result;
  try {
    result = await unlockAndDraw(existingAccount, { fetch: mock.fetch });
  } finally {
    console.error = originalError;
  }
  assert.equal(result.ok, false);
  assert.equal(result.status, "uncertain");
  assert.equal(result.draw_sent, true);
  assert.equal(mock.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /session-secret|socket closed/u);
  assert.match(errorLogs.join("\n"), /upstream_fetch_failed/u);
  assert.doesNotMatch(errorLogs.join("\n"), /session-secret/u);
});

test("timeout after draw request is uncertain and is never retried", async () => {
  const timeoutError = new Error("timed out");
  timeoutError.name = "AbortError";
  const mock = queuedFetch([
    jsonResponse({ success: true }),
    timeoutError,
  ]);

  const result = await unlockAndDraw(existingAccount, { fetch: mock.fetch });
  assert.equal(result.status, "uncertain");
  assert.equal(result.message, "请求超时");
  assert.equal(result.draw_sent, true);
  assert.equal(mock.calls.length, 2);
});

test("an unreadable draw response is uncertain because the draw may have executed", async () => {
  const mock = queuedFetch([
    jsonResponse({ success: true }),
    new Response("not json", { status: 200 }),
  ]);

  const result = await unlockAndDraw(existingAccount, { fetch: mock.fetch });
  assert.equal(result.status, "uncertain");
  assert.equal(result.draw_sent, true);
  assert.equal(mock.calls.length, 2);
});

test("runQuiz tries the known answer first and leaves reward drawing to the caller", async () => {
  const sleeps = [];
  const mock = queuedFetch([
    jsonResponse(statusPayload({ quiz: { status: "pending" } })),
    jsonResponse({
      success: true,
      data: { question: { text: "v9.11 和 v9.9 哪个更大？", options: ["v9.9", "v9.11"] } },
    }),
    jsonResponse({ success: true, data: { correct: true } }),
  ]);

  const result = await runQuiz(existingAccount, {
    fetch: mock.fetch,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reward_ready, true);
  assert.equal(result.newly_completed, true);
  assert.deepEqual(result.attempts, [{ answer_index: 1, correct: true }]);
  assert.deepEqual(sleeps, [2200]);
  assert.deepEqual(
    mock.calls.map((call) => new URL(call.url).pathname),
    ["/api/gwent/status", "/api/gwent/task3/start", "/api/gwent/task3/answer"],
  );
  assert.deepEqual(JSON.parse(mock.calls[2].init.body), { answer_index: 1 });
});

test("runQuiz tries remaining alternatives but never exceeds twenty answers", async () => {
  let questionNumber = 0;
  let answerCount = 0;
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/gwent/status") {
      return jsonResponse(statusPayload({ quiz: { status: "pending" } }));
    }
    if (path === "/api/gwent/task3/start") {
      const current = questionNumber;
      questionNumber += 1;
      return jsonResponse({
        success: true,
        data: { question: { text: `unknown-${current}`, options: ["A"] } },
      });
    }
    if (path === "/api/gwent/task3/answer") {
      answerCount += 1;
      return jsonResponse({ success: true, data: { correct: false } });
    }
    throw new Error(`Unexpected path ${path}`);
  };

  const result = await runQuiz(existingAccount, {
    fetch,
    sleep: async () => {},
    maxQuizAttempts: 999,
  });
  assert.equal(result.ok, false);
  assert.equal(answerCount, 20);
  assert.equal(result.attempts.length, 20);
  assert.match(result.message, /20/u);
});

test("runAd respects cooldown without starting or claiming", async () => {
  const mock = queuedFetch([
    jsonResponse(statusPayload({
      ad: { done_count: 1, daily_cap: 3, next_available_at: 2_000 },
    })),
  ]);

  const result = await runAd(existingAccount, { fetch: mock.fetch, now: 1_000 });
  assert.equal(result.ok, true);
  assert.equal(result.status, "cooldown");
  assert.equal(result.skipped, true);
  assert.equal(result.reward_ready, false);
  assert.equal(mock.calls.length, 1);
});

test("runAd waits at most 121 seconds, claims once, refreshes status, and never draws", async () => {
  const sleeps = [];
  const mock = queuedFetch([
    jsonResponse(statusPayload({
      ad: { done_count: 0, daily_cap: 99, next_available_at: 0 },
    })),
    jsonResponse({ success: true, data: { duration_sec: 999 } }),
    jsonResponse({ success: true, message: "领取成功" }),
    jsonResponse(statusPayload({
      ad: { done_count: 1, daily_cap: 99, next_available_at: 2_000 },
    })),
  ]);

  const result = await runAd(existingAccount, {
    fetch: mock.fetch,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    now: 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "claimed");
  assert.equal(result.reward_ready, true);
  assert.equal(result.newly_completed, true);
  assert.equal(result.duration_seconds, 120);
  assert.equal(result.task.done_count, 1);
  assert.equal(result.task.daily_cap, 3);
  assert.equal(result.task_status, "cooldown");
  assert.deepEqual(sleeps, [121_000]);
  assert.deepEqual(
    mock.calls.map((call) => new URL(call.url).pathname),
    ["/api/gwent/status", "/api/gwent/ad/start", "/api/gwent/ad/claim", "/api/gwent/status"],
  );
});

test("runAd reconciles an uncertain claim when the refreshed count increased", async () => {
  const mock = queuedFetch([
    jsonResponse(statusPayload({
      ad: { done_count: 1, daily_cap: 3, next_available_at: 0 },
    })),
    jsonResponse({ success: true, data: { duration_sec: 1 } }),
    new TypeError("connection reset"),
    jsonResponse(statusPayload({
      ad: { done_count: 2, daily_cap: 3, next_available_at: 3_000 },
    })),
  ]);

  const result = await runAd(existingAccount, {
    fetch: mock.fetch,
    sleep: async () => {},
    now: 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reward_ready, true);
  assert.equal(result.after_done_count, 2);
  assert.equal(mock.calls.length, 4);
});

test("runAd applies a stricter configured daily limit to skip and completion state", async () => {
  const alreadyDone = queuedFetch([
    jsonResponse(statusPayload({
      ad: { done_count: 1, daily_cap: 3, next_available_at: 0 },
    })),
  ]);
  const skipped = await runAd(existingAccount, {
    fetch: alreadyDone.fetch,
    dailyLimit: 1,
    now: 1_000,
  });
  assert.equal(skipped.status, "completed");
  assert.equal(skipped.task_status, "completed");
  assert.equal(skipped.task.daily_cap, 1);
  assert.equal(skipped.done_count, 1);
  assert.equal(alreadyDone.calls.length, 1);

  const claim = queuedFetch([
    jsonResponse(statusPayload({
      ad: { done_count: 0, daily_cap: 3, next_available_at: 0 },
    })),
    jsonResponse({ success: true, data: { duration_sec: 1 } }),
    jsonResponse({ success: true }),
    jsonResponse(statusPayload({
      ad: { done_count: 1, daily_cap: 3, next_available_at: 2_000 },
    })),
  ]);
  const completed = await runAd(existingAccount, {
    fetch: claim.fetch,
    sleep: async () => {},
    dailyLimit: 1,
    now: 1_000,
  });
  assert.equal(completed.reward_ready, true);
  assert.equal(completed.task_status, "completed");
  assert.equal(completed.task.completed, true);
  assert.equal(completed.task.daily_cap, 1);
});
