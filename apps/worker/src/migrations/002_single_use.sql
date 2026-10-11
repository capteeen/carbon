-- Single-use guards (audit findings AG-003, AG-016, AG-024).

-- AG-003: a consumed post/reply approval authorises exactly ONE network post, with the
-- approved text. The X seam inserts here (PRIMARY KEY = one use) before the request.
CREATE TABLE IF NOT EXISTS carbon_x_approval_uses (
  approval_id  TEXT PRIMARY KEY,
  launch_id    TEXT   NOT NULL,
  action       TEXT   NOT NULL CHECK (action IN ('post', 'reply')),
  text_sha256  TEXT   NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  used_at      BIGINT NOT NULL
);

-- AG-016: every signed launcher request that carries an issuedAt (autopilot, kill switch,
-- X connect) is single-use: the sha256 of the exact signed text is its nonce, recorded once.
CREATE TABLE IF NOT EXISTS carbon_signed_nonces (
  digest      TEXT PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  launch_id   TEXT   NOT NULL,
  scope       TEXT   NOT NULL,
  wallet      TEXT   NOT NULL,
  used_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS carbon_signed_nonces_launch ON carbon_signed_nonces (launch_id, used_at);

-- AG-024: one launch.created per launch id, enforced by Postgres, so two concurrent
-- POST /api/launch with the same id cannot both append.
CREATE UNIQUE INDEX IF NOT EXISTS events_one_launch_created ON events (launch_id) WHERE kind = 'launch.created';
