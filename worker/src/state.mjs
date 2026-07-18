const DEFAULT_MAX_RETRIES = 5;
const MAX_MAX_RETRIES = 20;
const MAX_STATE_KEY_LENGTH = 128;

const SELECT_STATE_SQL =
  "SELECT value_json, version FROM state_documents WHERE state_key = ?";
const INSERT_STATE_SQL = `
  INSERT OR IGNORE INTO state_documents (state_key, value_json, version, updated_at)
  VALUES (?, ?, 1, ?)
`;
const UPDATE_STATE_SQL = `
  UPDATE state_documents
  SET value_json = ?, version = version + 1, updated_at = ?
  WHERE state_key = ? AND version = ?
`;

function stateError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "StateStoreError";
  error.code = code;
  return error;
}

function database(env) {
  const db = env?.STATE_DB;
  if (!db || typeof db.prepare !== "function") {
    throw stateError("state_store_not_configured", "STATE_DB is not configured.");
  }
  return db;
}

function stateKey(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STATE_KEY_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw stateError("invalid_state_key", "State key is invalid.");
  }
  return value;
}

function serializeJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw stateError("invalid_state_value", "State value must be JSON serializable.", error);
  }
  if (serialized === undefined) {
    throw stateError("invalid_state_value", "State value must be JSON serializable.");
  }
  return serialized;
}

function parseJson(serialized, key) {
  if (typeof serialized !== "string") {
    throw stateError("state_corrupt", `Stored state ${key} is invalid.`);
  }
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw stateError("state_corrupt", `Stored state ${key} is not valid JSON.`, error);
  }
}

function cloneJson(value) {
  return JSON.parse(serializeJson(value));
}

function resultChanges(result) {
  const changes = result?.meta?.changes;
  if (!Number.isSafeInteger(changes) || changes < 0) {
    throw stateError("state_store_error", "D1 did not return a valid change count.");
  }
  return changes;
}

function storedVersion(value, key) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw stateError("state_corrupt", `Stored state ${key} has an invalid version.`);
  }
  return value;
}

async function readDatabaseState(db, key) {
  const row = await db.prepare(SELECT_STATE_SQL).bind(key).first();
  if (row === null) {
    return null;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw stateError("state_corrupt", `Stored state ${key} is invalid.`);
  }
  return {
    value: parseJson(row.value_json, key),
    version: storedVersion(row.version, key),
  };
}

async function legacyValue(env, key) {
  const legacy = env?.CONFIG_KV;
  if (!legacy || typeof legacy.get !== "function") {
    return null;
  }
  const serialized = await legacy.get(key);
  if (serialized === null) {
    return null;
  }
  return {
    serialized,
    value: parseJson(serialized, key),
  };
}

async function insertIfMissing(db, key, serialized) {
  const result = await db
    .prepare(INSERT_STATE_SQL)
    .bind(key, serialized, new Date().toISOString())
    .run();
  return resultChanges(result) === 1;
}

async function importLegacyState(env, db, key) {
  const legacy = await legacyValue(env, key);
  if (legacy === null) {
    return { state: null, status: "missing" };
  }

  if (await insertIfMissing(db, key, legacy.serialized)) {
    return { state: { value: legacy.value, version: 1 }, status: "migrated" };
  }

  const current = await readDatabaseState(db, key);
  if (current === null) {
    throw stateError("state_store_error", `State ${key} disappeared during migration.`);
  }
  return { state: current, status: "existing" };
}

export async function readState(env, key, { legacy = true } = {}) {
  const normalizedKey = stateKey(key);
  if (typeof legacy !== "boolean") {
    throw stateError("invalid_state_option", "legacy must be a boolean.");
  }

  const db = database(env);
  const current = await readDatabaseState(db, normalizedKey);
  if (current !== null || !legacy) {
    return current;
  }

  return (await importLegacyState(env, db, normalizedKey)).state;
}

export async function updateState(
  env,
  key,
  fallback,
  mutator,
  { maxRetries = DEFAULT_MAX_RETRIES } = {},
) {
  const normalizedKey = stateKey(key);
  if (typeof mutator !== "function") {
    throw stateError("invalid_state_mutator", "State mutator must be a function.");
  }
  if (
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > MAX_MAX_RETRIES
  ) {
    throw stateError(
      "invalid_state_option",
      `maxRetries must be an integer between 0 and ${MAX_MAX_RETRIES}.`,
    );
  }

  const db = database(env);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const current = await readState(env, normalizedKey);
    const input = cloneJson(current === null ? fallback : current.value);
    const nextValue = await mutator(input, {
      attempt,
      version: current === null ? null : current.version,
    });
    const serialized = serializeJson(nextValue);
    const normalizedValue = JSON.parse(serialized);

    if (current === null) {
      if (await insertIfMissing(db, normalizedKey, serialized)) {
        return { value: normalizedValue, version: 1 };
      }
    } else {
      const result = await db
        .prepare(UPDATE_STATE_SQL)
        .bind(
          serialized,
          new Date().toISOString(),
          normalizedKey,
          current.version,
        )
        .run();
      if (resultChanges(result) === 1) {
        return { value: normalizedValue, version: current.version + 1 };
      }
    }

    if (attempt === maxRetries) {
      throw stateError(
        "state_conflict",
        `State ${normalizedKey} changed too many times; update was not applied.`,
      );
    }
  }

  throw stateError("state_conflict", `State ${normalizedKey} could not be updated.`);
}

export async function putState(env, key, value) {
  return updateState(env, key, null, () => value, {
    maxRetries: DEFAULT_MAX_RETRIES,
  });
}

export async function migrateLegacyState(env, keys) {
  if (!Array.isArray(keys)) {
    throw stateError("invalid_state_keys", "Legacy state keys must be an array.");
  }
  const normalizedKeys = [...new Set(keys.map((key) => stateKey(key)))];
  const result = { migrated: [], existing: [], missing: [] };
  const db = database(env);

  for (const key of normalizedKeys) {
    const current = await readDatabaseState(db, key);
    if (current !== null) {
      result.existing.push(key);
      continue;
    }
    const imported = await importLegacyState(env, db, key);
    result[imported.status].push(key);
  }

  return result;
}
