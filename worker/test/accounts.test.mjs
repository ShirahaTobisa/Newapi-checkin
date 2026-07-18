import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountConfigError,
  publicAccountConfiguration,
  updateAccountConfiguration,
} from "../src/accounts.mjs";

const EXISTING = {
  accounts: [
    {
      name: "一号",
      url: "https://vsllm.com",
      user_id: "101",
      session: "session=secret-cookie; cf_clearance=clearance-secret",
    },
  ],
  dingtalk: { webhook: "https://example.test/secret" },
};

test("public account configuration never returns account secrets", async () => {
  const result = await publicAccountConfiguration(EXISTING);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].cookie_configured, true);
  assert.equal(result.accounts[0].valid, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret-cookie"), false);
  assert.equal(serialized.includes("clearance-secret"), false);
  assert.equal(serialized.includes("example.test/secret"), false);
});

test("blank cookie preserves an existing secret and metadata", async () => {
  const listed = await publicAccountConfiguration(EXISTING);
  const result = await updateAccountConfiguration(EXISTING, {
    accounts: [{
      account_key: listed.accounts[0].account_key,
      name: "主账号",
      base_url: "https://vsllm.com",
      user_id: "101",
      cookie: "",
    }],
  });
  assert.equal(result.value.accounts[0].name, "主账号");
  assert.equal(result.value.accounts[0].session.includes("secret-cookie"), true);
  assert.equal(result.value.dingtalk.webhook, "https://example.test/secret");
  assert.equal(JSON.stringify(result.public).includes("secret-cookie"), false);
});

test("new account requires a cookie and VSLLM user id", async () => {
  await assert.rejects(
    updateAccountConfiguration(EXISTING, {
      accounts: [{ name: "二号", base_url: "https://vsllm.com", user_id: "202" }],
    }),
    (error) => error instanceof AccountConfigError && error.code === "cookie_required",
  );
  await assert.rejects(
    updateAccountConfiguration(EXISTING, {
      accounts: [{
        name: "二号",
        base_url: "https://vsllm.com",
        user_id: "",
        cookie: "session=new-secret",
      }],
    }),
    (error) => error instanceof AccountConfigError && error.code === "user_id_required",
  );
});

test("duplicate site and user identity is rejected", async () => {
  await assert.rejects(
    updateAccountConfiguration({}, {
      accounts: [
        { name: "一号", base_url: "https://vsllm.com", user_id: "101", cookie: "a" },
        { name: "重复", base_url: "https://vsllm.com", user_id: "101", cookie: "b" },
      ],
    }),
    (error) => error instanceof AccountConfigError && error.code === "duplicate_identity",
  );
});
