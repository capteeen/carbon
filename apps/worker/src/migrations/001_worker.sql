-- Worker tables. The event log (core's `events`) stays the public record; these
-- tables carry the launcher's signed inputs to the running molecule, the launch
-- transaction relay, Forge's assets, and which worker owns which launch.

-- Launcher inputs posted through the web API, each signed by the launcher wallet.
-- One answer per (launch, kind, ref): a second answer to the same question is refused.
CREATE TABLE IF NOT EXISTS carbon_user_inputs (
  id          BIGSERIAL PRIMARY KEY,
  launch_id   TEXT   NOT NULL,
  kind        TEXT   NOT NULL CHECK (kind IN ('narrative', 'revision', 'signed_tx')),
  -- What the input answers: scout.proposals event id, sentinel.score event id, or tx request id.
  ref         TEXT   NOT NULL,
  payload     JSONB  NOT NULL,
  wallet      TEXT   NOT NULL,
  signature   TEXT   NOT NULL,
  created_at  BIGINT NOT NULL,
  UNIQUE (launch_id, kind, ref)
);

-- Unsigned launch transactions waiting for the launcher's wallet (public data: it goes on chain).
CREATE TABLE IF NOT EXISTS carbon_tx_requests (
  request_id  TEXT PRIMARY KEY,
  launch_id   TEXT   NOT NULL,
  tx_base64   TEXT   NOT NULL,
  mint        TEXT   NOT NULL,
  payer       TEXT   NOT NULL,
  status      TEXT   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'expired')),
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS carbon_tx_requests_launch ON carbon_tx_requests (launch_id, created_at);

-- Forge's generated assets (logo copy, banner, site HTML). Immutable: the key contains the content hash.
CREATE TABLE IF NOT EXISTS carbon_assets (
  launch_id   TEXT   NOT NULL,
  name        TEXT   NOT NULL,
  mime        TEXT   NOT NULL,
  bytes       BYTEA  NOT NULL,
  sha256      TEXT   NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (launch_id, name)
);

-- Which worker runs which launch's pre-deploy flow.
CREATE TABLE IF NOT EXISTS carbon_worker_launches (
  launch_id   TEXT PRIMARY KEY,
  status      TEXT   NOT NULL CHECK (status IN ('running', 'finished', 'interrupted')),
  worker_id   TEXT   NOT NULL,
  claimed_at  BIGINT NOT NULL,
  finished_at BIGINT,
  outcome     TEXT
);
