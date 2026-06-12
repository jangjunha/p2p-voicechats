use axum::extract::State;
use axum::Json;
use base64::engine::general_purpose::STANDARD as B64STD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;

use crate::auth::AuthUser;
use crate::error::ApiResult;
use crate::state::SharedState;

/// Ephemeral TURN credentials per coturn's `use-auth-secret` mechanism:
/// username = "<unix expiry>:<user id>", credential = b64(HMAC-SHA1(secret, username)).
/// Members-only: this handler sits behind bearer auth, so the relay is not
/// open to the internet even though coturn itself can't check membership.
pub async fn credentials(
    State(state): State<SharedState>,
    AuthUser(user_id): AuthUser,
) -> ApiResult<Json<Value>> {
    let mut urls: Vec<String> = state.cfg.stun_urls.clone();
    let Some(secret) = &state.cfg.turn_secret else {
        // TURN not configured: STUN-only operation.
        return Ok(Json(json!({ "urls": urls, "username": "", "credential": "", "ttl_secs": 0 })));
    };

    let expiry = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + state.cfg.turn_ttl_secs;
    let username = format!("{expiry}:{user_id}");
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(username.as_bytes());
    let credential = B64STD.encode(mac.finalize().into_bytes());

    urls.extend(state.cfg.turn_urls.iter().cloned());
    Ok(Json(json!({
        "urls": urls,
        "username": username,
        "credential": credential,
        "ttl_secs": state.cfg.turn_ttl_secs,
    })))
}
