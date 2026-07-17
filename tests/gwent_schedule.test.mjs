import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../.github/workflows/gwent.yml", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../checkin.py", import.meta.url), "utf8");

test("Gwent workflow uses fixed 6-hour-5-minute windows and interval protection", () => {
  assert.match(workflow, /cron:\s*['"]5 5,11,17,23 \* \* \*['"]/u);
  assert.match(workflow, /schedule_guard:/u);
  assert.match(workflow, /api\/gwent\/schedule/u);
  assert.match(workflow, /\{action:"claim"/u);
  assert.match(workflow, /\{action:"complete"/u);
  assert.match(workflow, /Authorization: Bearer/u);
  assert.match(workflow, /secrets\.ACTIONS_TOKEN\s*\|\|\s*secrets\.CONFIG_AUTH/u);
  assert.match(workflow, /lease_token/u);
  assert.match(workflow, /lease_token="\$\{GITHUB_RUN_ID\}:\$\{GITHUB_RUN_ATTEMPT\}"/u);
  assert.match(workflow, /force:/u);
  assert.match(workflow, /reused == true/u);
  assert.match(workflow, /jq -e?r/u);
  assert.match(workflow, /GWENT_SCHEDULE_GUARD:\s*['"]true['"]/u);
  assert.match(workflow, /GWENT_MIN_INTERVAL_SECONDS:\s*['"]21900['"]/u);
  assert.match(workflow, /GWENT_FORCE:/u);
  assert.match(workflow, /group:\s*vsllm-tasks-\$\{\{ github\.repository \}\}/u);
  assert.match(workflow, /if:\s*always\(\)/u);
  assert.match(workflow, /continue-on-error:\s*true/u);
  assert.match(workflow, /SCHEDULE_LEASE_TOKEN:\s*\$\{\{\s*needs\.schedule_guard\.outputs\.lease_token\s*\}\}/u);
  assert.match(workflow, /due=false/u);
});

test("Gwent runner protects the real cooldown interval and reports quota", () => {
  assert.match(script, /GWENT_MIN_INTERVAL_SECONDS\s*=\s*6\s*\*\s*60\s*\*\s*60\s*\+\s*5\s*\*\s*60/u);
  assert.match(script, /load_gwent_last_success/u);
  assert.match(script, /本轮所有账号额度/u);
});
