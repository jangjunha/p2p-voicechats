pub mod auth;
pub mod db;
pub mod error;
pub mod spaces;
pub mod state;
pub mod stickers;
pub mod turn;
pub mod ws;

use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;
use tower_http::cors::CorsLayer;

use crate::state::{AppState, Config};

pub fn build_state(cfg: Config) -> Arc<AppState> {
    let db = db::Db::open(&cfg.db_path).expect("failed to open database");
    Arc::new(AppState {
        db,
        hub: ws::Hub::default(),
        cfg,
    })
}

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/register", post(auth::register))
        .route("/api/auth/challenge", get(auth::challenge))
        .route("/api/auth/login", post(auth::login))
        .route("/api/spaces", post(spaces::create_space).get(spaces::list_spaces))
        .route("/api/spaces/{space_id}/members", get(spaces::list_members))
        .route(
            "/api/spaces/{space_id}/members/{user_id}",
            delete(spaces::remove_member),
        )
        .route("/api/spaces/{space_id}/channels", post(spaces::create_channel))
        .route("/api/spaces/{space_id}/invites", post(spaces::create_invite))
        .route("/api/invites/{token}/accept", post(spaces::accept_invite))
        .route(
            "/api/spaces/{space_id}/keys",
            post(spaces::upload_keys).get(spaces::fetch_keys),
        )
        .route(
            "/api/channels/{channel_id}/messages",
            post(spaces::post_message).get(spaces::fetch_messages),
        )
        .route(
            "/api/spaces/{space_id}/stickers",
            post(stickers::create_sticker).get(stickers::list_stickers),
        )
        .route(
            "/api/spaces/{space_id}/stickers/{sticker_id}",
            get(stickers::fetch_sticker).delete(stickers::delete_sticker),
        )
        .route("/api/turn-credentials", get(turn::credentials))
        .route("/api/ws", get(ws::ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
