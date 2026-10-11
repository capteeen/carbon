-- A spend may carry a key (e.g. the buyback's splitId): a resumed action that spends
-- again under the same key is recorded once (AG-022).
ALTER TABLE budget_ledger ADD COLUMN IF NOT EXISTS spend_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS budget_ledger_spend_key ON budget_ledger (launch_id, kind, spend_key) WHERE spend_key IS NOT NULL;
