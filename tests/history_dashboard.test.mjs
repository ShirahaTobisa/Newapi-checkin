import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../history.css", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../history.js", import.meta.url), "utf8");

test("history dashboard assets compile and reference only the safe read endpoint", () => {
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /维云翻牌记录/u);
  assert.match(html, /账号汇总/u);
  assert.match(html, /最近翻牌记录/u);
  assert.match(script, /https:\/\/newapi-sync\.mornye\.uk\/api\/gwent\/history/u);
  assert.doesNotMatch(`${html}\n${css}\n${script}`, /sk-[A-Za-z0-9]{16,}/u);
  assert.doesNotMatch(script, /CONFIG_AUTH|SYNC_TOKEN|session|cf_clearance/u);
});

test("dashboard provides responsive, loading, empty, error, and stale states", () => {
  assert.match(css, /@media \(max-width: 720px\)/u);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/u);
  assert.match(css, /\.is-loading/u);
  assert.match(html, /id="events-empty"/u);
  assert.match(html, /id="error-banner"/u);
  assert.match(script, /status-stale/u);
});

test("dashboard uses restrained panel geometry", () => {
  assert.match(css, /--radius: 7px/u);
  assert.doesNotMatch(css, /border-radius:\s*(?:1[0-9]|[2-9][0-9])px/u);
  assert.doesNotMatch(css, /letter-spacing:\s*-/u);
});
