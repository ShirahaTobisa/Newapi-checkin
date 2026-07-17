import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const quiz = fs.readFileSync(new URL("../.github/workflows/vsllm-quiz.yml", import.meta.url), "utf8");
const ad = fs.readFileSync(new URL("../.github/workflows/vsllm-ad.yml", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("../vsllm_tasks.py", import.meta.url), "utf8");
const checkin = fs.readFileSync(new URL("../.github/workflows/checkin.yml", import.meta.url), "utf8");
const gwent = fs.readFileSync(new URL("../.github/workflows/gwent.yml", import.meta.url), "utf8");

test("quiz and ad workflows use the intended Beijing schedules", () => {
  assert.match(quiz, /cron:\s*['"]15 16 \* \* \*['"]/u);
  assert.match(ad, /cron:\s*['"]0 1,3,5,7,9,11,13,15,17,19,21,23 \* \* \*['"]/u);
  assert.match(quiz, /vsllm_tasks\.py --task quiz/u);
  assert.match(ad, /vsllm_tasks\.py --task ad/u);
});

test("all VSLLM workflows share serialization and redact credentials", () => {
  for (const workflow of [quiz, ad, checkin, gwent]) {
    assert.match(workflow, /group:\s*vsllm-tasks-\$\{\{ github\.repository \}\}/u);
  }
  for (const workflow of [quiz, ad]) {
    assert.match(workflow, /CONFIG_AUTH/u);
    assert.match(workflow, /NEWAPI_ACCOUNTS/u);
    assert.match(workflow, /text\.replace\(value, "\*\*\*"\)/u);
  }
  assert.doesNotMatch(runner, /ACCOUNTS_JSON/u);
  assert.doesNotMatch(runner, /share_unlock|gwent_draw\(/u);
  assert.match(runner, /report_charge_balance/u);
});

test("task runner keeps unknown quiz responses fail-closed", () => {
  assert.match(runner, /答题接口返回格式异常/u);
  assert.match(runner, /题目没有选项/u);
  assert.match(runner, /QUIZ_MAX_ATTEMPTS\s*=\s*20/u);
  assert.match(runner, /task_type/u);
});
