import { accountKey, normalizeAccounts } from "./vsllm.mjs";

export const MAX_MANAGED_ACCOUNTS = 20;
const MAX_CLEARANCE_LENGTH = 4 * 1024;

export class AccountConfigError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AccountConfigError";
    this.code = code;
    this.details = details;
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function rawAccounts(value) {
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  if (!object) return [];
  if (Array.isArray(object.accounts)) return object.accounts;
  if (
    Object.prototype.hasOwnProperty.call(object, "session") ||
    Object.prototype.hasOwnProperty.call(object, "cookie")
  ) {
    return [object];
  }
  return [];
}

function documentMetadata(value) {
  const object = objectValue(value);
  if (!object || !Array.isArray(object.accounts)) return {};
  const metadata = { ...object };
  delete metadata.accounts;
  return metadata;
}

function compact(value, fallback, maximum) {
  const text = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.slice(0, maximum) || fallback;
}

function publicBaseUrl(value) {
  return String(value?.baseUrl ?? value?.url ?? "https://vsllm.com").trim();
}

function publicUserId(value) {
  return String(value?.userId ?? value?.user_id ?? "").trim().slice(0, 128);
}

function configuredCookie(value) {
  return typeof (value?.cookie ?? value?.session) === "string" &&
    String(value.cookie ?? value.session).trim().length > 0;
}

function siteOrigin(value) {
  const candidate = String(value || "https://vsllm.com").trim();
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError("站点地址无效");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("站点地址必须是不含认证信息、查询参数或片段的 HTTPS 地址");
  }
  return url.origin;
}

function accountSiteOrigin(account) {
  try {
    return siteOrigin(normalizeAccounts([account])[0].baseUrl);
  } catch {
    try {
      return siteOrigin(publicBaseUrl(account));
    } catch {
      return null;
    }
  }
}

function normalizedClearance(value) {
  if (typeof value !== "string") return "";
  let clearance = value.trim();
  if (/^cf_clearance\s*=/iu.test(clearance)) {
    clearance = clearance.replace(/^cf_clearance\s*=\s*/iu, "");
  }
  clearance = clearance.replace(/;\s*$/u, "").trim();
  if (
    clearance.length === 0 ||
    clearance.length > MAX_CLEARANCE_LENGTH ||
    /[;\r\n\u0000]/u.test(clearance)
  ) {
    return "";
  }
  return clearance;
}

function storedSiteClearances(value) {
  const object = objectValue(value);
  if (!object || !Array.isArray(object.accounts)) return new Map();
  const raw = object.site_clearances ?? object.siteClearances;
  const entries = Array.isArray(raw)
    ? raw.map((entry) => [entry?.base_url ?? entry?.baseUrl ?? entry?.url, entry])
    : objectValue(raw)
      ? Object.entries(raw)
      : [];
  const clearances = new Map();
  for (const [baseUrl, entry] of entries) {
    try {
      const origin = siteOrigin(baseUrl);
      const rawValue = typeof entry === "string"
        ? entry
        : entry?.cf_clearance ?? entry?.cfClearance ?? entry?.value;
      const clearance = normalizedClearance(rawValue);
      if (clearance) clearances.set(origin, clearance);
    } catch {
      // Ignore malformed legacy entries; new writes are validated strictly.
    }
  }
  return clearances;
}

function accountClearance(account) {
  try {
    return normalizeAccounts([account])[0].cfClearance || "";
  } catch {
    return normalizedClearance(account?.cf_clearance ?? account?.cfClearance);
  }
}

export function runtimeAccountConfiguration(value) {
  const shared = storedSiteClearances(value);
  return rawAccounts(value).map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account)) return account;
    const clearance = shared.get(accountSiteOrigin(account));
    return clearance ? { ...account, cf_clearance: clearance } : account;
  });
}

function publicSiteClearances(value, accounts) {
  const shared = storedSiteClearances(value);
  const sites = new Map();
  for (const account of accounts) {
    const origin = accountSiteOrigin(account);
    if (!origin) continue;
    const configured = shared.has(origin) || Boolean(accountClearance(account));
    sites.set(origin, Boolean(sites.get(origin)) || configured);
  }
  return [...sites].map(([baseUrl, configured]) => ({
    base_url: baseUrl,
    configured,
  }));
}

async function fallbackEditorKey(account, index) {
  const source = JSON.stringify([
    index,
    publicBaseUrl(account),
    publicUserId(account),
    compact(account?.name, `账号${index + 1}`, 64),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return `invalid-${[...new Uint8Array(digest)]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function editorKey(account, index) {
  try {
    return await accountKey(account, index + 1);
  } catch {
    return fallbackEditorKey(account, index);
  }
}

function validationMessage(error) {
  return compact(error instanceof Error ? error.message : "账号配置无效", "账号配置无效", 180);
}

export async function publicAccountConfiguration(value) {
  const accounts = rawAccounts(value);
  const result = await Promise.all(accounts.map(async (account, index) => {
    let normalized = null;
    let validationError = null;
    try {
      normalized = normalizeAccounts([account])[0];
      if (normalized.isVsllm && !normalized.userId) {
        validationError = "VSLLM 账号缺少用户 ID";
      }
    } catch (error) {
      validationError = validationMessage(error);
    }
    return {
      account_key: await editorKey(account, index),
      name: normalized?.name || compact(account?.name, `账号${index + 1}`, 64),
      base_url: normalized?.baseUrl || publicBaseUrl(account),
      user_id: normalized?.userId || publicUserId(account),
      cookie_configured: configuredCookie(account),
      valid: validationError === null,
      validation_error: validationError,
    };
  }));
  return {
    accounts: result,
    site_clearances: publicSiteClearances(value, accounts),
    max_accounts: MAX_MANAGED_ACCOUNTS,
  };
}

function inputAccounts(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AccountConfigError("invalid_accounts", "账号配置请求必须是对象。");
  }
  if (!Array.isArray(payload.accounts)) {
    throw new AccountConfigError("invalid_accounts", "accounts 必须是数组。");
  }
  if (payload.accounts.length > MAX_MANAGED_ACCOUNTS) {
    throw new AccountConfigError(
      "too_many_accounts",
      `最多可配置 ${MAX_MANAGED_ACCOUNTS} 个账号。`,
    );
  }
  return payload.accounts;
}

function existingCredentials(account) {
  try {
    const normalized = normalizeAccounts([account])[0];
    return { cookie: normalized.cookie, clearance: normalized.cfClearance || "" };
  } catch {
    const value = account?.cookie ?? account?.session;
    return {
      cookie: typeof value === "string" ? value.trim() : "",
      clearance: normalizedClearance(account?.cf_clearance ?? account?.cfClearance),
    };
  }
}

function optionalKey(value, index) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AccountConfigError(
      "invalid_account_key",
      `第 ${index + 1} 个账号的标识无效。`,
    );
  }
  return value;
}

function inputCookie(value, index) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 16 * 1024 || /[\r\n\u0000]/u.test(value)) {
    throw new AccountConfigError("invalid_cookie", `第 ${index + 1} 个账号的 Cookie 无效。`);
  }
  return value.trim();
}

function inputSiteClearances(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload, "site_clearances")) return new Map();
  if (!Array.isArray(payload.site_clearances)) {
    throw new AccountConfigError("invalid_site_clearances", "site_clearances 必须是数组。");
  }
  if (payload.site_clearances.length > MAX_MANAGED_ACCOUNTS) {
    throw new AccountConfigError(
      "too_many_site_clearances",
      `最多可配置 ${MAX_MANAGED_ACCOUNTS} 个站点的 cf_clearance。`,
    );
  }
  const updates = new Map();
  for (let index = 0; index < payload.site_clearances.length; index += 1) {
    const input = payload.site_clearances[index];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AccountConfigError(
        "invalid_site_clearance",
        `第 ${index + 1} 个站点的 cf_clearance 配置无效。`,
      );
    }
    let origin;
    try {
      const baseUrl = input.base_url ?? input.baseUrl ?? input.url;
      if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
        throw new TypeError("站点地址不能为空");
      }
      origin = siteOrigin(baseUrl);
    } catch (error) {
      throw new AccountConfigError(
        "invalid_site_url",
        `第 ${index + 1} 个站点无效：${validationMessage(error)}`,
      );
    }
    if (updates.has(origin)) {
      throw new AccountConfigError(
        "duplicate_site_clearance",
        `第 ${index + 1} 个站点重复提交。`,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "clear") &&
      typeof input.clear !== "boolean"
    ) {
      throw new AccountConfigError(
        "invalid_site_clearance",
        `第 ${index + 1} 个站点的 clear 必须是布尔值。`,
      );
    }
    const clear = input.clear === true;
    const hasValue = Object.prototype.hasOwnProperty.call(input, "value");
    const rawValue = hasValue ? input.value : undefined;
    if (hasValue && typeof rawValue !== "string") {
      throw new AccountConfigError(
        "invalid_site_clearance",
        `第 ${index + 1} 个站点的 cf_clearance 必须是字符串。`,
      );
    }
    if (clear && rawValue?.trim()) {
      throw new AccountConfigError(
        "ambiguous_site_clearance",
        `第 ${index + 1} 个站点不能同时更新并清除 cf_clearance。`,
      );
    }
    let clearance = "";
    if (!clear && hasValue && rawValue.trim()) {
      clearance = normalizedClearance(rawValue);
      if (!clearance) {
        throw new AccountConfigError(
          "invalid_site_clearance",
          `第 ${index + 1} 个站点的 cf_clearance 无效。`,
        );
      }
    }
    updates.set(origin, { clear, clearance });
  }
  return updates;
}

export async function updateAccountConfiguration(currentValue, payload) {
  const inputs = inputAccounts(payload);
  const siteUpdates = inputSiteClearances(payload);
  const currentAccounts = rawAccounts(currentValue);
  const currentByKey = new Map();
  for (let index = 0; index < currentAccounts.length; index += 1) {
    currentByKey.set(await editorKey(currentAccounts[index], index), currentAccounts[index]);
  }

  const usedInputKeys = new Set();
  const canonicalAccounts = [];
  const canonicalKeys = new Set();
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AccountConfigError("invalid_account", `第 ${index + 1} 个账号格式无效。`);
    }
    const key = optionalKey(input.account_key, index);
    if (key && usedInputKeys.has(key)) {
      throw new AccountConfigError("duplicate_account", `第 ${index + 1} 个账号重复提交。`);
    }
    if (key) usedInputKeys.add(key);

    const previous = key ? currentByKey.get(key) : null;
    const replacementCookie = inputCookie(input.cookie, index);
    const previousCredentials = previous
      ? existingCredentials(previous)
      : { cookie: "", clearance: "" };
    const cookie = replacementCookie || previousCredentials.cookie;
    if (!cookie) {
      throw new AccountConfigError(
        "cookie_required",
        `第 ${index + 1} 个新账号必须填写 Cookie。`,
      );
    }

    const candidate = {
      name: compact(input.name, `账号${index + 1}`, 64),
      url: String(input.base_url ?? input.url ?? "https://vsllm.com").trim(),
      user_id: String(input.user_id ?? input.userId ?? "").trim(),
      session: cookie,
    };
    let normalized;
    try {
      normalized = normalizeAccounts([candidate])[0];
      const origin = siteOrigin(normalized.baseUrl);
      if (
        !normalized.cfClearance &&
        previousCredentials.clearance &&
        siteUpdates.get(origin)?.clear !== true
      ) {
        candidate.cf_clearance = previousCredentials.clearance;
        normalized = normalizeAccounts([candidate])[0];
      }
    } catch (error) {
      throw new AccountConfigError(
        "invalid_account",
        `第 ${index + 1} 个账号无效：${validationMessage(error)}`,
      );
    }
    if (normalized.isVsllm && !normalized.userId) {
      throw new AccountConfigError(
        "user_id_required",
        `第 ${index + 1} 个 VSLLM 账号必须填写用户 ID。`,
      );
    }
    const normalizedKey = await accountKey(candidate, index + 1);
    if (canonicalKeys.has(normalizedKey)) {
      throw new AccountConfigError(
        "duplicate_identity",
        `第 ${index + 1} 个账号与另一个账号的站点和用户 ID 重复。`,
      );
    }
    canonicalKeys.add(normalizedKey);
    canonicalAccounts.push({
      name: normalized.name,
      url: normalized.baseUrl,
      user_id: normalized.userId,
      session: normalized.cookie,
      ...(normalized.cfClearance ? { cf_clearance: normalized.cfClearance } : {}),
    });
  }

  const siteOrigins = [...new Set(canonicalAccounts.map((account) => siteOrigin(account.url)))];
  const knownSites = new Set(siteOrigins);
  for (const origin of siteUpdates.keys()) {
    if (!knownSites.has(origin)) {
      throw new AccountConfigError(
        "unknown_site_clearance",
        `站点 ${origin} 没有对应的账号。`,
      );
    }
  }

  const shared = new Map(
    [...storedSiteClearances(currentValue)].filter(([origin]) => knownSites.has(origin)),
  );
  const explicitlyCleared = new Set();
  for (const [origin, update] of siteUpdates) {
    if (update.clear) {
      shared.delete(origin);
      explicitlyCleared.add(origin);
    } else if (update.clearance) {
      shared.set(origin, update.clearance);
    }
  }

  for (const origin of siteOrigins) {
    if (shared.has(origin) || explicitlyCleared.has(origin)) continue;
    const legacyValues = new Set(
      canonicalAccounts
        .filter((account) => siteOrigin(account.url) === origin)
        .map((account) => normalizedClearance(account.cf_clearance))
        .filter(Boolean),
    );
    if (legacyValues.size === 1) shared.set(origin, [...legacyValues][0]);
  }

  const storedAccounts = canonicalAccounts.map((account) => {
    const origin = siteOrigin(account.url);
    if (!shared.has(origin) && !explicitlyCleared.has(origin)) return account;
    const stored = { ...account };
    delete stored.cf_clearance;
    return stored;
  });

  const metadata = documentMetadata(currentValue);
  delete metadata.site_clearances;
  delete metadata.siteClearances;

  const value = {
    ...metadata,
    accounts: storedAccounts,
    site_clearances: siteOrigins
      .filter((origin) => shared.has(origin))
      .map((origin) => ({ base_url: origin, cf_clearance: shared.get(origin) })),
    updated_at: new Date().toISOString(),
  };
  return {
    value,
    public: await publicAccountConfiguration(value),
  };
}
