import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../.github/workflows/gwent.yml", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../checkin.py", import.meta.url), "utf8");

test("Gwent workflow uses stable UTC two-hour slots and one draw per account", () => {
  assert.match(workflow, /cron:\s*['"]0 \*\/2 \* \* \*['"]/u);
  assert.match(workflow, /schedule_guard:/u);
  assert.match(workflow, /api\/gwent\/schedule/u);
  assert.match(workflow, /\{action:"claim"/u);
  assert.match(workflow, /\{action:"complete"/u);
  assert.match(workflow, /Authorization: Bearer/u);
  assert.match(workflow, /secrets\.ACTIONS_TOKEN\s*\|\|\s*secrets\.CONFIG_AUTH/u);
  assert.match(workflow, /lease_token/u);
  assert.match(workflow, /lease_token="manual:\$\{GITHUB_RUN_ID\}:\$\{GITHUB_RUN_ATTEMPT\}"/u);
  assert.match(workflow, /scheduled:%sT%02d/u);
  assert.match(workflow, /slot_hour=\$\(\(10#\$utc_hour \/ 2 \* 2\)\)/u);
  assert.match(workflow, /MIN_INTERVAL_SECONDS:\s*['"]0['"]/u);
  assert.match(workflow, /--argjson force "\$force"/u);
  assert.match(workflow, /reused == true/u);
  assert.match(workflow, /jq -e?r/u);
  assert.match(workflow, /GWENT_SCHEDULE_GUARD:\s*['"]true['"]/u);
  assert.match(workflow, /GWENT_MIN_INTERVAL_SECONDS:\s*['"]0['"]/u);
  assert.match(workflow, /GWENT_FORCE:/u);
  assert.match(workflow, /GWENT_DRAW_COUNT:\s*['"]1['"]/u);
  assert.match(workflow, /每 2 小时整点翻 1 次/u);
  assert.match(workflow, /Worker 槽位防重/u);
  assert.match(workflow, /group:\s*vsllm-tasks-\$\{\{ github\.repository \}\}/u);
  assert.match(workflow, /if:\s*always\(\)/u);
  assert.match(workflow, /continue-on-error:\s*true/u);
  assert.match(workflow, /SCHEDULE_LEASE_TOKEN:\s*\$\{\{\s*needs\.schedule_guard\.outputs\.lease_token\s*\}\}/u);
  assert.match(workflow, /due=false/u);
});

test("Gwent runner keeps a two-hour fallback without letting reward draws delay regular draws", () => {
  assert.match(script, /GWENT_MIN_INTERVAL_SECONDS\s*=\s*2\s*\*\s*60\s*\*\s*60/u);
  assert.match(script, /load_gwent_last_success/u);
  assert.match(script, /\(event\.get\(['"]task_type['"]\) or ['"]gwent['"]\) != ['"]gwent['"]/u);
  assert.match(script, /本轮所有账号额度/u);
});
