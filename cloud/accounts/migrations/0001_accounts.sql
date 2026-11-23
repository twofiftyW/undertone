CREATE TABLE invites (
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  reserved_for TEXT
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  invite_hash TEXT NOT NULL UNIQUE,
  revision TEXT NOT NULL DEFAULT '0'
);

-- Accounts are inserted only by the conditional registration statement.
-- Redeeming the invite in the same statement makes concurrent claims safe.
CREATE TRIGGER redeem_invite AFTER INSERT ON accounts
BEGIN
  DELETE FROM invites WHERE hash = NEW.invite_hash;
END;

CREATE TABLE sign_ins (
  hash TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  invite_hash TEXT,
  expires_at INTEGER NOT NULL,
  interval INTEGER NOT NULL,
  next_poll INTEGER NOT NULL
);

CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE library_parts (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  revision TEXT NOT NULL,
  part INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (account_id, revision, part)
);

CREATE INDEX invites_expiry ON invites(expires_at);
CREATE INDEX sign_ins_expiry ON sign_ins(expires_at);
CREATE INDEX sessions_expiry ON sessions(expires_at);
