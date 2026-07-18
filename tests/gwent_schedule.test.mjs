import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../worker/src/app.mjs", import.meta.url), "utf8");
const settings = fs.readFileSync(new URL("../worker/src/settings.mjs", import.meta.url), "utf8");
const wrangler = fs.readFileSync(
  new URL("../worker/wrangler.jsonc.example", import.meta.url),
  "utf8",
);

test("Cloudflare Worker owns the two-hour draw schedule and persistent idempotency", () => {
  assert.match(settings, /every_minutes:\s*120/u);
  assert.match(settings, /anchor_local:\s*"00:20"/u);
  assert.match(wrangler, /"crons":\s*\["\* \* \* \* \*"\]/u);
  assert.match(app, /phase:\s*"request_sent"/u);
  assert.match(app, /phase:\s*"terminal"/u);
  assert.match(app, /draw-intent:/u);
  assert.match(app, /automation-slot:/u);
  assert.match(app, /Idempotency-Key/u);
});

test("the legacy Gwent production workflow is removed", () => {
  assert.equal(
    fs.existsSync(new URL("../.github/workflows/gwent.yml", import.meta.url)),
    false,
  );
  assert.equal(
    fs.existsSync(new URL("../.github/workflows/validate.yml", import.meta.url)),
    true,
  );
});
