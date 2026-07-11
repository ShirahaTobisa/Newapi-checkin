import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/index.mjs";

const MAX_BODY_BYTES = 256 * 1024;

const endpoint = "https://relay.example/api/config";
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
