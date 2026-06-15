use axum::extract::{Path, Query, State};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::now_ms;
use crate::state::SharedState;

const DEFAULT_INVITE_TTL_SECS: i64 = 7 * 24 * 3600;
const MAX_CT_LEN: usize = 64 * 1024;

// ---------- query helpers ----------

pub fn space_role(c: &Connection, space_id: &str, user_id: &str) -> rusqlite::Result<Option<String>> {
    c.query_row(
        "SELECT role FROM space_members WHERE space_id = ?1 AND user_id = ?2",
        params![space_id, user_id],
        |r| r.get(0),
    )
    .optional()
}

pub fn channel_space(c: &Connection, channel_id: &str) -> rusqlite::Result<Option<String>> {
    c.query_row(
        "SELECT space_id FROM channels WHERE id = ?1",
        [channel_id],
        |r| r.get(0),
    )
    .optional()
}

pub fn member_ids(c: &Connection, space_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = c.prepare("SELECT user_id FROM space_members WHERE space_id = ?1")?;
    let rows = stmt.query_map([space_id], |r| r.get(0))?;
    rows.collect()
}

fn require_member(state: &SharedState, space_id: &str, user_id: &str) -> ApiResult<String> {
    state
        .db
        .with(|c| space_role(c, space_id, user_id))?
        .ok_or_else(|| ApiError::forbidden("not a member of this space"))
}

fn require_owner(state: &SharedState, space_id: &str, user_id: &str) -> ApiResult<()> {
    match require_member(state, space_id, user_id)?.as_str() {
        "owner" => Ok(()),
        _ => Err(ApiError::forbidden("owner role required")),
    }
}

fn space_json(c: &Connection, space_id: &str) -> rusqlite::Result<Option<Value>> {
    let head = c
        .query_row(
            "SELECT id, name, owner_id, current_epoch FROM spaces WHERE id = ?1",
            [space_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((id, name, owner_id, epoch)) = head else {
        return Ok(None);
    };
    let mut stmt =
        c.prepare("SELECT id, name FROM channels WHERE space_id = ?1 ORDER BY created_at")?;
    let channels: Vec<Value> = stmt
        .query_map([space_id], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)? }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(json!({
        "id": id,
        "name": name,
        "owner_id": owner_id,
        "current_epoch": epoch,
        "channels": channels,
    })))
}

fn fanout(state: &SharedState, space_id: &str, event: &Value) -> ApiResult<()> {
    let members = state.db.with(|c| member_ids(c, space_id))?;
    state.hub.send_many(&members, event);
    Ok(())
}

// ---------- spaces ----------

#[derive(Deserialize)]
pub struct NameReq {
    pub name: String,
}

pub async fn create_space(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Json(req): Json<NameReq>,
) -> ApiResult<Json<Value>> {
    let name = req.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(ApiError::bad_request("name must be 1-64 characters"));
    }
    // Optional allowlist: only the configured signing keys may create spaces.
    if !state.cfg.space_creator_sign_pubs.is_empty() {
        let sign_pub: String = state.db.with(|c| {
            c.query_row(
                "SELECT sign_pub FROM users WHERE id = ?1",
                [&user_id],
                |r| r.get(0),
            )
        })?;
        if !state.cfg.space_creator_sign_pubs.contains(&sign_pub) {
            return Err(ApiError::forbidden(
                "not allowed to create spaces on this server",
            ));
        }
    }
    let space_id = uuid::Uuid::new_v4().to_string();
    let channel_id = uuid::Uuid::new_v4().to_string();
    let space = state.db.with(|c| {
        c.execute(
            "INSERT INTO spaces (id, name, owner_id, current_epoch, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
            params![space_id, name, user_id, now_ms()],
        )?;
        c.execute(
            "INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)",
            params![space_id, user_id, now_ms()],
        )?;
        c.execute(
            "INSERT INTO channels (id, space_id, name, created_at) VALUES (?1, ?2, 'general', ?3)",
            params![channel_id, space_id, now_ms()],
        )?;
        space_json(c, &space_id)
    })?;
    Ok(Json(space.expect("space just created")))
}

pub async fn list_spaces(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
) -> ApiResult<Json<Value>> {
    let spaces = state.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT space_id FROM space_members WHERE user_id = ?1 ORDER BY joined_at",
        )?;
        let ids: Vec<String> = stmt
            .query_map([&user_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(s) = space_json(c, &id)? {
                out.push(s);
            }
        }
        Ok(out)
    })?;
    Ok(Json(json!({ "spaces": spaces })))
}

pub async fn list_members(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(space_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &space_id, &user_id)?;
    let members = state.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT u.id, u.name, m.role, u.sign_pub, u.kem_pub
             FROM space_members m JOIN users u ON u.id = m.user_id
             WHERE m.space_id = ?1 ORDER BY m.joined_at",
        )?;
        let members = stmt
            .query_map([&space_id], |r| {
                Ok(json!({
                    "user_id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "role": r.get::<_, String>(2)?,
                    "sign_pub": r.get::<_, String>(3)?,
                    "kem_pub": r.get::<_, String>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>();
        members
    })?;
    Ok(Json(json!({ "members": members })))
}

pub async fn remove_member(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path((space_id, target_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &space_id, &user_id)?;
    if target_id == user_id {
        return Err(ApiError::bad_request("the owner cannot remove themselves"));
    }
    // Notify before pulling membership so the removed user hears about it too.
    fanout(
        &state,
        &space_id,
        &json!({ "type": "member_removed", "space_id": space_id, "user_id": target_id }),
    )?;
    let removed = state.db.with(|c| {
        c.execute(
            "DELETE FROM space_keys WHERE space_id = ?1 AND user_id = ?2",
            params![space_id, target_id],
        )?;
        c.execute(
            "DELETE FROM space_members WHERE space_id = ?1 AND user_id = ?2 AND role != 'owner'",
            params![space_id, target_id],
        )
    })?;
    if removed == 0 {
        return Err(ApiError::not_found("no such member"));
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------- channels ----------

pub async fn create_channel(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(space_id): Path<String>,
    Json(req): Json<NameReq>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &space_id, &user_id)?;
    let name = req.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(ApiError::bad_request("name must be 1-64 characters"));
    }
    let channel_id = uuid::Uuid::new_v4().to_string();
    state.db.with(|c| {
        c.execute(
            "INSERT INTO channels (id, space_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![channel_id, space_id, name, now_ms()],
        )
    })?;
    let event = json!({
        "type": "channel_created",
        "space_id": space_id,
        "channel": { "id": channel_id, "name": name },
    });
    fanout(&state, &space_id, &event)?;
    Ok(Json(json!({ "id": channel_id, "name": name })))
}

// ---------- invites ----------

#[derive(Deserialize, Default)]
pub struct InviteReq {
    pub expires_in_secs: Option<i64>,
}

pub async fn create_invite(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(space_id): Path<String>,
    body: Option<Json<InviteReq>>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &space_id, &user_id)?;
    let ttl = body
        .and_then(|Json(b)| b.expires_in_secs)
        .unwrap_or(DEFAULT_INVITE_TTL_SECS)
        .clamp(60, 30 * 24 * 3600);
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    let token = B64.encode(buf);
    let expires_at = now_ms() + ttl * 1000;
    state.db.with(|c| {
        c.execute(
            "INSERT INTO invites (token, space_id, created_by, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![token, space_id, user_id, expires_at, now_ms()],
        )
    })?;
    Ok(Json(json!({ "token": token, "expires_at": expires_at })))
}

pub async fn accept_invite(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(token): Path<String>,
) -> ApiResult<Json<Value>> {
    let space_id: Option<String> = state.db.with(|c| {
        c.query_row(
            "SELECT space_id FROM invites WHERE token = ?1 AND (expires_at IS NULL OR expires_at >= ?2)",
            params![token, now_ms()],
            |r| r.get(0),
        )
        .optional()
    })?;
    let space_id = space_id.ok_or_else(|| ApiError::not_found("unknown or expired invite"))?;

    let (newly_joined, user, space) = state.db.with(|c| {
        let n = c.execute(
            "INSERT OR IGNORE INTO space_members (space_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', ?3)",
            params![space_id, user_id, now_ms()],
        )?;
        let user = c.query_row(
            "SELECT id, name, sign_pub, kem_pub FROM users WHERE id = ?1",
            [&user_id],
            |r| {
                Ok(json!({
                    "user_id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "sign_pub": r.get::<_, String>(2)?,
                    "kem_pub": r.get::<_, String>(3)?,
                }))
            },
        )?;
        Ok((n == 1, user, space_json(c, &space_id)?))
    })?;

    if newly_joined {
        fanout(
            &state,
            &space_id,
            &json!({ "type": "member_joined", "space_id": space_id, "user": user }),
        )?;
        // Ask online members to wrap the space keys for the newcomer.
        let members: Vec<String> = state
            .db
            .with(|c| member_ids(c, &space_id))?
            .into_iter()
            .filter(|m| m != &user_id)
            .collect();
        state.hub.send_many(
            &members,
            &json!({
                "type": "key_request",
                "space_id": space_id,
                "user": { "user_id": user["user_id"], "kem_pub": user["kem_pub"] },
            }),
        );
    }
    Ok(Json(space.expect("space exists for valid invite")))
}

// ---------- wrapped space keys ----------

#[derive(Deserialize)]
pub struct KeyWrap {
    pub user_id: String,
    pub wrapped: String,
}

#[derive(Deserialize)]
pub struct UploadKeysReq {
    pub epoch: i64,
    pub wraps: Vec<KeyWrap>,
}

pub async fn upload_keys(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(space_id): Path<String>,
    Json(req): Json<UploadKeysReq>,
) -> ApiResult<Json<Value>> {
    let role = require_member(&state, &space_id, &user_id)?;
    let current: i64 = state.db.with(|c| {
        c.query_row(
            "SELECT current_epoch FROM spaces WHERE id = ?1",
            [&space_id],
            |r| r.get(0),
        )
    })?;

    let rotating = req.epoch == current + 1;
    if rotating && role != "owner" {
        return Err(ApiError::forbidden("only the owner can rotate the space key"));
    }
    if !rotating && (req.epoch < 1 || req.epoch > current) {
        return Err(ApiError::bad_request("epoch out of range"));
    }
    if req.wraps.is_empty() || req.wraps.len() > 256 {
        return Err(ApiError::bad_request("1-256 wraps per request"));
    }

    let targets: Vec<String> = req.wraps.iter().map(|w| w.user_id.clone()).collect();
    state.db.with(|c| {
        for w in &req.wraps {
            if space_role(c, &space_id, &w.user_id)?.is_none() {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            // First wrap wins: a later upload cannot silently replace a key a
            // member may have already used.
            c.execute(
                "INSERT OR IGNORE INTO space_keys (space_id, epoch, user_id, wrapped, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![space_id, req.epoch, w.user_id, w.wrapped, now_ms()],
            )?;
        }
        if rotating {
            c.execute(
                "UPDATE spaces SET current_epoch = ?1 WHERE id = ?2",
                params![req.epoch, space_id],
            )?;
        }
        Ok(())
    })
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            ApiError::bad_request("wrap target is not a member of this space")
        }
        e => e.into(),
    })?;

    let epoch_now = if rotating { req.epoch } else { current };
    state.hub.send_many(
        &targets,
        &json!({ "type": "keys_updated", "space_id": space_id, "current_epoch": epoch_now }),
    );
    Ok(Json(json!({ "ok": true, "current_epoch": epoch_now })))
}

pub async fn fetch_keys(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(space_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &space_id, &user_id)?;
    let (current, wraps) = state.db.with(|c| {
        let current: i64 = c.query_row(
            "SELECT current_epoch FROM spaces WHERE id = ?1",
            [&space_id],
            |r| r.get(0),
        )?;
        let mut stmt = c.prepare(
            "SELECT epoch, wrapped FROM space_keys WHERE space_id = ?1 AND user_id = ?2 ORDER BY epoch",
        )?;
        let wraps: Vec<Value> = stmt
            .query_map(params![space_id, user_id], |r| {
                Ok(json!({ "epoch": r.get::<_, i64>(0)?, "wrapped": r.get::<_, String>(1)? }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok((current, wraps))
    })?;
    Ok(Json(json!({ "current_epoch": current, "wraps": wraps })))
}

// ---------- messages ----------

#[derive(Deserialize)]
pub struct PostMessageReq {
    pub epoch: i64,
    pub nonce: String,
    pub ct: String,
    pub sig: String,
}

pub async fn post_message(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(channel_id): Path<String>,
    Json(req): Json<PostMessageReq>,
) -> ApiResult<Json<Value>> {
    let space_id = state
        .db
        .with(|c| channel_space(c, &channel_id))?
        .ok_or_else(|| ApiError::not_found("unknown channel"))?;
    require_member(&state, &space_id, &user_id)?;
    if req.ct.len() > MAX_CT_LEN {
        return Err(ApiError::bad_request("message too large"));
    }

    let id = ulid::Ulid::new().to_string();
    let created_at = now_ms();
    state.db.with(|c| {
        c.execute(
            "INSERT INTO messages (id, channel_id, sender_id, epoch, nonce, ct, sig, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, channel_id, user_id, req.epoch, req.nonce, req.ct, req.sig, created_at],
        )
    })?;

    let event = json!({
        "type": "message_new",
        "channel_id": channel_id,
        "message": {
            "id": id, "sender_id": user_id, "epoch": req.epoch,
            "nonce": req.nonce, "ct": req.ct, "sig": req.sig, "created_at": created_at,
        },
    });
    fanout(&state, &space_id, &event)?;
    Ok(Json(json!({ "id": id, "created_at": created_at })))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub before: Option<String>,
    pub limit: Option<i64>,
}

pub async fn fetch_messages(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(channel_id): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Value>> {
    let space_id = state
        .db
        .with(|c| channel_space(c, &channel_id))?
        .ok_or_else(|| ApiError::not_found("unknown channel"))?;
    require_member(&state, &space_id, &user_id)?;

    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let before = q.before.unwrap_or_else(|| "\u{10FFFF}".to_string());
    let messages = state.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT id, sender_id, epoch, nonce, ct, sig, created_at FROM messages
             WHERE channel_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3",
        )?;
        let messages = stmt
            .query_map(params![channel_id, before, limit], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "sender_id": r.get::<_, String>(1)?,
                    "epoch": r.get::<_, i64>(2)?,
                    "nonce": r.get::<_, String>(3)?,
                    "ct": r.get::<_, String>(4)?,
                    "sig": r.get::<_, String>(5)?,
                    "created_at": r.get::<_, i64>(6)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>();
        messages
    })?;
    Ok(Json(json!({ "messages": messages })))
}
