use crate::db::Db;
use crate::ws::Hub;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub db_path: String,
    /// Shared secret for coturn `use-auth-secret` ephemeral credentials.
    pub turn_secret: Option<String>,
    /// e.g. "turn:example.com:3478?transport=udp,turn:example.com:3478?transport=tcp"
    pub turn_urls: Vec<String>,
    pub turn_ttl_secs: u64,
    pub stun_urls: Vec<String>,
    /// If non-empty, only users whose `sign_pub` appears here may create spaces.
    /// Empty means anyone can (backwards compatible).
    pub space_creator_sign_pubs: Vec<String>,
    /// If set, registration is refused once the total user count reaches this.
    /// None means unlimited (backwards compatible).
    pub max_users: Option<i64>,
}

impl Config {
    pub fn from_env() -> Self {
        let csv = |v: Option<String>| -> Vec<String> {
            v.map(|s| {
                s.split(',')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default()
        };
        Self {
            bind: std::env::var("MALGUEM_BIND").unwrap_or_else(|_| "0.0.0.0:8787".into()),
            db_path: std::env::var("MALGUEM_DB").unwrap_or_else(|_| "malguem.sqlite3".into()),
            turn_secret: std::env::var("MALGUEM_TURN_SECRET").ok().filter(|s| !s.is_empty()),
            turn_urls: csv(std::env::var("MALGUEM_TURN_URLS").ok()),
            turn_ttl_secs: std::env::var("MALGUEM_TURN_TTL")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3600),
            stun_urls: {
                let v = csv(std::env::var("MALGUEM_STUN_URLS").ok());
                if v.is_empty() {
                    vec!["stun:stun.l.google.com:19302".into()]
                } else {
                    v
                }
            },
            space_creator_sign_pubs: csv(std::env::var("MALGUEM_SPACE_CREATOR_SIGN_PUBS").ok()),
            max_users: std::env::var("MALGUEM_MAX_USERS")
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .filter(|&n| n >= 0),
        }
    }
}

pub struct AppState {
    pub db: Db,
    pub hub: Hub,
    pub cfg: Config,
}

pub type SharedState = std::sync::Arc<AppState>;
