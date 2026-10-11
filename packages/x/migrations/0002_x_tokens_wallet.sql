-- @carbon/x 0002: bind each X connection to the launcher wallet that started the OAuth flow
ALTER TABLE x_tokens ADD COLUMN IF NOT EXISTS wallet text;
