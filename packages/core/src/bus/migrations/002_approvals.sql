-- Approval cards. The event log is the public record; this table makes consume() atomic and single-use.
CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  launch_id         TEXT    NOT NULL,
  action            TEXT    NOT NULL CHECK (action IN ('launch', 'post', 'reply', 'buyback', 'action')),
  actor             TEXT    NOT NULL,
  draft             JSONB   NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'rejected', 'consumed')),
  via_autopilot     BOOLEAN NOT NULL DEFAULT FALSE,
  decided_by        TEXT,
  reason            TEXT,
  request_event_id  TEXT,
  decision_event_id TEXT,
  requested_at      BIGINT  NOT NULL,
  decided_at        BIGINT,
  consumed_at       BIGINT,
  -- Launches can never be autopiloted, enforced by the database too.
  CONSTRAINT approvals_launch_never_autopilot CHECK (NOT (action = 'launch' AND via_autopilot))
);
CREATE INDEX IF NOT EXISTS approvals_launch ON approvals (launch_id, status);

-- Autopilot switches, per launch and class. 'launch' is not a class.
CREATE TABLE IF NOT EXISTS autopilot (
  launch_id  TEXT    NOT NULL,
  class      TEXT    NOT NULL CHECK (class IN ('posts', 'replies', 'buybacks')),
  enabled    BOOLEAN NOT NULL,
  changed_by TEXT    NOT NULL,
  changed_at BIGINT  NOT NULL,
  PRIMARY KEY (launch_id, class)
);

-- Kill switch: once engaged, autopilot is off for the launch for good.
CREATE TABLE IF NOT EXISTS killswitches (
  launch_id  TEXT PRIMARY KEY,
  engaged_by TEXT   NOT NULL,
  engaged_at BIGINT NOT NULL,
  reason     TEXT
);
