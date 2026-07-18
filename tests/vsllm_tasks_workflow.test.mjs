import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../worker/src/app.mjs", import.meta.url), "utf8");
const vsllm = fs.readFileSync(new URL("../worker/src/vsllm.mjs", import.meta.url), "utf8");

test("quiz and video rewards are queued and reconciled by the Worker", () => {
  assert.match(app, /reward-queue:/u);
  assert.match(app, /quiz:\$\{date\}:\$\{key\}/u);
  assert.match(app, /ad:\$\{date\}:\$\{key\}:\$\{ordinal\}/u);
  assert.match(app, /runQuiz\(account,\s*\{\s*maxQuizAttempts:\s*4\s*\}\)/u);
  assert.match(app, /settings\.quiz\.draw_after_success/u);
  assert.match(app, /settings\.ad\.draw_after_claim/u);
  assert.match(vsllm, /\/api\/gwent\/ad\/claim/u);
  assert.match(vsllm, /\/api\/gwent\/task3\/answer/u);
});

test("legacy production task workflows are removed after the Cloudflare migration", () => {
  for (const name of [
    "checkin.yml",
    "gwent.yml",
    "vsllm-quiz.yml",
    "vsllm-ad.yml",
    "keepalive.yml",
  ]) {
    assert.equal(
      fs.existsSync(new URL(`../.github/workflows/${name}`, import.meta.url)),
      false,
    );
  }
});
