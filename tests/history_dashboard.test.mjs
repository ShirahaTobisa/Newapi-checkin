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
  assert.match(html, /每 2 小时整点翻 1 次/u);
  assert.match(html, /Worker 槽位防重/u);
  assert.match(html, /最近常规翻牌/u);
  assert.doesNotMatch(script, /MIN_DRAW_INTERVAL_MS|finishedAt/u);
  assert.match(script, /> 3 \* 60 \* 60 \* 1000/u);
  assert.match(script, /status-stale/u);
});

test("dashboard calculates the next regular run from UTC even-hour slots", () => {
  const start = script.indexOf("  function nextCronWindow");
  const end = script.indexOf("\n\n  function nextScheduledRun", start);
  assert.ok(start >= 0 && end > start);
  const nextCronWindow = new Function(`${script.slice(start, end)}\nreturn nextCronWindow;`)();

  assert.equal(
    nextCronWindow(new Date("2026-07-18T00:03:00.000Z")).toISOString(),
    "2026-07-18T02:00:00.000Z",
  );
  assert.equal(
    nextCronWindow(new Date("2026-07-18T23:59:59.000Z")).toISOString(),
    "2026-07-19T00:00:00.000Z",
  );
});

test("recent draw records identify regular, quiz, and video sources", () => {
  assert.match(html, /<th scope="col">来源<\/th>/u);
  assert.match(script, /gwent:\s*"常规"/u);
  assert.match(script, /quiz:\s*"答题"/u);
  assert.match(script, /ad:\s*"视频"/u);
  assert.match(script, /taskTypeLabel\(event\.task_type\)/u);
});

test("dashboard uses restrained panel geometry", () => {
  assert.match(css, /--radius: 7px/u);
  assert.doesNotMatch(css, /border-radius:\s*(?:1[0-9]|[2-9][0-9])px/u);
  assert.doesNotMatch(css, /letter-spacing:\s*-/u);
});
