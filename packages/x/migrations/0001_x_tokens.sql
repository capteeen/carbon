-- @carbon/x 0001: encrypted OAuth tokens and post dedupe ledger
CREATE TABLE IF NOT EXISTS x_tokens (
  launch_id          text PRIMARY KEY,
  x_user_id          text NOT NULL,
  x_handle           text NOT NULL,
  -- AES-256-GCM: version(1) || nonce(12) || ciphertext+tag; AAD binds launch_id and x_user_id.
  -- Plaintext is JSON {accessToken, refreshToken}; tokens never appear in any other column.
  token_ciphertext   bytea NOT NULL,
  scopes             text[] NOT NULL,
  access_expires_at  timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_tokens_x_user_id_idx ON x_tokens (x_user_id);

CREATE TABLE IF NOT EXISTS x_post_dedupe (
  launch_id   text NOT NULL,
  text_sha256 text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('post', 'reply')),
  status      text NOT NULL CHECK (status IN ('pending', 'published')),
  post_id     text,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (launch_id, text_sha256)
);
