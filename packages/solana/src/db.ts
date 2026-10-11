/**
 * Postgres persistence for the chain layer. Every money movement has a durable
 * row written BEFORE the transaction is broadcast (signature + raw signed
 * bytes + last valid block height), so a crash at any point resumes by asking
 * the chain about that exact signature instead of paying again.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
  connect(): Promise<PoolClient>;
}
export type { Pool };

/** States shared by every ledger row that carries a transaction. */
export type TxRowState = 'pending' | 'sent' | 'confirmed';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sol_launches (
  launch_id         text PRIMARY KEY,
  mode              text NOT NULL CHECK (mode IN ('native','wallet')),
  network           text NOT NULL,
  mint              text UNIQUE,
  mint_secret       text,
  mint_wiped_at     timestamptz,
  creator           text,
  creator_secret    text,
  sharing_config    text,
  launcher_wallet   text,
  name              text,
  symbol            text,
  metadata_uri      text,
  dev_buy_lamports  numeric,
  approval_id       text,
  message_hash      text,
  tx_sig            text,
  raw_tx            text,
  lvbh              bigint,
  fee_recipient     text,
  state             text NOT NULL DEFAULT 'wallet' CHECK (state IN ('wallet','built','sent','confirmed')),
  born_at_ms        bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- AG-002: one launch approval authorises exactly one set of launch values.
CREATE TABLE IF NOT EXISTS sol_launch_approvals (
  approval_id       text PRIMARY KEY,
  launch_id         text NOT NULL REFERENCES sol_launches(launch_id),
  name              text NOT NULL,
  symbol            text NOT NULL,
  metadata_uri      text NOT NULL,
  dev_buy_lamports  numeric NOT NULL,
  payer             text NOT NULL,
  bound_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sol_claims (
  claim_id      text PRIMARY KEY,
  launch_id     text NOT NULL REFERENCES sol_launches(launch_id),
  mode          text NOT NULL,
  state         text NOT NULL CHECK (state IN ('pending','sent','confirmed')),
  tx_sig        text,
  raw_tx        text,
  lvbh          bigint,
  lamports      numeric,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sol_claims_open ON sol_claims (launch_id) WHERE state <> 'confirmed';

CREATE TABLE IF NOT EXISTS sol_splits (
  split_id      text PRIMARY KEY,
  claim_id      text NOT NULL UNIQUE REFERENCES sol_claims(claim_id),
  launch_id     text NOT NULL,
  mode          text NOT NULL,
  total         numeric NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS split_ledger (
  claim_id      text NOT NULL REFERENCES sol_claims(claim_id),
  leg           text NOT NULL CHECK (leg IN ('launcher','carbon-buyback','treasury')),
  launch_id     text NOT NULL,
  address       text NOT NULL,
  lamports      numeric NOT NULL CHECK (lamports >= 0),
  state         text NOT NULL CHECK (state IN ('pending','sent','confirmed')),
  tx_sig        text,
  raw_tx        text,
  lvbh          bigint,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, leg)
);

-- One row per buy (tranche) of a split's buyback leg; at most one unacknowledged per split.
CREATE TABLE IF NOT EXISTS sol_buybacks (
  split_id      text NOT NULL REFERENCES sol_splits(split_id),
  tranche       integer NOT NULL DEFAULT 1,
  acked         boolean NOT NULL DEFAULT false,
  lamports_spent numeric,
  launch_id     text NOT NULL,
  lamports_in   numeric NOT NULL CHECK (lamports_in > 0),
  venue         text,
  state         text NOT NULL CHECK (state IN ('pending','sent','confirmed')),
  tx_sig        text,
  raw_tx        text,
  lvbh          bigint,
  carbon_out    numeric,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (split_id, tranche)
);
-- Databases created before tranches: add the columns and widen the key (once).
ALTER TABLE sol_buybacks ADD COLUMN IF NOT EXISTS tranche integer NOT NULL DEFAULT 1;
ALTER TABLE sol_buybacks ADD COLUMN IF NOT EXISTS acked boolean NOT NULL DEFAULT false;
ALTER TABLE sol_buybacks ADD COLUMN IF NOT EXISTS lamports_spent numeric;
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.oid = to_regclass('sol_buybacks') AND i.indisprimary AND array_length(i.indkey::int2[], 1) = 1) > 0 THEN
    ALTER TABLE sol_buybacks DROP CONSTRAINT sol_buybacks_pkey;
    ALTER TABLE sol_buybacks ADD PRIMARY KEY (split_id, tranche);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sol_decay (
  launch_id           text PRIMARY KEY,
  state               text NOT NULL CHECK (state IN ('watching','snapshotted','daughter_sent','daughter_confirmed','allocated','done')),
  rule                text NOT NULL,
  collapse_at         bigint,
  quiet_period_start  bigint,
  snapshot            jsonb,
  snapshot_slot       bigint,
  daughter_launch_id  text,
  daughter_mint       text,
  daughter_tx_sig     text,
  daughter_raw_tx     text,
  daughter_lvbh       bigint,
  total_units         numeric,
  allocation          jsonb,
  merkle_root         text,
  emitted             jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Additive columns (idempotent on existing databases).
ALTER TABLE sol_claims ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'carbon';
ALTER TABLE sol_launches ADD COLUMN IF NOT EXISTS foreign_scan_until text;

CREATE TABLE IF NOT EXISTS sol_airdrops (
  daughter_mint text NOT NULL,
  wallet        text NOT NULL,
  launch_id     text NOT NULL,
  units         numeric NOT NULL CHECK (units > 0),
  state         text NOT NULL CHECK (state IN ('pending','sent','confirmed')),
  tx_sig        text,
  raw_tx        text,
  lvbh          bigint,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  emitted       boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (daughter_mint, wallet)
);
`;

export async function ensureSchema(db: Pick<Db, 'query'>): Promise<void> {
  await db.query(SCHEMA_SQL);
}

/**
 * Session advisory lock on one key, held on a dedicated connection for the
 * duration of `fn`. Two workers can never drive the same row at once.
 */
export async function withLock<T>(db: Db, key: string, fn: () => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    }
  } finally {
    client.release();
  }
}
