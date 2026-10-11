-- Budget ledger: every spend is a row, so a restart cannot reset a rolling count.
CREATE TABLE IF NOT EXISTS budget_ledger (
  id         BIGSERIAL PRIMARY KEY,
  launch_id  TEXT    NOT NULL,
  agent      TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('llm', 'post', 'reply', 'buyback-lamports', 'devbuy-lamports')),
  amount     NUMERIC NOT NULL CHECK (amount > 0),
  ts         BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_ledger_lookup ON budget_ledger (launch_id, kind, agent, ts);
