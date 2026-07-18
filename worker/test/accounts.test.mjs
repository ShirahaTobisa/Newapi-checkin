import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountConfigError,
  publicAccountConfiguration,
  runtimeAccountConfiguration,
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
  assert.deepEqual(result.site_clearances, [{
    base_url: "https://vsllm.com",
    configured: true,
  }]);
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
  assert.equal(result.value.site_clearances.length, 1);
  assert.equal(result.value.dingtalk.webhook, "https://example.test/secret");
  assert.equal(JSON.stringify(result.public).includes("secret-cookie"), false);
});

test("a padded raw session replaces an existing cookie and is stored canonically", async () => {
  const listed = await publicAccountConfiguration(EXISTING);
  const replacement = "rotated-secure-cookie-value==";
  const result = await updateAccountConfiguration(EXISTING, {
    accounts: [{
      account_key: listed.accounts[0].account_key,
      name: listed.accounts[0].name,
      base_url: listed.accounts[0].base_url,
      user_id: listed.accounts[0].user_id,
      cookie: replacement,
    }],
  });

  assert.equal(result.value.accounts[0].session, `session=${replacement};`);
  assert.equal(result.value.accounts[0].session.includes("secret-cookie"), false);
  assert.equal(JSON.stringify(result.public).includes(replacement), false);
});

test("site clearance is shared, blank updates preserve it, and clear removes it", async () => {
  const current = {
    accounts: [
      { name: "一号", url: "https://vsllm.com", user_id: "101", session: "first-session" },
      { name: "二号", url: "https://vsllm.com/path", user_id: "202", session: "second-session" },
      { name: "普通站", url: "https://other.example", user_id: "", session: "third-session" },
    ],
  };
  const listed = await publicAccountConfiguration(current);
  const accounts = listed.accounts.map((account) => ({
    account_key: account.account_key,
    name: account.name,
    base_url: account.base_url,
    user_id: account.user_id,
    cookie: "",
  }));
  const saved = await updateAccountConfiguration(current, {
    accounts,
    site_clearances: [{
      base_url: "https://vsllm.com/path",
      value: "cf_clearance=shared-clearance;",
    }],
  });
  assert.deepEqual(saved.public.site_clearances, [
    { base_url: "https://vsllm.com", configured: true },
    { base_url: "https://other.example", configured: false },
  ]);
  assert.equal(JSON.stringify(saved.public).includes("shared-clearance"), false);
  assert.equal(saved.value.site_clearances[0].base_url, "https://vsllm.com");
  assert.equal(
    runtimeAccountConfiguration(saved.value)
      .filter((account) => account.url.startsWith("https://vsllm.com"))
      .every((account) => account.cf_clearance === "shared-clearance"),
    true,
  );

  const preserved = await updateAccountConfiguration(saved.value, {
    accounts,
    site_clearances: [{ base_url: "https://vsllm.com", value: "   " }],
  });
  assert.equal(preserved.value.site_clearances.length, 1);
  assert.equal(preserved.public.site_clearances[0].configured, true);

  const cleared = await updateAccountConfiguration(preserved.value, {
    accounts,
    site_clearances: [{ base_url: "https://vsllm.com", clear: true }],
  });
  assert.deepEqual(cleared.value.site_clearances, []);
  assert.equal(cleared.public.site_clearances[0].configured, false);
  assert.equal(
    runtimeAccountConfiguration(cleared.value).some((account) => account.cf_clearance),
    false,
  );

  await assert.rejects(
    updateAccountConfiguration(saved.value, {
      accounts,
      site_clearances: [{ base_url: "https://vsllm.com", value: 123 }],
    }),
    (error) => error instanceof AccountConfigError && error.code === "invalid_site_clearance",
  );
});

test("conflicting legacy account clearances remain account-scoped", async () => {
  const current = {
    accounts: [
      {
        name: "一号",
        url: "https://vsllm.com",
        user_id: "101",
        session: "session=first; cf_clearance=legacy-first",
      },
      {
        name: "二号",
        url: "https://vsllm.com",
        user_id: "202",
        session: "second",
        cf_clearance: "legacy-second",
      },
    ],
  };
  const listed = await publicAccountConfiguration(current);
  const saved = await updateAccountConfiguration(current, {
    accounts: listed.accounts.map((account) => ({
      account_key: account.account_key,
      name: account.name,
      base_url: account.base_url,
      user_id: account.user_id,
      cookie: "",
    })),
    site_clearances: [],
  });
  assert.deepEqual(saved.value.site_clearances, []);
  assert.deepEqual(
    saved.value.accounts.map((account) => account.cf_clearance),
    ["legacy-first", "legacy-second"],
  );
  assert.equal(saved.public.site_clearances[0].configured, true);
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
