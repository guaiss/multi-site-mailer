-- Keys/tokens are viewable in the admin UI (owner's choice: convenience over
-- hash-only storage). Lookups still use key_hash.
ALTER TABLE api_keys ADD COLUMN key_plain TEXT;
ALTER TABLE read_tokens ADD COLUMN key_plain TEXT;
