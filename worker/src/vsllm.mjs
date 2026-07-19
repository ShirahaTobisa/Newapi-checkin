const DEFAULT_VSLLM_URL = "https://vsllm.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_QUOTA_PER_YUAN = 500_000;
const DEFAULT_AD_DURATION_SECONDS = 15;
const MAX_AD_DURATION_SECONDS = 120;
const MAX_QUIZ_ATTEMPTS = 20;
const MAX_MESSAGE_LENGTH = 180;
const MAX_ACCOUNT_NAME_LENGTH = 64;
const MAX_COOKIE_LENGTH = 16 * 1024;

const textEncoder = new TextEncoder();
const sensitiveAssignment =
  /(?:authorization|cookie|session|token|password|cf_clearance)\s*(?::|=)\s*(?:bearer\s+)?[^\s,;]+/giu;
const bearerValue = /bearer\s+[A-Za-z0-9._~+/=-]+/giu;
const cooldownMarkers = [
  "冷却",
  "次数不足",
  "暂无可用",
  "cooldown",
  "too soon",
  "next draw",
  "no available",
];
const quizTaskStates = new Set([
  "pending",
  "available",
  "ready",
  "in_progress",
  "completed",
  "done",
  "success",
  "claimed",
  "unknown",
]);
const taskRewardTypes = new Set(["charge", "extra_draw", "quota"]);

function compactText(value, fallback = "", limit = MAX_MESSAGE_LENGTH) {
  const text = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(sensitiveAssignment, "***")
    .replace(bearerValue, "Bearer ***")
    .replace(/\s+/gu, " ")
    .trim();
  return text.slice(0, limit);
}

function secretValues(account) {
  if (!account || typeof account !== "object") return [];
  const values = new Set();
  for (const value of [account.cookie, account.session, account.cf_clearance, account.cfClearance]) {
    if (typeof value !== "string" || value.length < 4) continue;
    values.add(value);
    for (const part of value.split(";")) {
      const separator = part.indexOf("=");
      const candidate = (separator >= 0 ? part.slice(separator + 1) : part).trim();
      if (candidate.length >= 4) values.add(candidate);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function safeMessage(value, account, fallback = "请求失败") {
  let text = String(value ?? fallback);
  for (const secret of secretValues(account)) {
    text = text.split(secret).join("***");
  }
  return compactText(text, fallback);
}

function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") {
    return null;
  }
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", "").trim());
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) return null;
  return number;
}

function quotaInteger(value) {
  return safeInteger(value, { minimum: 0 }) ?? 0;
}

function normalizeBonusPercent(value) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") {
    return 0;
  }
  const number = Number(String(value).replaceAll(",", "").trim());
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number > 0 && number <= 1 ? number * 100 : number);
}

function quotaWithBonus(rawValue, bonusPercent) {
  const rawQuota = quotaInteger(rawValue);
  const percent = normalizeBonusPercent(bonusPercent);
  const adjustedQuota = Math.round(rawQuota * (1 + percent / 100));
  return Number.isSafeInteger(adjustedQuota) && adjustedQuota >= 0 ? adjustedQuota : rawQuota;
}

function quotaResult(rawValue, quotaPerYuan = DEFAULT_QUOTA_PER_YUAN) {
  const quotaRaw = quotaInteger(rawValue);
  const unit = safeInteger(quotaPerYuan, { minimum: 1 }) ?? DEFAULT_QUOTA_PER_YUAN;
  const amountMicroyuan = Number.isSafeInteger(quotaRaw * 1_000_000)
    ? Math.trunc((quotaRaw * 1_000_000) / unit)
    : null;
  const amountYuan = amountMicroyuan === null
    ? null
    : `${Math.trunc(amountMicroyuan / 1_000_000)}.${String(amountMicroyuan % 1_000_000).padStart(6, "0")}`;
  return {
    quota_raw: quotaRaw,
    quota_per_yuan: unit,
    amount_microyuan: amountMicroyuan,
    amount_yuan: amountYuan,
  };
}

function normalizedBaseUrl(value) {
  const candidate = String(value || DEFAULT_VSLLM_URL).trim();
  if (candidate.length === 0 || candidate.length > 2048 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new TypeError("账号 URL 无效");
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError("账号 URL 无效");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("账号 URL 必须是不含认证信息、查询参数或片段的 HTTPS 地址");
  }
  return url.href.replace(/\/+$/u, "");
}

function cookieItems(value) {
  const items = new Map();
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    if (!name || items.has(name)) continue;
    items.set(name, part.slice(separator + 1).trim());
  }
  return items;
}

function normalizedCookie(input) {
  const cookieValue = input.cookie ?? input.session;
  if (typeof cookieValue !== "string" || cookieValue.trim().length === 0) {
    throw new TypeError("账号缺少 Cookie/Session");
  }
  let value = cookieValue.trim();
  if (value.length > MAX_COOKIE_LENGTH || /[\r\n\u0000]/u.test(value)) {
    throw new TypeError("账号 Cookie 无效");
  }
  const hasHeaderPrefix = /^cookie\s*:/iu.test(value);
  if (hasHeaderPrefix) value = value.replace(/^cookie\s*:\s*/iu, "");

  const hasCookieSyntax = hasHeaderPrefix || value.includes(";") || /^session\s*=/iu.test(value);
  const items = hasCookieSyntax ? cookieItems(value) : null;
  const session = hasCookieSyntax ? items.get("session") : value;
  if (typeof session !== "string" || session.length === 0) {
    throw new TypeError("账号 Cookie 缺少 session");
  }

  const inlineClearance = items?.get("cf_clearance") || "";
  const configuredClearance = input.cf_clearance ?? input.cfClearance;
  let cfClearance = typeof configuredClearance === "string" && configuredClearance.trim()
    ? configuredClearance.trim()
    : inlineClearance;
  if (/^cf_clearance\s*=/iu.test(cfClearance)) {
    cfClearance = cfClearance.replace(/^cf_clearance\s*=\s*/iu, "");
  }
  cfClearance = cfClearance.replace(/;\s*$/u, "").trim();
  if (
    /[;\r\n\u0000]/u.test(cfClearance) ||
    `session=${session}; cf_clearance=${cfClearance};`.length > MAX_COOKIE_LENGTH
  ) {
    throw new TypeError("账号 cf_clearance 无效");
  }
  return {
    cookie: `session=${session};`,
    cfClearance,
  };
}

function normalizeAccount(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`第 ${index + 1} 个账号格式无效`);
  }
  const baseUrl = normalizedBaseUrl(input.baseUrl ?? input.url ?? DEFAULT_VSLLM_URL);
  const { cookie, cfClearance } = normalizedCookie(input);
  const rawUserId = input.userId ?? input.user_id;
  const userId = rawUserId === null || rawUserId === undefined
    ? ""
    : String(rawUserId).trim();
  if (userId.length > 128 || /[\r\n\u0000]/u.test(userId)) {
    throw new TypeError(`第 ${index + 1} 个账号 userId 无效`);
  }
  const name = compactText(input.name, `账号${index + 1}`, MAX_ACCOUNT_NAME_LENGTH) || `账号${index + 1}`;
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/u, "");
  return {
    name,
    baseUrl,
    userId,
    cookie,
    ...(cfClearance ? { cfClearance } : {}),
    isVsllm: hostname === "vsllm.com",
  };
}

export function normalizeAccounts(config) {
  let value = config;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new TypeError("ACCOUNTS_JSON 不是有效 JSON");
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.accounts)) {
    value = value.accounts;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    value = [value];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("账号配置必须是非空数组");
  }
  return value.map((account, index) => normalizeAccount(account, index));
}

function operationAccount(account) {
  try {
    return { account: normalizeAccount(account, 0), error: null };
  } catch (error) {
    return {
      account: null,
      error: {
        ok: false,
        success: false,
        status: "invalid",
        message: compactText(error instanceof Error ? error.message : "账号配置无效"),
      },
    };
  }
}

export async function accountKey(account, index = 1) {
  const normalized = normalizeAccount(account, Math.max(0, Number(index) - 1 || 0));
  const host = new URL(normalized.baseUrl).hostname.toLowerCase().replace(/\.$/u, "");
  const rawIdentity = account && typeof account === "object"
    ? account.userId ?? account.user_id ?? account.name
    : null;
  const identity = String(rawIdentity || index);
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto unavailable");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`${host}:${identity}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function optionNumber(options, name, fallback, minimum, maximum) {
  const value = options?.[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function fetchImplementation(options) {
  if (typeof options?.fetch === "function") return options.fetch;
  if (typeof globalThis.fetch !== "function") throw new TypeError("fetch 不可用");
  return globalThis.fetch.bind(globalThis);
}

function requestHeaders(account) {
  const cookie = account.cfClearance
    ? `${account.cookie} cf_clearance=${account.cfClearance};`
    : account.cookie;
  const headers = new Headers({
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    Cookie: cookie,
  });
  if (account.userId) headers.set("new-api-user", account.userId);
  return headers;
}

async function readJsonLimited(response, maximumBytes) {
  const declaredLength = safeInteger(response.headers.get("content-length"), { minimum: 0 });
  if (declaredLength !== null && declaredLength > maximumBytes) {
    try {
      await response.body?.cancel("response too large");
    } catch {
      // Best-effort cancellation only.
    }
    return { ok: false, error: "too_large" };
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    return { ok: false, error: "empty" };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("response too large");
        return { ok: false, error: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "read_failed" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) return { ok: false, error: "empty" };
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value }
      : { ok: false, error: "invalid_shape" };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

async function apiRequest(account, path, requestOptions = {}, options = {}) {
  const timeoutMs = optionNumber(options, "timeoutMs", DEFAULT_TIMEOUT_MS, 1, 120_000);
  const maximumBytes = optionNumber(
    options,
    "maxResponseBytes",
    DEFAULT_MAX_RESPONSE_BYTES,
    1024,
    256 * 1024,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const headers = requestHeaders(account);
  let body;
  if (Object.prototype.hasOwnProperty.call(requestOptions, "json")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    body = JSON.stringify(requestOptions.json);
  }

  let response;
  try {
    response = await fetchImplementation(options)(`${account.baseUrl}${path}`, {
      method: requestOptions.method || "GET",
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    clearTimeout(timeout);
    const transportDetail = safeMessage(
      error instanceof Error ? `${error.name}: ${error.message}` : error,
      account,
      "fetch failed",
    ).slice(0, 240);
    console.error(JSON.stringify({
      event: "upstream_fetch_failed",
      host: new URL(account.baseUrl).hostname,
      path,
      error: transportDetail,
    }));
    const timeoutError = controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
    return {
      received: false,
      transport_error: timeoutError ? "timeout" : "network",
      transport_detail: transportDetail,
      http_status: 0,
      response_ok: false,
      payload: null,
      parse_error: null,
    };
  }

  let parsed;
  try {
    parsed = await readJsonLimited(response, maximumBytes);
  } catch {
    parsed = { ok: false, error: controller.signal.aborted ? "read_timeout" : "read_failed" };
  } finally {
    clearTimeout(timeout);
  }
  return {
    received: true,
    transport_error: null,
    transport_detail: null,
    http_status: response.status,
    response_ok: response.ok,
    payload: parsed.ok ? parsed.value : null,
    parse_error: parsed.ok ? null : parsed.error,
  };
}

function apiMessage(result, account, fallback) {
  return safeMessage(result.payload?.message, account, fallback);
}

function failureStatus(result, message) {
  if (result.http_status === 401) return "auth";
  const lower = String(message || "").toLowerCase();
  return cooldownMarkers.some((marker) => lower.includes(marker)) ? "cooldown" : "error";
}

function endpointFailure(result, account, fallback, { uncertainTransport = false } = {}) {
  if (!result.received) {
    return {
      ok: false,
      success: false,
      status: uncertainTransport ? "uncertain" : "error",
      http_status: 0,
      message: result.transport_error === "timeout" ? "请求超时" : "网络请求失败",
    };
  }
  const message = result.parse_error
    ? `响应格式错误 (HTTP ${result.http_status})`
    : apiMessage(result, account, fallback);
  return {
    ok: false,
    success: false,
    status: failureStatus(result, message),
    http_status: result.http_status,
    message,
  };
}

function requireVsllm(account) {
  if (!account.isVsllm) {
    return {
      ok: false,
      success: false,
      status: "unsupported",
      message: "该操作仅支持 vsllm.com",
    };
  }
  if (!account.userId) {
    return {
      ok: false,
      success: false,
      status: "invalid",
      message: "VSLLM 账号缺少 userId",
    };
  }
  return null;
}

function successfulPayload(result, { allowMissingSuccess = false } = {}) {
  if (!result.received || result.parse_error || !result.response_ok || !result.payload) return false;
  return result.payload.success === true || (allowMissingSuccess && result.payload.success !== false);
}

function alreadyCheckedInMessage(value) {
  const message = String(value ?? "").normalize("NFKC").toLowerCase();
  return (
    /已(?:经)?\s*签到(?:过)?/u.test(message) ||
    /\balready[\s-]+check(?:ed)?[\s-]+in\b/u.test(message)
  );
}

export async function checkinAccount(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const result = await apiRequest(account, "/api/user/checkin", { method: "POST" }, options);
  const alreadyCheckedIn =
    result.received &&
    result.response_ok &&
    !result.parse_error &&
    result.payload &&
    alreadyCheckedInMessage(result.payload.message);
  if (!successfulPayload(result) && !alreadyCheckedIn) {
    return endpointFailure(result, account, "签到失败", { uncertainTransport: !result.received });
  }
  const data = result.payload.data && typeof result.payload.data === "object" ? result.payload.data : {};
  const checkinDate = safeMessage(data.checkin_date, account, "");
  return {
    ok: true,
    success: true,
    ...(alreadyCheckedIn ? { skipped: true, completed: true } : {}),
    status: alreadyCheckedIn ? "completed" : "success",
    http_status: result.http_status,
    message: apiMessage(result, account, "签到成功"),
    checkin_date: /^\d{4}-\d{2}-\d{2}$/u.test(checkinDate) ? checkinDate : null,
    quota_awarded: quotaInteger(data.quota_awarded),
  };
}

export async function getBalance(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const result = await apiRequest(account, "/api/user/self", { method: "GET" }, options);
  if (!successfulPayload(result)) {
    const failure = endpointFailure(result, account, "余额读取失败");
    return result.transport_detail
      ? { ...failure, diagnostic: result.transport_detail }
      : failure;
  }
  const data = result.payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return endpointFailure({ ...result, parse_error: "invalid_shape" }, account, "余额响应格式错误");
  }
  const quotaPerYuan = optionNumber(
    options,
    "quotaPerYuan",
    DEFAULT_QUOTA_PER_YUAN,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const balance = quotaResult(data.quota, quotaPerYuan);
  const used = quotaResult(data.used_quota, quotaPerYuan);
  return {
    ok: true,
    success: true,
    status: "success",
    http_status: result.http_status,
    message: apiMessage(result, account, "余额读取成功"),
    quota_raw: balance.quota_raw,
    quota: balance.quota_raw,
    balance_quota: balance.quota_raw,
    used_quota_raw: used.quota_raw,
    used_quota: used.quota_raw,
    quota_per_yuan: quotaPerYuan,
    balance_microyuan: balance.amount_microyuan,
    used_microyuan: used.amount_microyuan,
    balance_yuan: balance.amount_yuan,
    used_yuan: used.amount_yuan,
    request_count: quotaInteger(data.request_count),
  };
}

function normalizeEpochSeconds(value) {
  if (value === undefined) return null;
  if (value === null || value === "") return 0;
  const integer = safeInteger(value, { minimum: 0 });
  if (integer !== null) return integer > 100_000_000_000 ? Math.trunc(integer / 1000) : integer;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.trunc(timestamp / 1000)) : null;
}

function normalizeTaskReward(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const fields = {};
  if (Object.prototype.hasOwnProperty.call(value, "reward_type")) {
    const rawType = compactText(value.reward_type, "", 24).toLowerCase();
    fields.reward_type = taskRewardTypes.has(rawType) ? rawType : "unknown";
  }
  if (Object.prototype.hasOwnProperty.call(value, "reward_amount")) {
    fields.reward_amount = safeInteger(value.reward_amount, { minimum: 1, maximum: 100 });
  }
  return fields;
}

function normalizeQuizTask(value, account) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawStatus = safeMessage(value.status, account, "unknown").toLowerCase();
  // The upstream UI treats `won` as finished, but `lost` as retryable.
  const status = rawStatus === "won" ? "completed" : rawStatus === "lost" ? "pending" : rawStatus;
  return {
    status: quizTaskStates.has(status) ? status : "unknown",
    suspended: value.suspended === true,
    ...normalizeTaskReward(value),
  };
}

function normalizeAdTask(value, nowSeconds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doneCount = safeInteger(value.done_count, { minimum: 0 });
  const serverCap = safeInteger(value.daily_cap, { minimum: 1 }) ?? 3;
  const dailyCap = Math.min(serverCap, 3);
  const nextAvailableAt = normalizeEpochSeconds(value.next_available_at);
  const completed = doneCount !== null && doneCount >= dailyCap;
  let status = "unknown";
  if (value.suspended === true) status = "suspended";
  else if (completed) status = "completed";
  else if (nextAvailableAt !== null && nextAvailableAt > nowSeconds) status = "cooldown";
  else if (doneCount !== null && nextAvailableAt !== null) status = "available";
  return {
    status,
    suspended: value.suspended === true,
    completed,
    done_count: doneCount,
    daily_cap: dailyCap,
    next_available_at: nextAvailableAt,
    duration_seconds: normalizeAdDuration(value.duration_sec),
    min_interval_seconds: safeInteger(value.min_interval_sec, { minimum: 0 }),
    ...normalizeTaskReward(value),
  };
}

function normalizeAdDuration(value) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(1, Math.min(MAX_AD_DURATION_SECONDS, Math.trunc(number)));
}

function nowEpochSeconds(options) {
  let value = options?.now;
  if (typeof value === "function") value = value();
  if (value instanceof Date) return Math.trunc(value.getTime() / 1000);
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value > 100_000_000_000 ? value / 1000 : value);
  }
  return Math.trunc(Date.now() / 1000);
}

function rewardCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function rewardSnapshot(status) {
  if (!status || status.ok !== true) return null;
  return {
    charges_current: rewardCounter(status.charges_current),
    charges_max: rewardCounter(status.charges_max),
    extra_draws_left: rewardCounter(status.extra_draws_left),
    available: rewardCounter(status.available),
  };
}

function rewardDelta(before, after) {
  if (!before || !after) return null;
  return {
    charges_current:
      before.charges_current !== null && after.charges_current !== null
        ? after.charges_current - before.charges_current
        : null,
    extra_draws_left:
      before.extra_draws_left !== null && after.extra_draws_left !== null
        ? after.extra_draws_left - before.extra_draws_left
        : null,
  };
}

function taskRewardState(task, beforeStatus, afterStatus, { inactive = false } = {}) {
  const rewardType = task?.reward_type ?? null;
  const rewardAmount = task?.reward_amount ?? null;
  const before = rewardSnapshot(beforeStatus);
  const after = rewardSnapshot(afterStatus);
  const delta = rewardDelta(before, after);
  let status = inactive ? "not_applicable" : "unknown";
  let drawReady = false;

  if (!inactive && rewardAmount !== null && rewardAmount > 0) {
    if (rewardType === "quota") {
      status = "not_applicable";
    } else if (before && after && delta) {
      if (rewardType === "extra_draw") {
        if (delta.extra_draws_left !== null && delta.extra_draws_left >= rewardAmount) {
          status = "confirmed";
          drawReady = true;
        }
      } else if (rewardType === "charge") {
        const knownMax = before.charges_max ?? after.charges_max;
        if (delta.charges_current !== null && delta.charges_current >= rewardAmount) {
          status = knownMax === null ? "unknown" : "confirmed";
          drawReady = status === "confirmed";
        } else if (
          delta.charges_current === 0 &&
          knownMax !== null &&
          ((before.charges_current !== null && before.charges_current >= knownMax) ||
            (after.charges_current !== null && after.charges_current >= knownMax))
        ) {
          status = "capped";
        }
      }
    }
  }

  return {
    reward_type: rewardType,
    reward_amount: rewardAmount,
    reward_status: status,
    reward_before: before,
    reward_after: after,
    reward_delta: delta,
    reward_draw_ready: drawReady,
  };
}

export async function getGwentStatus(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const unsupported = requireVsllm(account);
  if (unsupported) return unsupported;
  const result = await apiRequest(account, "/api/gwent/status", { method: "GET" }, options);
  if (!successfulPayload(result)) return endpointFailure(result, account, "读取翻牌状态失败");
  const data = result.payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return endpointFailure({ ...result, parse_error: "invalid_shape" }, account, "翻牌状态格式错误");
  }
  const tasks = data.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks)
    ? data.tasks
    : {};
  const hasChargeFields =
    Object.prototype.hasOwnProperty.call(data, "charges_current") ||
    Object.prototype.hasOwnProperty.call(data, "extra_draws_left");
  const chargesCurrent = quotaInteger(data.charges_current);
  const extraDrawsLeft = quotaInteger(data.extra_draws_left);
  const chargesMax = safeInteger(data.charges_max, { minimum: 0 });
  return {
    ok: true,
    success: true,
    status: "success",
    http_status: result.http_status,
    message: apiMessage(result, account, "翻牌状态读取成功"),
    available: hasChargeFields ? chargesCurrent + extraDrawsLeft : null,
    charges_current: hasChargeFields ? chargesCurrent : null,
    extra_draws_left: hasChargeFields ? extraDrawsLeft : null,
    charges_max: chargesMax,
    next_available_at: normalizeEpochSeconds(data.next_available_at),
    next_charge_at: normalizeEpochSeconds(data.next_charge_at),
    cooldown_seconds: safeInteger(data.cooldown_seconds, { minimum: 0 }),
    quiz: normalizeQuizTask(tasks.task3, account),
    ad: normalizeAdTask(tasks.task2, nowEpochSeconds(options)),
  };
}

function prizeRarity(value) {
  const rarity = compactText(value, "unknown", 16).toLowerCase();
  return ["common", "rare", "epic", "legendary"].includes(rarity) ? rarity : "unknown";
}

export async function unlockAndDraw(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const unsupported = requireVsllm(account);
  if (unsupported) return unsupported;

  let unlockResult;
  if (options.shareBonus === false) {
    unlockResult = {
      ok: true,
      status: "skipped",
      message: "未启用加成",
    };
  } else {
    const unlock = await apiRequest(account, "/api/gwent/share_unlock", { method: "POST" }, options);
    const unlockMessage = apiMessage(unlock, account, "50% 加成解锁失败");
    const alreadyUnlocked = ["已解锁", "已激活", "已经", "already", "activated"].some((marker) =>
      unlockMessage.toLowerCase().includes(marker),
    );
    const unlockSuccess = successfulPayload(unlock, { allowMissingSuccess: true }) ||
      (unlock.received && !unlock.parse_error && unlock.http_status !== 401 && alreadyUnlocked);
    if (!unlockSuccess) {
      return {
        ...endpointFailure(unlock, account, "50% 加成解锁失败"),
        unlock: {
          ok: false,
          status: failureStatus(unlock, unlockMessage),
          http_status: unlock.http_status,
          message: unlockMessage,
        },
        draw_sent: false,
      };
    }

    unlockResult = {
      ok: true,
      status: "success",
      http_status: unlock.http_status,
      message: unlockMessage || "50% 加成已解锁",
    };
  }
  const draw = await apiRequest(account, "/api/gwent/draw", { method: "POST" }, options);
  if (!draw.received || draw.parse_error) {
    const uncertain = endpointFailure(draw, account, "翻牌结果无法确认", { uncertainTransport: true });
    return {
      ...uncertain,
      status: "uncertain",
      message: draw.parse_error ? `翻牌结果无法确认 (HTTP ${draw.http_status})` : uncertain.message,
      unlock: unlockResult,
      draw_sent: true,
    };
  }
  if (!successfulPayload(draw)) {
    return {
      ...endpointFailure(draw, account, "翻牌失败"),
      unlock: unlockResult,
      draw_sent: true,
    };
  }

  const data = draw.payload.data && typeof draw.payload.data === "object" ? draw.payload.data : {};
  const prize = data.prize && typeof data.prize === "object" ? data.prize : {};
  const hasChargeFields =
    Object.prototype.hasOwnProperty.call(data, "charges_current") ||
    Object.prototype.hasOwnProperty.call(data, "extra_draws_left");
  const chargesCurrent = quotaInteger(data.charges_current);
  const extraDrawsLeft = quotaInteger(data.extra_draws_left);
  const rawPrizeQuota = quotaInteger(prize.quota);
  const bonusPercent = options.shareBonus === false
    ? 0
    : normalizeBonusPercent(
        data.applied_bonus_pct ??
          data.applied_bonus_percent ??
          data.bonus_pct ??
          data.bonus_percent ??
          50,
      );
  return {
    ok: true,
    success: true,
    status: "success",
    http_status: draw.http_status,
    message: apiMessage(draw, account, "翻牌成功"),
    unlock: unlockResult,
    draw_sent: true,
    prize_name: safeMessage(prize.name, account, "未知奖品").slice(0, 80) || "未知奖品",
    base_prize_quota: rawPrizeQuota,
    prize_quota: quotaWithBonus(rawPrizeQuota, bonusPercent),
    prize_rarity: prizeRarity(prize.rarity),
    bonus_percent: bonusPercent,
    charges_current: hasChargeFields ? chargesCurrent : null,
    extra_draws_left: hasChargeFields ? extraDrawsLeft : null,
    available_after: hasChargeFields ? chargesCurrent + extraDrawsLeft : null,
  };
}

function normalizeQuizText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[?？。，!！:：\s]+/gu, "");
}

function quizOptionText(option) {
  if (option && typeof option === "object" && !Array.isArray(option)) {
    return String(option.text ?? option.label ?? option.value ?? "");
  }
  return String(option ?? "");
}

function knownQuizAnswer(question) {
  const text = normalizeQuizText(question?.text);
  const options = Array.isArray(question?.options) ? question.options : [];
  let target = "";
  if (text.includes("v9.11") && text.includes("v9.9")) target = "v9.11";
  else if (text.includes("9.11") && text.includes("9.9")) target = "9.9";
  if (!target) return -1;
  const normalized = options.map((option) => normalizeQuizText(quizOptionText(option)));
  let index = normalized.findIndex((value) => value === target);
  if (index < 0) index = normalized.findIndex((value) => value.includes(target));
  return index;
}

function quizQuestion(result) {
  const question = result.payload?.data?.question;
  if (!question || typeof question !== "object" || Array.isArray(question)) return null;
  if (!Array.isArray(question.options) || question.options.length === 0 || question.options.length > 20) {
    return null;
  }
  return question;
}

function quizOrder(question) {
  const indices = question.options.map((_, index) => index);
  const known = knownQuizAnswer(question);
  return known < 0 ? indices : [known, ...indices.filter((index) => index !== known)];
}

function quizFingerprint(question) {
  return JSON.stringify([
    normalizeQuizText(question.text),
    question.options.map((option) => normalizeQuizText(quizOptionText(option))),
  ]);
}

async function wait(options, milliseconds) {
  const sleep = options?.sleep ?? ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
  if (typeof sleep !== "function") throw new TypeError("sleep 必须是函数");
  await sleep(milliseconds);
}

export async function runQuiz(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const unsupported = requireVsllm(account);
  if (unsupported) return unsupported;

  const initialStatus = await getGwentStatus(account, options);
  if (!initialStatus.ok) return { ...initialStatus, reward_ready: false, newly_completed: false };
  const task = initialStatus.quiz;
  if (!task) {
    return {
      ok: false,
      success: false,
      status: "error",
      message: "答题任务状态缺失",
      reward_ready: false,
      newly_completed: false,
    };
  }
  if (task.suspended) {
    return {
      ok: true,
      success: true,
      status: "suspended",
      skipped: true,
      completed: false,
      reward_ready: false,
      newly_completed: false,
      message: "答题任务已暂停",
    };
  }
  if (["completed", "done", "success", "claimed"].includes(task.status)) {
    return {
      ok: true,
      success: true,
      status: "completed",
      skipped: true,
      completed: true,
      reward_ready: false,
      newly_completed: false,
      message: "今日答题已完成",
    };
  }
  if (!["pending", "available", "ready", "in_progress"].includes(task.status)) {
    return {
      ok: false,
      success: false,
      status: "error",
      completed: false,
      reward_ready: false,
      newly_completed: false,
      message: `未知答题任务状态: ${compactText(task.status, "unknown", 24)}`,
    };
  }

  const start = await apiRequest(account, "/api/gwent/task3/start", { method: "POST" }, options);
  if (!successfulPayload(start)) {
    return {
      ...endpointFailure(start, account, "开始答题失败", { uncertainTransport: !start.received }),
      completed: false,
      reward_ready: false,
      newly_completed: false,
    };
  }
  let question = quizQuestion(start);
  if (!question) {
    return {
      ok: false,
      success: false,
      status: "error",
      completed: false,
      reward_ready: false,
      newly_completed: false,
      message: "答题题目格式异常",
    };
  }

  const maxAttempts = optionNumber(options, "maxQuizAttempts", MAX_QUIZ_ATTEMPTS, 1, MAX_QUIZ_ATTEMPTS);
  const triedByQuestion = new Map();
  const attempts = [];
  for (let attemptNumber = 0; attemptNumber < maxAttempts; attemptNumber += 1) {
    const fingerprint = quizFingerprint(question);
    const tried = triedByQuestion.get(fingerprint) ?? new Set();
    triedByQuestion.set(fingerprint, tried);
    const answerIndex = quizOrder(question).find((index) => !tried.has(index));
    if (answerIndex === undefined) {
      return {
        ok: false,
        success: false,
        status: "error",
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
        message: "同一题的选项已全部尝试",
      };
    }
    tried.add(answerIndex);

    try {
      await wait(options, attemptNumber === 0 ? 2200 : 800);
    } catch {
      return {
        ok: false,
        success: false,
        status: "error",
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
        message: "答题等待失败",
      };
    }
    const answer = await apiRequest(
      account,
      "/api/gwent/task3/answer",
      { method: "POST", json: { answer_index: answerIndex } },
      options,
    );
    if (!successfulPayload(answer)) {
      return {
        ...endpointFailure(answer, account, "提交答案失败", { uncertainTransport: !answer.received }),
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
      };
    }
    const correct = answer.payload?.data?.correct;
    if (typeof correct !== "boolean") {
      return {
        ok: false,
        success: false,
        status: "uncertain",
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
        message: "答题结果格式异常",
      };
    }
    attempts.push({ answer_index: answerIndex, correct });
    if (correct) {
      // The answer endpoint only reports `correct`; confirm the charge was
      // actually credited before the caller schedules a reward draw.
      const refreshedStatus = await getGwentStatus(account, options);
      const rewardState = taskRewardState(task, initialStatus, refreshedStatus);
      const rewardMessage = rewardState.reward_status === "confirmed"
        ? "答题完成，奖励可翻牌"
        : rewardState.reward_status === "capped"
          ? "答题完成，但充能已达上限，跳过奖励翻牌"
          : "答题完成，但无法确认充能到账，暂不翻牌";
      return {
        ok: true,
        success: true,
        status: "completed",
        completed: true,
        skipped: false,
        reward_ready: true,
        ...rewardState,
        newly_completed: true,
        attempts,
        message: rewardMessage,
      };
    }

    if (attemptNumber + 1 >= maxAttempts) break;

    const restart = await apiRequest(account, "/api/gwent/task3/start", { method: "POST" }, options);
    if (!successfulPayload(restart)) {
      return {
        ...endpointFailure(restart, account, "答错后刷新题目失败", {
          uncertainTransport: !restart.received,
        }),
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
      };
    }
    question = quizQuestion(restart);
    if (!question) {
      return {
        ok: false,
        success: false,
        status: "error",
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
        message: "刷新响应缺少题目",
      };
    }
  }
  return {
    ok: false,
    success: false,
    status: "error",
    completed: false,
    reward_ready: false,
    newly_completed: false,
    attempts,
    message: `超过 ${maxAttempts} 次答题尝试`,
  };
}

function taskCandidate(payload) {
  const data = payload?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const tasks = data.tasks;
  for (const candidate of [
    tasks && typeof tasks === "object" ? tasks.task2 : null,
    data.task2,
    data.task,
    data,
  ]) {
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      ["done_count", "daily_cap", "next_available_at", "status", "suspended"].some((key) =>
        Object.prototype.hasOwnProperty.call(candidate, key),
      )
    ) {
      return candidate;
    }
  }
  return null;
}

function applyAdDailyLimit(task, dailyLimit, nowSeconds) {
  if (!task) return null;
  const cap = Math.min(task.daily_cap ?? 3, dailyLimit);
  const completed = task.done_count !== null && task.done_count >= cap;
  let status = task.status;
  if (task.suspended) status = "suspended";
  else if (completed) status = "completed";
  else if (task.next_available_at !== null && task.next_available_at > nowSeconds) status = "cooldown";
  else if (task.done_count !== null && task.next_available_at !== null) status = "available";
  else status = "unknown";
  return { ...task, status, completed, daily_cap: cap };
}

function adResult(result, task, taskStatus = task?.status ?? result.status) {
  if (!task) return result;
  return {
    ...result,
    task,
    task_status: taskStatus,
    completed: task.completed === true,
    done_count: task.done_count,
    daily_cap: task.daily_cap,
    next_available_at: task.next_available_at,
  };
}

export async function runAd(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const unsupported = requireVsllm(account);
  if (unsupported) return unsupported;

  const nowSeconds = nowEpochSeconds(options);
  const dailyLimit = optionNumber(options, "dailyLimit", 3, 1, 3);
  const initialStatus = await getGwentStatus(account, options);
  if (!initialStatus.ok) return { ...initialStatus, reward_ready: false, newly_completed: false };
  const task = applyAdDailyLimit(initialStatus.ad, dailyLimit, nowSeconds);
  if (!task) {
    return {
      ok: false,
      success: false,
      status: "error",
      message: "视频任务状态缺失",
      reward_ready: false,
      newly_completed: false,
    };
  }
  if (task.suspended) {
    return adResult({
      ok: true,
      success: true,
      status: "suspended",
      skipped: true,
      reward_ready: false,
      newly_completed: false,
      message: "视频任务已暂停",
    }, task);
  }
  if (task.done_count === null || task.next_available_at === null) {
    return adResult({
      ok: false,
      success: false,
      status: "error",
      reward_ready: false,
      newly_completed: false,
      message: "视频任务状态字段缺失或格式错误",
    }, { ...task, status: "error", completed: false }, "error");
  }
  if (task.done_count >= task.daily_cap) {
    const completedTask = { ...task, status: "completed", completed: true };
    return adResult({
      ok: true,
      success: true,
      status: "completed",
      skipped: true,
      reward_ready: false,
      newly_completed: false,
      message: "今日视频任务已完成",
    }, completedTask);
  }
  if (task.next_available_at > nowSeconds) {
    const cooldownTask = { ...task, status: "cooldown", completed: false };
    return adResult({
      ok: true,
      success: true,
      status: "cooldown",
      skipped: true,
      reward_ready: false,
      newly_completed: false,
      message: "视频任务冷却中",
    }, cooldownTask);
  }

  const start = await apiRequest(account, "/api/gwent/ad/start", { method: "POST" }, options);
  if (!successfulPayload(start)) {
    return adResult({
      ...endpointFailure(start, account, "开始视频任务失败", { uncertainTransport: !start.received }),
      reward_ready: false,
      newly_completed: false,
    }, { ...task, status: "error", completed: false }, "error");
  }
  const configuredDuration = normalizeAdDuration(start.payload?.data?.duration_sec) ??
    task.duration_seconds ??
    DEFAULT_AD_DURATION_SECONDS;
  const durationSeconds = Math.max(1, Math.min(MAX_AD_DURATION_SECONDS, configuredDuration));
  try {
    await wait(options, (durationSeconds + 1) * 1000);
  } catch {
    return adResult({
      ok: false,
      success: false,
      status: "error",
      reward_ready: false,
      newly_completed: false,
      duration_seconds: durationSeconds,
      message: "视频等待失败",
    }, { ...task, status: "error", completed: false }, "error");
  }

  const claim = await apiRequest(account, "/api/gwent/ad/claim", { method: "POST" }, options);
  const claimExplicitSuccess = successfulPayload(claim);
  const claimFailure = claimExplicitSuccess
    ? null
    : endpointFailure(claim, account, "领取视频奖励失败", { uncertainTransport: !claim.received });

  const refreshed = await getGwentStatus(account, options);
  const responseTask = applyAdDailyLimit(
    normalizeAdTask(taskCandidate(claim.payload), nowEpochSeconds(options)),
    dailyLimit,
    nowEpochSeconds(options),
  );
  const refreshedTask = refreshed.ok
    ? applyAdDailyLimit(refreshed.ad, dailyLimit, nowEpochSeconds(options))
    : null;
  const observedTask = refreshedTask ?? responseTask;
  const observedIncrease =
    observedTask?.done_count !== null &&
    observedTask?.done_count !== undefined &&
    observedTask.done_count > task.done_count;
  const rewardReady = claimExplicitSuccess || observedIncrease;
  const rewardState = taskRewardState(task, initialStatus, refreshed);

  if (!rewardReady) {
    const claimUncertain = !claim.received || claim.parse_error !== null;
    const finalTask = observedTask ?? { ...task, status: "unknown", completed: false };
    return adResult({
      ...(claimFailure ?? {
        ok: false,
        success: false,
        status: "uncertain",
        http_status: claim.http_status,
        message: "视频奖励是否到账无法确认",
      }),
      status: claimUncertain ? "uncertain" : (claimFailure?.status ?? "error"),
      reward_ready: false,
      ...rewardState,
      newly_completed: false,
      duration_seconds: durationSeconds,
      before_done_count: task.done_count,
      after_done_count: observedTask?.done_count ?? task.done_count,
    }, finalTask, claimUncertain ? "unknown" : finalTask.status);
  }

  const estimatedDone = Math.min(task.daily_cap, task.done_count + 1);
  const finalDone = Math.max(estimatedDone, observedTask?.done_count ?? 0);
  const dailyCap = Math.min(observedTask?.daily_cap ?? task.daily_cap, dailyLimit, 3);
  const nextAvailableAt = observedTask?.next_available_at ?? task.next_available_at;
  const completed = finalDone >= dailyCap;
  const finalStatus = completed
    ? "completed"
    : nextAvailableAt > nowEpochSeconds(options)
      ? "cooldown"
      : refreshed.ok
        ? "available"
        : "unknown";
  const finalTask = {
    ...task,
    status: finalStatus,
    suspended: false,
    completed,
    done_count: finalDone,
    daily_cap: dailyCap,
    next_available_at: nextAvailableAt,
    duration_seconds: observedTask?.duration_seconds ?? task.duration_seconds,
  };
  const rewardMessage = rewardState.reward_status === "confirmed"
    ? (refreshed.ok ? "视频奖励已领取，可进行奖励翻牌" : "视频奖励已领取，状态刷新失败")
    : rewardState.reward_status === "capped"
      ? "视频奖励已领取，但充能已达上限，跳过奖励翻牌"
      : "视频奖励已领取，但无法确认充能到账，暂不翻牌";
  return adResult({
    ok: true,
    success: true,
    status: "claimed",
    skipped: false,
    reward_ready: true,
    ...rewardState,
    newly_completed: true,
    duration_seconds: durationSeconds,
    before_done_count: task.done_count,
    after_done_count: finalDone,
    message: rewardMessage,
  }, finalTask);
}
