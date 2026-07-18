import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicUrl = new URL("../public/", import.meta.url);

async function asset(name) {
  return readFile(new URL(name, publicUrl), "utf8");
}

test("dashboard keeps the light Grok ledger visual baseline", async () => {
  const [html, css] = await Promise.all([asset("index.html"), asset("styles.css")]);

  assert.match(html, /<title>维云翻牌记录<\/title>/u);
  assert.match(html, /name="theme-color" content="#f4f5f7"/u);
  assert.doesNotMatch(html, /自动任务控制台/u);
  assert.match(css, /--bg:\s*#f4f5f7/u);
  assert.match(css, /--radius:\s*7px/u);
  assert.doesNotMatch(css, /(?:radial|linear)-gradient\s*\(/u);
  assert.doesNotMatch(css, /#0b1117|#2fc7b5/iu);
});

test("dashboard retains the Worker data and admin DOM contracts", async () => {
  const html = await asset("index.html");
  const requiredIds = [
    "storage-status",
    "refresh-button",
    "manual-button",
    "admin-button",
    "panel-overview",
    "panel-accounts",
    "panel-records",
    "panel-settings",
    "today-task-list",
    "schedule-list",
    "overview-run-list",
    "overview-event-list",
    "trend-chart",
    "account-table-body",
    "refresh-balances-button",
    "balances-updated",
    "balances-total",
    "balance-grid",
    "event-table-body",
    "events-pagination",
    "settings-form",
    "login-dialog",
    "manual-dialog",
  ];
  for (const id of requiredIds) {
    assert.equal(html.match(new RegExp(`id="${id}"`, "gu"))?.length, 1, `${id} must occur once`);
  }

  for (const name of [
    "automation_enabled",
    "draw_every_minutes",
    "draw_count",
    "quiz_reward_draw",
    "ad_reward_draw",
    "share_bonus",
    "notifications_webhook",
    "account_scope",
  ]) {
    assert.match(html, new RegExp(`name="${name}"`, "u"));
  }
});

test("manual task state survives refreshes and hidden draw count cannot block other actions", async () => {
  const script = await asset("app.js");

  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /if \(!\$\("#manual-dialog"\)\.open\) populateManualAccounts\(\);/u);
  assert.match(script, /drawCountInput\.disabled = action !== "draw";/u);
});

test("balance refresh keeps zero, unknown, failed, and unsupported draw chances distinct", async () => {
  const [html, script] = await Promise.all([asset("index.html"), asset("app.js")]);

  assert.match(html, /账号实时状态/u);
  assert.match(html, /当前余额与剩余翻牌次数/u);
  assert.match(script, /function optionalInteger\(value\)/u);
  assert.match(script, /if \(available === null\)/u);
  assert.match(script, /`\$\{available\} 次`/u);
  assert.match(script, /尚未读取剩余次数/u);
  assert.match(script, /gwent\.supported === false/u);
  assert.match(script, /读取失败/u);
  assert.match(script, /普通签到站点/u);
});

test("account configuration uses the same light visual system", async () => {
  const [html, css] = await Promise.all([
    asset("config_generator.html"),
    asset("config.css"),
  ]);

  assert.match(html, /name="color-scheme" content="light"/u);
  assert.match(html, /<title>账号配置 · 维云翻牌记录<\/title>/u);
  assert.doesNotMatch(html, /page-glow/u);
  assert.match(css, /--bg:\s*#f4f5f7/u);
  assert.doesNotMatch(css, /(?:radial|linear)-gradient\s*\(/u);
  assert.doesNotMatch(css, /#071019|#43d6b3/iu);
});
