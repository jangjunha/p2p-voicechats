//! Space stickers: owner-uploaded (animated) webp, end-to-end encrypted with
//! the space key just like chat messages. The server stores and serves the
//! ciphertext blob opaquely — it never sees the image. Anyone in the space can
//! list and fetch stickers; only the owner can add or remove them.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::now_ms;
use crate::spaces::{fanout, require_member, require_owner};
use crate::state::SharedState;

/// Max ciphertext length (~2 MB). A base64url blob this size decodes to ~1.5 MB
/// of webp, comfortably more than a short looping sticker needs.
const MAX_STICKER_CT_LEN: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
pub struct CreateStickerReq {
    pub name: String,
    pub epoch: i64,
    pub nonce: String,
    pub ct: String,
}

pub async fn create_sticker(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(space_id): Path<String>,
    Json(req): Json<CreateStickerReq>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &space_id, &user_id)?;

    let name = req.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(ApiError::bad_request("name must be 1-64 characters"));
    }
    if req.ct.is_empty() || req.ct.len() > MAX_STICKER_CT_LEN {
        return Err(ApiError::bad_request("sticker too large"));
    }

    // The blob is encrypted under an existing space-key epoch; reject anything
    // the members couldn't actually decrypt.
    let current: i64 = state.db.with(|c| {
        c.query_row(
            "SELECT current_epoch FROM spaces WHERE id = ?1",
            [&space_id],
            |r| r.get(0),
        )
    })?;
    if req.epoch < 1 || req.epoch > current {
        return Err(ApiError::bad_request("epoch out of range"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_ms();
    state.db.with(|c| {
        c.execute(
            "INSERT INTO stickers (id, space_id, name, epoch, nonce, ct, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, space_id, name, req.epoch, req.nonce, req.ct, user_id, created_at],
        )
    })?;

    let meta = json!({
        "id": id, "name": name, "epoch": req.epoch,
        "created_by": user_id, "created_at": created_at,
    });
    fanout(
        &state,
        &space_id,
        &json!({ "type": "sticker_added", "space_id": space_id, "sticker": meta }),
    )?;
    Ok(Json(meta))
}

pub async fn list_stickers(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path(space_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &space_id, &user_id)?;
    let stickers = state.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT id, name, epoch, created_by, created_at FROM stickers
             WHERE space_id = ?1 ORDER BY created_at",
        )?;
        let stickers = stmt
            .query_map([&space_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "epoch": r.get::<_, i64>(2)?,
                    "created_by": r.get::<_, String>(3)?,
                    "created_at": r.get::<_, i64>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>();
        stickers
    })?;
    Ok(Json(json!({ "stickers": stickers })))
}

pub async fn fetch_sticker(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path((space_id, sticker_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &space_id, &user_id)?;
    let sticker = state.db.with(|c| {
        c.query_row(
            "SELECT id, name, epoch, nonce, ct, created_at FROM stickers
             WHERE id = ?1 AND space_id = ?2",
            params![sticker_id, space_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "epoch": r.get::<_, i64>(2)?,
                    "nonce": r.get::<_, String>(3)?,
                    "ct": r.get::<_, String>(4)?,
                    "created_at": r.get::<_, i64>(5)?,
                }))
            },
        )
        .optional()
    })?;
    sticker
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such sticker"))
}

pub async fn delete_sticker(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
    Path((space_id, sticker_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &space_id, &user_id)?;
    let removed = state.db.with(|c| {
        c.execute(
            "DELETE FROM stickers WHERE id = ?1 AND space_id = ?2",
            params![sticker_id, space_id],
        )
    })?;
    if removed == 0 {
        return Err(ApiError::not_found("no such sticker"));
    }
    fanout(
        &state,
        &space_id,
        &json!({ "type": "sticker_removed", "space_id": space_id, "sticker_id": sticker_id }),
    )?;
    Ok(Json(json!({ "ok": true })))
}
