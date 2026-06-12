use vc_server::state::Config;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "vc_server=info,tower_http=info".into()),
        )
        .init();

    let cfg = Config::from_env();
    let bind = cfg.bind.clone();
    let state = vc_server::build_state(cfg);
    let app = vc_server::app(state);

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {bind}: {e}"));
    tracing::info!("vc-server listening on {bind}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
