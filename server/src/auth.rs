use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{ApiError, ApiResult};
use crate::now_ms;
use crate::state::SharedState;

pub const LOGIN_CONTEXT: &str = "vc-login:";
const CHALLENGE_TTL_MS: i64 = 60_000;

#[derive(Serialize, Clone)]
pub struct UserPublic {
    pub user_id: String,
    pub name: String,
    pub sign_pub: String,
    pub kem_pub: String,
}

pub fn decode_key32(s: &str) -> Result<[u8; 32], ApiError> {
    let bytes = B64
        .decode(s)
        .map_err(|_| ApiError::bad_request("invalid base64url key"))?;
    bytes
        .try_into()
        .map_err(|_| ApiError::bad_request("key must be 32 bytes"))
}

pub fn verify_sig(sign_pub_b64: &str, message: &[u8], sig_b64: &str) -> ApiResult<()> {
    let pk = VerifyingKey::from_bytes(&decode_key32(sign_pub_b64)?)
        .map_err(|_| ApiError::bad_request("invalid Ed25519 public key"))?;
    let sig_bytes: [u8; 64] = B64
        .decode(sig_b64)
        .map_err(|_| ApiError::bad_request("invalid base64url signature"))?
        .try_into()
        .map_err(|_| ApiError::bad_request("signature must be 64 bytes"))?;
    pk.verify(message, &Signature::from_bytes(&sig_bytes))
        .map_err(|_| ApiError::unauthorized("signature verification failed"))
}

fn random_b64(len: usize) -> String {
    let mut buf = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut buf);
    B64.encode(buf)
}

fn token_hash(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

// Tiny local hex encoder to avoid another dependency.
mod hex {
    pub fn encode(data: impl AsRef<[u8]>) -> String {
        data.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[derive(Deserialize)]
pub struct RegisterReq {
    pub name: String,
    pub sign_pub: String,
    pub kem_pub: String,
}

pub async fn register(
    State(state): State<SharedState>,
    Json(req): Json<RegisterReq>,
) -> ApiResult<Json<Value>> {
    let name = req.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(ApiError::bad_request("name must be 1-64 characters"));
    }
    // Validate both keys decode before storing.
    VerifyingKey::from_bytes(&decode_key32(&req.sign_pub)?)
        .map_err(|_| ApiError::bad_request("invalid Ed25519 public key"))?;
    decode_key32(&req.kem_pub)?;

    let user_id = uuid::Uuid::new_v4().to_string();
    let max_users = state.cfg.max_users;
    // Check the cap and insert in one locked section so concurrent registrations
    // can't both slip past a full roster.
    let res = state.db.with(|c| {
        if let Some(max) = max_users {
            let count: i64 = c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
            if count >= max {
                return Ok(None);
            }
        }
        c.execute(
            "INSERT INTO users (id, name, sign_pub, kem_pub, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![user_id, name, req.sign_pub, req.kem_pub, now_ms()],
        )?;
        Ok(Some(()))
    });
    match res {
        Ok(Some(())) => Ok(Json(json!({ "user_id": user_id }))),
        Ok(None) => Err(ApiError::conflict("the server has reached its user limit")),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Err(ApiError::bad_request("this signing key is already registered"))
        }
        Err(e) => Err(e.into()),
    }
}

#[derive(Deserialize)]
pub struct ChallengeQuery {
    pub user_id: String,
}

pub async fn challenge(
    State(state): State<SharedState>,
    Query(q): Query<ChallengeQuery>,
) -> ApiResult<Json<Value>> {
    let nonce = random_b64(32);
    state.db.with(|c| {
        c.execute(
            "DELETE FROM auth_challenges WHERE expires_at < ?1",
            [now_ms()],
        )?;
        c.execute(
            "INSERT INTO auth_challenges (nonce, user_id, expires_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![nonce, q.user_id, now_ms() + CHALLENGE_TTL_MS],
        )
    })?;
    Ok(Json(json!({ "nonce": nonce })))
}

#[derive(Deserialize)]
pub struct LoginReq {
    pub user_id: String,
    pub nonce: String,
    pub sig: String,
}

pub async fn login(
    State(state): State<SharedState>,
    Json(req): Json<LoginReq>,
) -> ApiResult<Json<Value>> {
    let valid: bool = state.db.with(|c| {
        let n = c.execute(
            "DELETE FROM auth_challenges WHERE nonce = ?1 AND user_id = ?2 AND expires_at >= ?3",
            rusqlite::params![req.nonce, req.user_id, now_ms()],
        )?;
        Ok(n == 1)
    })?;
    if !valid {
        return Err(ApiError::unauthorized("unknown or expired challenge"));
    }

    let user: Option<UserPublic> = state.db.with(|c| {
        c.query_row(
            "SELECT id, name, sign_pub, kem_pub FROM users WHERE id = ?1",
            [&req.user_id],
            |r| {
                Ok(UserPublic {
                    user_id: r.get(0)?,
                    name: r.get(1)?,
                    sign_pub: r.get(2)?,
                    kem_pub: r.get(3)?,
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e),
        })
    })?;
    let user = user.ok_or_else(|| ApiError::unauthorized("unknown user"))?;

    let msg = format!("{LOGIN_CONTEXT}{}", req.nonce);
    verify_sig(&user.sign_pub, msg.as_bytes(), &req.sig)?;

    let token = random_b64(32);
    state.db.with(|c| {
        c.execute(
            "INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![token_hash(&token), user.user_id, now_ms()],
        )
    })?;
    Ok(Json(json!({ "token": token, "user": user })))
}

pub fn user_for_token(state: &SharedState, token: &str) -> Option<String> {
    state
        .db
        .with(|c| {
            c.query_row(
                "SELECT user_id FROM tokens WHERE token_hash = ?1",
                [token_hash(token)],
                |r| r.get::<_, String>(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })
        })
        .ok()
        .flatten()
}

/// Extractor: the authenticated user's id, from `Authorization: Bearer <token>`.
pub struct AuthUser(pub String);

impl FromRequestParts<SharedState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError::unauthorized("missing bearer token"))?;
        user_for_token(state, token)
            .map(AuthUser)
            .ok_or_else(|| ApiError::unauthorized("invalid token"))
    }
}
