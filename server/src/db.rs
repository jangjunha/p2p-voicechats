use std::sync::{Arc, Mutex};

use rusqlite::Connection;

/// SQLite behind a mutex. Queries here are tiny and the workload is a friend
/// group, so a single connection is simpler and plenty fast (WAL keeps reads
/// from blocking the occasional write from another process, e.g. backups).
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let conn = self.0.lock().expect("db mutex poisoned");
        f(&conn)
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sign_pub    TEXT NOT NULL UNIQUE,
    kem_pub     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
    nonce       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    current_epoch INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
    space_id    TEXT NOT NULL REFERENCES spaces(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
    id          TEXT PRIMARY KEY,
    space_id    TEXT NOT NULL REFERENCES spaces(id),
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
    token       TEXT PRIMARY KEY,
    space_id    TEXT NOT NULL REFERENCES spaces(id),
    created_by  TEXT NOT NULL REFERENCES users(id),
    expires_at  INTEGER,
    created_at  INTEGER NOT NULL
);

-- Wrapped space keys; `wrapped` is an opaque sealed box only the member can open.
CREATE TABLE IF NOT EXISTS space_keys (
    space_id    TEXT NOT NULL REFERENCES spaces(id),
    epoch       INTEGER NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id),
    wrapped     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (space_id, epoch, user_id)
);

-- Message bodies are ciphertext; the server can only route them.
CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,    -- ULID: time-ordered pagination cursor
    channel_id  TEXT NOT NULL REFERENCES channels(id),
    sender_id   TEXT NOT NULL REFERENCES users(id),
    epoch       INTEGER NOT NULL,
    nonce       TEXT NOT NULL,
    ct          TEXT NOT NULL,
    sig         TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, id);

-- Space stickers: owner-uploaded (animated) webp images, end-to-end encrypted
-- with the space key exactly like messages. `ct` is the base64url ciphertext of
-- the webp bytes (AEAD under the space key for `epoch`); the server stores the
-- blob opaquely and never sees the image.
CREATE TABLE IF NOT EXISTS stickers (
    id          TEXT PRIMARY KEY,    -- UUIDv4
    space_id    TEXT NOT NULL REFERENCES spaces(id),
    name        TEXT NOT NULL,
    epoch       INTEGER NOT NULL,
    nonce       TEXT NOT NULL,
    ct          TEXT NOT NULL,
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stickers_space ON stickers (space_id, created_at);
"#;
