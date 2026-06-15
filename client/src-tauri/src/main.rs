#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_loopback;
mod keychain;
mod webview_permissions;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_delete,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Allow microphone/camera in the webview (Windows needs this).
                webview_permissions::allow_media(&window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running malguem");
}
