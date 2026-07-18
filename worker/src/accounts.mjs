import { accountKey, normalizeAccounts } from "./vsllm.mjs";

export const MAX_MANAGED_ACCOUNTS = 20;

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
  return { accounts: result, max_accounts: MAX_MANAGED_ACCOUNTS };
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

function existingCookie(account) {
  try {
    return normalizeAccounts([account])[0].cookie;
  } catch {
    const value = account?.cookie ?? account?.session;
    return typeof value === "string" ? value.trim() : "";
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

export async function updateAccountConfiguration(currentValue, payload) {
  const inputs = inputAccounts(payload);
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
    const cookie = replacementCookie || (previous ? existingCookie(previous) : "");
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
    });
  }

  const value = {
    ...documentMetadata(currentValue),
    accounts: canonicalAccounts,
    updated_at: new Date().toISOString(),
  };
  return {
    value,
    public: await publicAccountConfiguration(value),
  };
}
