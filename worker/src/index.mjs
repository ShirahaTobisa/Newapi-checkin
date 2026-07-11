const API_PATH = "/api/config";
const UPSTREAM_ORIGIN = "https://dav.jianguoyun.com";
const DEFAULT_CONFIG_PATH = "/dav/newapi-config.json";
const MAX_BODY_BYTES = 256 * 1024;

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

function optionsResponse(corsOrigin) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  });
  addCommonHeaders(headers, corsOrigin);
  return new Response(null, { status: 204, headers });
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

function requireBearerToken(request, expectedToken) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);

  if (!match || !constantTimeEqual(match[1], expectedToken)) {
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

  if (!upstream.ok) {
    if (request.method === "GET" && upstream.status === 404) {
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

export async function handleRequest(request, env = {}, upstreamFetch) {
  let corsOrigin;

  try {
    const url = new URL(request.url);
    if (url.pathname !== API_PATH) {
      throw new HttpError(404, "not_found", "Endpoint not found.");
    }

    corsOrigin = corsOriginFor(request, env);

    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("Access-Control-Request-Method");
      if (requestedMethod !== null && !["GET", "PUT"].includes(requestedMethod.toUpperCase())) {
        throw new HttpError(405, "method_not_allowed", "Only GET and PUT may be preflighted.", undefined, {
          Allow: "GET, PUT, OPTIONS",
        });
      }
      return optionsResponse(corsOrigin);
    }

    if (!["GET", "PUT"].includes(request.method)) {
      throw new HttpError(405, "method_not_allowed", "Only GET, PUT, and OPTIONS are supported.", undefined, {
        Allow: "GET, PUT, OPTIONS",
      });
    }

    const syncToken = requiredSecret(env, "SYNC_TOKEN");
    requireBearerToken(request, syncToken);

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
