-- Append-only event log. Every live visual maps to one row here.
CREATE TABLE IF NOT EXISTS events (
  seq        BIGSERIAL PRIMARY KEY,
  id         TEXT        NOT NULL UNIQUE CHECK (id ~ '^[0-9a-f]{64}$'),
  launch_id  TEXT        NOT NULL,
  ts         BIGINT      NOT NULL,
  kind       TEXT        NOT NULL,
  actor      TEXT        NOT NULL,
  payload    JSONB       NOT NULL,
  signer     TEXT        NOT NULL,
  sig        TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS events_launch_seq ON events (launch_id, seq);
CREATE INDEX IF NOT EXISTS events_launch_kind_seq ON events (launch_id, kind, seq);

-- Append-only: refuse UPDATE, DELETE and TRUNCATE.
CREATE OR REPLACE FUNCTION carbon_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_no_update_delete ON events;
CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION carbon_events_append_only();

DROP TRIGGER IF EXISTS events_no_truncate ON events;
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION carbon_events_append_only();
