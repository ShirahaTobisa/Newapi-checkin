CREATE TABLE automation_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  run_number INTEGER NOT NULL DEFAULT 0 CHECK (run_number >= 0),
  run_attempt INTEGER NOT NULL DEFAULT 1 CHECK (run_attempt >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  planned_draws INTEGER NOT NULL DEFAULT 0 CHECK (planned_draws >= 0),
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'legacy',
  account_count INTEGER NOT NULL DEFAULT 0 CHECK (account_count >= 0),
  successful_draws INTEGER NOT NULL DEFAULT 0 CHECK (successful_draws >= 0),
  total_quota INTEGER NOT NULL DEFAULT 0 CHECK (total_quota >= 0)
);

CREATE TABLE automation_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_name TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  status TEXT NOT NULL,
  prize_name TEXT,
  prize_quota INTEGER NOT NULL DEFAULT 0 CHECK (prize_quota >= 0),
  prize_rarity TEXT NOT NULL DEFAULT 'unknown',
  bonus_percent INTEGER NOT NULL DEFAULT 0 CHECK (bonus_percent >= 0),
  message TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL
);

CREATE INDEX idx_automation_events_occurred
  ON automation_events (occurred_at DESC, event_id DESC);

CREATE INDEX idx_automation_events_account_date
  ON automation_events (account_key, local_date, occurred_at DESC, event_id DESC);

CREATE INDEX idx_automation_events_task_date
  ON automation_events (task_type, local_date, occurred_at DESC, event_id DESC);

CREATE INDEX idx_automation_events_run
  ON automation_events (run_id);
