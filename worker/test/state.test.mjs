import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  migrateLegacyState,
  putState,
  readState,
  updateState,
} from "../src/state.mjs";

const migrationUrl = new URL("../migrations/0001_initial.sql", import.meta.url);
const fullHistoryMigrationUrl = new URL("../migrations/0002_full_history.sql", import.meta.url);

function compactSql(sql) {
  return sql.replace(/\s+/gu, " ").trim();
}

class MockStatement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = compactSql(sql);
    this.values = values;
  }

  bind(...values) {
    return new MockStatement(this.db, this.sql, values);
  }

  async first() {
    assert.equal(
      this.sql,
      "SELECT value_json, version FROM state_documents WHERE state_key = ?",
    );
    const row = this.db.rows.get(this.values[0]);
    return row === undefined
      ? null
      : { value_json: row.value_json, version: row.version };
  }

  async run() {
    if (this.sql.startsWith("INSERT OR IGNORE INTO state_documents")) {
      const [key, valueJson, updatedAt] = this.values;
      if (this.db.beforeInsert !== null) {
        await this.db.beforeInsert({ db: this.db, key, valueJson, updatedAt });
      }
      if (this.db.rows.has(key)) return this.db.result(0);
      this.db.rows.set(key, { value_json: valueJson, version: 1, updated_at: updatedAt });
      return this.db.result(1);
    }

    if (this.sql.startsWith("UPDATE state_documents SET value_json = ?")) {
      const [valueJson, updatedAt, key, expectedVersion] = this.values;
      if (this.db.beforeUpdate !== null) {
        await this.db.beforeUpdate({
          db: this.db,
          key,
          valueJson,
          updatedAt,
          expectedVersion,
        });
      }
      const row = this.db.rows.get(key);
      if (row === undefined || row.version !== expectedVersion) {
        return this.db.result(0);
      }
      this.db.rows.set(key, {
        value_json: valueJson,
        version: row.version + 1,
        updated_at: updatedAt,
      });
      return this.db.result(1);
    }

    throw new Error(`Unexpected SQL: ${this.sql}`);
  }
}

class MockD1 {
  constructor(initial = {}) {
    this.rows = new Map(
      Object.entries(initial).map(([key, value]) => [
        key,
        {
          value_json: JSON.stringify(value.value),
          version: value.version ?? 1,
          updated_at: value.updated_at ?? "2026-07-18T00:00:00.000Z",
        },
      ]),
    );
    this.beforeInsert = null;
    this.beforeUpdate = null;
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  result(changes) {
    return {
      success: true,
      results: [],
      meta: { changes },
    };
  }

  value(key) {
    const row = this.rows.get(key);
    return row === undefined
      ? null
      : { value: JSON.parse(row.value_json), version: row.version };
  }
}

function mockEnv({ initial = {}, legacy = {} } = {}) {
  const gets = [];
  return {
    env: {
      STATE_DB: new MockD1(initial),
      CONFIG_KV: {
        async get(key) {
          gets.push(key);
          return Object.prototype.hasOwnProperty.call(legacy, key)
            ? legacy[key]
            : null;
        },
      },
    },
    gets,
  };
}

test("initial migration creates the constrained state document table", async () => {
  const sql = compactSql(await readFile(migrationUrl, "utf8"));
  assert.match(sql, /^CREATE TABLE state_documents \(/u);
  assert.match(sql, /state_key TEXT PRIMARY KEY NOT NULL/u);
  assert.match(sql, /value_json TEXT NOT NULL CHECK \(json_valid\(value_json\)\)/u);
  assert.match(sql, /version INTEGER NOT NULL DEFAULT 1 CHECK \(version >= 1\)/u);
  assert.match(sql, /updated_at TEXT NOT NULL/u);
});

test("full history migration creates durable run/event tables and query indexes", async () => {
  const sql = compactSql(await readFile(fullHistoryMigrationUrl, "utf8"));
  assert.match(sql, /CREATE TABLE automation_runs \(/u);
  assert.match(sql, /run_id TEXT PRIMARY KEY NOT NULL/u);
  assert.match(sql, /CREATE TABLE automation_events \(/u);
  assert.match(sql, /event_id TEXT PRIMARY KEY NOT NULL/u);
  assert.match(sql, /local_date TEXT NOT NULL/u);
  assert.match(sql, /CREATE INDEX idx_automation_events_occurred/u);
  assert.match(sql, /CREATE INDEX idx_automation_events_account_date/u);
  assert.match(sql, /CREATE INDEX idx_automation_events_task_date/u);
  assert.match(sql, /CREATE INDEX idx_automation_events_run/u);
});

test("readState returns null without legacy access when requested", async () => {
  const { env, gets } = mockEnv({ legacy: { missing: '{"legacy":true}' } });
  assert.equal(await readState(env, "missing", { legacy: false }), null);
  assert.deepEqual(gets, []);
});

test("readState lazily imports legacy JSON once and D1 becomes authoritative", async () => {
  const { env, gets } = mockEnv({ legacy: { config: '{"enabled":true}' } });
  assert.deepEqual(await readState(env, "config"), {
    value: { enabled: true },
    version: 1,
  });
  assert.deepEqual(env.STATE_DB.value("config"), {
    value: { enabled: true },
    version: 1,
  });

  env.CONFIG_KV.get = async () => '{"enabled":false}';
  assert.deepEqual(await readState(env, "config"), {
    value: { enabled: true },
    version: 1,
  });
  assert.deepEqual(gets, ["config"]);
});

test("legacy import never overwrites a D1 row inserted concurrently", async () => {
  const { env } = mockEnv({ legacy: { state: '{"source":"legacy"}' } });
  env.STATE_DB.beforeInsert = ({ db, key }) => {
    db.beforeInsert = null;
    db.rows.set(key, {
      value_json: '{"source":"concurrent"}',
      version: 4,
      updated_at: "2026-07-18T01:00:00.000Z",
    });
  };

  assert.deepEqual(await readState(env, "state"), {
    value: { source: "concurrent" },
    version: 4,
  });
});

test("putState inserts and then advances the version with CAS", async () => {
  const { env } = mockEnv();
  assert.deepEqual(await putState(env, "config", { value: 1 }), {
    value: { value: 1 },
    version: 1,
  });
  assert.deepEqual(await putState(env, "config", { value: 2 }), {
    value: { value: 2 },
    version: 2,
  });
  assert.deepEqual(env.STATE_DB.value("config"), {
    value: { value: 2 },
    version: 2,
  });
});

test("updateState uses a cloned fallback and supports async mutators", async () => {
  const { env } = mockEnv();
  const fallback = { count: 0 };
  const result = await updateState(env, "counter", fallback, async (value, context) => {
    assert.equal(context.version, null);
    value.count += 1;
    return value;
  });
  assert.deepEqual(result, { value: { count: 1 }, version: 1 });
  assert.deepEqual(fallback, { count: 0 });
});

test("concurrent updates retry CAS conflicts without losing either change", async () => {
  const { env } = mockEnv({ initial: { counter: { value: { count: 0 } } } });
  await Promise.all([
    updateState(env, "counter", { count: 0 }, (value) => ({ count: value.count + 1 })),
    updateState(env, "counter", { count: 0 }, (value) => ({ count: value.count + 1 })),
  ]);
  assert.deepEqual(env.STATE_DB.value("counter"), {
    value: { count: 2 },
    version: 3,
  });
});

test("a deterministic CAS conflict reruns the mutator against the newest value", async () => {
  const { env } = mockEnv({ initial: { counter: { value: { count: 1 } } } });
  env.STATE_DB.beforeUpdate = ({ db, key }) => {
    db.beforeUpdate = null;
    const row = db.rows.get(key);
    row.value_json = '{"count":10}';
    row.version += 1;
  };

  const seen = [];
  const result = await updateState(env, "counter", { count: 0 }, (value, context) => {
    seen.push({ count: value.count, attempt: context.attempt, version: context.version });
    return { count: value.count + 1 };
  });
  assert.deepEqual(seen, [
    { count: 1, attempt: 0, version: 1 },
    { count: 10, attempt: 1, version: 2 },
  ]);
  assert.deepEqual(result, { value: { count: 11 }, version: 3 });
});

test("insert conflicts retry against the row created by another request", async () => {
  const { env } = mockEnv();
  env.STATE_DB.beforeInsert = ({ db, key }) => {
    db.beforeInsert = null;
    db.rows.set(key, {
      value_json: '{"count":4}',
      version: 1,
      updated_at: "2026-07-18T01:00:00.000Z",
    });
  };

  const result = await updateState(env, "counter", { count: 0 }, (value) => ({
    count: value.count + 1,
  }));
  assert.deepEqual(result, { value: { count: 5 }, version: 2 });
});

test("updateState fails closed after exhausting conflict retries", async () => {
  const { env } = mockEnv({ initial: { counter: { value: { count: 0 } } } });
  env.STATE_DB.beforeUpdate = ({ db, key }) => {
    const row = db.rows.get(key);
    row.value_json = JSON.stringify({ count: JSON.parse(row.value_json).count + 1 });
    row.version += 1;
  };

  await assert.rejects(
    updateState(
      env,
      "counter",
      { count: 0 },
      (value) => ({ count: value.count + 1 }),
      { maxRetries: 1 },
    ),
    (error) => error?.code === "state_conflict",
  );
  assert.deepEqual(env.STATE_DB.value("counter"), {
    value: { count: 2 },
    version: 3,
  });
});

test("migrateLegacyState reports existing, migrated, and missing keys once", async () => {
  const { env } = mockEnv({
    initial: { existing: { value: { current: true }, version: 3 } },
    legacy: { existing: '{"old":true}', legacy: '{"imported":true}' },
  });
  const result = await migrateLegacyState(env, ["existing", "legacy", "missing", "legacy"]);
  assert.deepEqual(result, {
    migrated: ["legacy"],
    existing: ["existing"],
    missing: ["missing"],
  });
  assert.deepEqual(env.STATE_DB.value("legacy"), {
    value: { imported: true },
    version: 1,
  });
});

test("invalid legacy JSON and invalid arguments are rejected without writes", async () => {
  const { env } = mockEnv({ legacy: { broken: "not-json" } });
  await assert.rejects(
    readState(env, "broken"),
    (error) => error?.code === "state_corrupt",
  );
  assert.equal(env.STATE_DB.value("broken"), null);

  await assert.rejects(
    readState(env, "", { legacy: false }),
    (error) => error?.code === "invalid_state_key",
  );
  await assert.rejects(
    putState(env, "value", undefined),
    (error) => error?.code === "invalid_state_value",
  );
  await assert.rejects(
    updateState(env, "value", {}, null),
    (error) => error?.code === "invalid_state_mutator",
  );
  await assert.rejects(
    updateState(env, "value", {}, (value) => value, { maxRetries: -1 }),
    (error) => error?.code === "invalid_state_option",
  );
  await assert.rejects(
    migrateLegacyState(env, "value"),
    (error) => error?.code === "invalid_state_keys",
  );
});

test("missing STATE_DB fails explicitly", async () => {
  await assert.rejects(
    readState({}, "state"),
    (error) => error?.code === "state_store_not_configured",
  );
});
