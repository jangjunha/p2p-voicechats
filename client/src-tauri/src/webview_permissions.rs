//! Grant getUserMedia (microphone/camera) permission inside the webview.
//!
//! WebView2 on Windows denies media-device access unless the host app handles
//! the `PermissionRequested` event — that's why "Join call" fails on Windows
//! with `NotAllowedError` out of the box. We allow **only** microphone and
//! camera here. Screen capture (`getDisplayMedia`) keeps its own picker and
//! permission flow, so the user still chooses which monitor to share.

#[cfg(windows)]
pub fn allow_media(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2PermissionRequestedEventArgs,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let result = window.with_webview(|webview| unsafe {
        let core: ICoreWebView2 = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(e) => {
                eprintln!("voicechats: could not access CoreWebView2: {e}");
                return;
            }
        };

        let handler = PermissionRequestedEventHandler::create(Box::new(
            move |_sender: Option<ICoreWebView2>,
                  args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                if let Some(args) = args {
                    // webview2-com models the getter as an out-parameter.
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                        || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                    {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                }
                Ok(())
            },
        ));

        // The token type is inferred from add_PermissionRequested's signature,
        // which avoids depending on EventRegistrationToken's exact module path.
        let mut token = Default::default();
        if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
            eprintln!("voicechats: failed to register PermissionRequested: {e}");
        }
    });

    if let Err(e) = result {
        eprintln!("voicechats: with_webview failed: {e}");
    }
}

/// macOS (WKWebView) prompts using the Info.plist usage strings plus wry's
/// permission delegate; Linux (WebKitGTK) prompts via the webview. No host
/// handling is needed on those platforms.
#[cfg(not(windows))]
pub fn allow_media(_window: &tauri::WebviewWindow) {}
