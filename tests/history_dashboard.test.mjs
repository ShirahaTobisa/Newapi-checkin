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

test("dashboard renders daily quiz and video status without carrying yesterday forward", () => {
  assert.match(html, /id="task-status-title">今日账号任务状态/u);
  assert.match(html, /id="task-status-body"/u);
  assert.match(html, /视频进度/u);
  assert.match(html, /下次可看/u);
  assert.match(script, /renderTaskStatuses\(data\.task_statuses\)/u);
  assert.match(script, /timeZone:\s*"Asia\/Shanghai"/u);
  assert.match(script, /formatToParts/u);
  assert.match(script, /payload\.local_date === today/u);
  assert.match(script, /待今日检查/u);
  assert.match(script, /completed:\s*\{ style: "success", label: "已完成", icon: "circle-check" \}/u);
  assert.match(script, /cooldown:\s*\{ style: "cooldown", label: "冷却中", icon: "clock-3" \}/u);
  assert.match(script, /icon:\s*"circle-check"/u);
  assert.match(script, /icon\.dataset\.lucide = meta\.icon/u);
  assert.match(script, /taskTimeElement/u);
  assert.match(script, /setAttribute\("aria-label"/u);
  assert.match(script, /Number\.isFinite\(Number\(adStatus\.done_count\)\)/u);
  assert.doesNotMatch(css, /task-status-table thead\s*\{\s*display:\s*none/u);
});

test("task updates use relative time with exact timestamp metadata", () => {
  const start = script.indexOf("  function formatRelativeTime");
  const end = script.indexOf("\n\n  function taskUpdatedElement", start);
  assert.ok(start >= 0 && end > start);
  const formatRelativeTime = new Function(
    `${script.slice(start, end)}\nreturn formatRelativeTime;`,
  )();
  const now = Date.parse("2026-07-18T06:00:00Z");
  assert.equal(formatRelativeTime("2026-07-18T05:57:00Z", now), "3 分钟前");
  assert.equal(formatRelativeTime("2026-07-18T04:00:00Z", now), "2 小时前");
  assert.match(script, /element\.title = fullDateTimeFormat\.format/u);
});

test("expired video cooldown is presented as available", () => {
  const start = script.indexOf("  function effectiveAdStatus");
  const end = script.indexOf("\n\n  function renderIcons", start);
  assert.ok(start >= 0 && end > start);
  const effectiveAdStatus = new Function(
    `${script.slice(start, end)}\nreturn effectiveAdStatus;`,
  )();

  const expired = effectiveAdStatus({
    status: "cooldown",
    completed: false,
    next_available_at: "2026-07-18T02:00:00Z",
  }, true, Date.parse("2026-07-18T03:00:00Z"));
  assert.equal(expired.status, "available");
  assert.equal(expired.next_available_at, null);

  const active = effectiveAdStatus({
    status: "cooldown",
    completed: false,
    next_available_at: "2026-07-18T04:00:00Z",
  }, true, Date.parse("2026-07-18T03:00:00Z"));
  assert.equal(active.status, "cooldown");
});

test("manual draw control delegates confirmation to GitHub Actions without browser secrets", () => {
  assert.match(html, /id="manual-draw-title">手动翻牌/u);
  assert.match(
    html,
    /href="https:\/\/github\.com\/ShirahaTobisa\/Newapi-checkin\/actions\/workflows\/gwent\.yml"/u,
  );
  assert.match(html, /target="_blank" rel="noopener noreferrer"/u);
  assert.match(html, /Run workflow/u);
  assert.match(html, /每账号 1 次/u);
  assert.match(html, /先激活 50% 加成/u);
  assert.match(html, /前往 GitHub 手动运行/u);
  assert.match(html, /不会改变下一次整点任务/u);
  assert.match(html, /不会读取或保存 Cookie、Token/u);
  assert.match(css, /\.action-button\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*task-status-table tr \{ grid-template-columns: 1fr; \}/u);
  assert.doesNotMatch(html + script, /ACTIONS_TOKEN|localStorage|sessionStorage/u);
});

test("dashboard uses restrained panel geometry", () => {
  assert.match(css, /--radius: 7px/u);
  assert.doesNotMatch(css, /border-radius:\s*(?:1[0-9]|[2-9][0-9])px/u);
  assert.doesNotMatch(css, /letter-spacing:\s*-/u);
});
