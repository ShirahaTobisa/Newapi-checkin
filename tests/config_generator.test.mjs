import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../config_generator.html", import.meta.url), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);

  const bodyStart = html.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = bodyStart; index < html.length; index += 1) {
    const char = html[index];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }

  throw new Error(`Could not extract ${name}`);
}

function buildUrl({ preset, url, filename = "newapi-config.json", username = "" }) {
  const elements = {
    "cloud-url": { value: url },
    "cloud-filename": { value: filename },
    "cloud-username": { value: username },
  };
  const statuses = [];
  const document = {
    getElementById(id) {
      return elements[id];
    },
    querySelector(selector) {
      assert.equal(selector, ".cloud-preset-btn.active");
      return { id: `preset-${preset}` };
    },
  };
  const showCloudStatus = (type, message) => statuses.push({ type, message });
  const factory = new Function(
    "document",
    "showCloudStatus",
    `${extractFunction("buildCloudUrl")}; return buildCloudUrl;`,
  );

  return { result: factory(document, showCloudStatus)(), statuses };
}

test("inline JavaScript compiles and public credential-forwarding proxies are absent", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const source of scripts) new Function(source);

  for (const banned of [
    "api.allorigins.win",
    "api.codetabs.com",
    "corsproxy.io",
    "thingproxy.freeboard.io",
    "cors-anywhere.herokuapp.com",
    "updateCorsProxyPreview",
  ]) {
    assert.equal(html.includes(banned), false, `${banned} must not remain in the page`);
  }
});

test("Jianguoyun preset normalizes the private Worker endpoint", () => {
  assert.equal(
    buildUrl({ preset: "jianguoyun", url: "https://relay.example.workers.dev" }).result,
    "https://relay.example.workers.dev/api/config",
  );
  assert.equal(
    buildUrl({ preset: "jianguoyun", url: "https://relay.example.workers.dev/api/config" }).result,
    "https://relay.example.workers.dev/api/config",
  );
});

test("Jianguoyun preset rejects non-HTTPS relay URLs", () => {
  const { result, statuses } = buildUrl({
    preset: "jianguoyun",
    url: "http://relay.example.test",
  });
  assert.equal(result, null);
  assert.deepEqual(statuses, [{ type: "error", message: "Worker 同步地址必须使用 HTTPS" }]);
});

test("direct WebDAV presets append and encode the configured filename", () => {
  assert.equal(
    buildUrl({
      preset: "custom",
      url: "https://dav.example.test/configs",
      filename: "daily config.json",
    }).result,
    "https://dav.example.test/configs/daily%20config.json",
  );

  assert.equal(
    buildUrl({
      preset: "nextcloud",
      url: "https://cloud.example.test/remote.php/dav/",
      filename: "newapi-config.json",
      username: "user@example.com",
    }).result,
    "https://cloud.example.test/remote.php/dav/files/user%40example.com/newapi-config.json",
  );
});
