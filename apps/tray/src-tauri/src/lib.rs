//! Exangelos tray host: the tray icon, the panel window and the relay to the
//! daemon socket. It holds no logic; the panel talks to the daemon through
//! the relay.

pub mod relay;
pub mod socket;

use std::process;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::image::Image;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use relay::{Relay, RelayEvent};

const PANEL: &str = "panel";
const TRAY: &str = "main";
const CONNECTION_HEADER: &str = "exangelos-relay-connection";
const SMOKE_TIMEOUT: Duration = Duration::from_secs(15);

const ICON_QUIET: &[u8] = include_bytes!("../../icons/tray-quiet.png");
const ICON_ATTENTION: &[u8] = include_bytes!("../../icons/tray-attention.png");

struct Host {
    relay: Relay,
    smoke: bool,
}

#[tauri::command]
async fn relay_open(
    host: State<'_, Host>,
    events: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    host.relay
        .open(&socket::daemon_socket_path(), move |event| {
            let message = match event {
                RelayEvent::Data(bytes) => InvokeResponseBody::Raw(bytes),
                RelayEvent::Closed => InvokeResponseBody::Json(r#"{"type":"closed"}"#.into()),
                RelayEvent::Error(message) => InvokeResponseBody::Json(
                    serde_json::json!({ "type": "error", "message": message }).to_string(),
                ),
            };
            let _ = events.send(message);
        })
        .await
}

#[tauri::command]
async fn relay_write(host: State<'_, Host>, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get(CONNECTION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| format!("missing or invalid {CONNECTION_HEADER} header"))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("relay_write expects raw bytes as the body".into());
    };
    host.relay.write(id, bytes).await
}

#[tauri::command]
fn relay_close(host: State<'_, Host>, connection: u32) {
    host.relay.close(connection);
}

#[tauri::command]
fn tray_set_attention(app: AppHandle, needs_you: bool) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY).ok_or("tray icon missing")?;
    let image = tray_image(if needs_you {
        ICON_ATTENTION
    } else {
        ICON_QUIET
    });
    tray.set_icon(Some(image))
        .map_err(|error| error.to_string())?;
    tray.set_icon_as_template(true)
        .map_err(|error| error.to_string())
}

#[derive(Serialize)]
struct HostInfo {
    smoke: bool,
    platform: &'static str,
}

#[tauri::command]
fn host_info(host: State<'_, Host>) -> HostInfo {
    HostInfo {
        smoke: host.smoke,
        platform: if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        },
    }
}

#[tauri::command]
fn host_smoke_report(app: AppHandle, host: State<'_, Host>, ok: bool, report: String) {
    if !host.smoke {
        return;
    }
    println!("SMOKE {}", report.replace(['\r', '\n'], " "));
    app.exit(if ok { 0 } else { 1 });
}

fn tray_image(png: &[u8]) -> Image<'static> {
    Image::from_bytes(png).expect("bundled tray icon is a valid PNG")
}

pub fn run() {
    let smoke = std::env::args().any(|argument| argument == "--smoke");
    if smoke {
        thread::spawn(|| {
            thread::sleep(SMOKE_TIMEOUT);
            eprintln!(
                "SMOKE timeout: no report within {} s",
                SMOKE_TIMEOUT.as_secs()
            );
            process::exit(1);
        });
    }

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .manage(Host {
            relay: Relay::default(),
            smoke,
        })
        .invoke_handler(tauri::generate_handler![
            relay_open,
            relay_write,
            relay_close,
            tray_set_attention,
            host_info,
            host_smoke_report
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let window = build_panel(app.handle())?;
            platform::prepare_panel(&window)?;
            build_tray(app.handle())?;
            // The sidecar (the daemon binary shipped with the app) starts here
            // once it exists; see `bundle.externalBin`.
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the panel hides it; only Quit ends the app.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Exangelos tray");
}

fn build_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html".into()))
        .title("Exangelos")
        .inner_size(380.0, 520.0)
        .resizable(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.decorations(false).skip_taskbar(true);
    builder.build()
}

fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let open = MenuItem::with_id(app, "open", "Open panel", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Exangelos", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id(TRAY)
        .icon(tray_image(ICON_QUIET))
        .icon_as_template(true)
        .tooltip("Exangelos")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => platform::show_panel(app, None),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| platform::tray_event(tray.app_handle(), event))
        .build(app)
}

#[cfg(target_os = "macos")]
#[allow(clippy::unused_unit)] // panel_event! requires the `-> ()`
mod platform {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
    use tauri::{AppHandle, LogicalPosition, Manager, Position, Rect, Size, WebviewWindow};
    use tauri_nspanel::{
        tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
    };

    use super::PANEL;

    tauri_panel! {
        panel!(DropdownPanel {
            config: {
                can_become_key_window: true,
                is_floating_panel: true
            }
        })

        panel_event!(DropdownPanelEvents {
            window_did_resign_key(notification: &NSNotification) -> ()
        })
    }

    pub fn prepare_panel(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
        let panel = window.to_panel::<DropdownPanel>()?;
        panel.set_level(PanelLevel::Status.value());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .stationary()
                .full_screen_auxiliary()
                .value(),
        );
        // A non-activating panel takes key focus without activating the app,
        // so it can open over a fullscreen app.
        panel.add_style_mask(StyleMask::empty().nonactivating_panel().value())?;

        let events = DropdownPanelEvents::new();
        let weak = std::sync::Arc::downgrade(&panel);
        events.window_did_resign_key(move |_| {
            if let Some(panel) = weak.upgrade() {
                panel.hide();
            }
        });
        panel.set_event_handler(Some(events.as_ref()));
        Ok(())
    }

    pub fn tray_event(app: &AppHandle, event: TrayIconEvent) {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            rect,
            ..
        } = event
        {
            match app.get_webview_panel(PANEL) {
                Ok(panel) if panel.is_visible() => panel.hide(),
                _ => show_panel(app, Some(rect)),
            }
        }
    }

    /// Shows the panel centred under the tray icon.
    pub fn show_panel(app: &AppHandle, anchor: Option<Rect>) {
        let Ok(panel) = app.get_webview_panel(PANEL) else {
            return;
        };
        // `panel.to_window()` would turn the panel back into a plain window,
        // so the window comes from the manager.
        if let (Some(rect), Some(window)) = (anchor, app.get_webview_window(PANEL)) {
            if let Some(position) = dropdown_position(app, &window, rect) {
                let _ = window.set_position(position);
            }
        }
        panel.show_and_make_key();
    }

    /// The tray rect is physical at the tray's screen scale, which may differ
    /// from the panel's current screen, so the position is computed in
    /// logical points, which AppKit shares across screens.
    fn dropdown_position(
        app: &AppHandle,
        window: &WebviewWindow,
        rect: Rect,
    ) -> Option<LogicalPosition<f64>> {
        let (icon_position, icon_size) = match (rect.position, rect.size) {
            (Position::Logical(position), Size::Logical(size)) => (position, size),
            (position, size) => {
                let physical = position.to_physical::<f64>(1.0);
                let scale = tray_screen_scale(app, physical.x, physical.y)?;
                (position.to_logical(scale), size.to_logical(scale))
            }
        };
        let panel = window
            .outer_size()
            .ok()?
            .to_logical::<f64>(window.scale_factor().ok()?);
        Some(LogicalPosition::new(
            icon_position.x + icon_size.width / 2.0 - panel.width / 2.0,
            icon_position.y + icon_size.height,
        ))
    }

    fn tray_screen_scale(app: &AppHandle, x: f64, y: f64) -> Option<f64> {
        app.available_monitors()
            .ok()?
            .into_iter()
            .find_map(|monitor| {
                let scale = monitor.scale_factor();
                let origin = monitor.position().to_logical::<f64>(scale);
                let size = monitor.size().to_logical::<f64>(scale);
                let (x, y) = (x / scale, y / scale);
                let inside = x >= origin.x
                    && x < origin.x + size.width
                    && y >= origin.y
                    && y < origin.y + size.height;
                inside.then_some(scale)
            })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use tauri::tray::TrayIconEvent;
    use tauri::{AppHandle, Manager, Rect, WebviewWindow};

    use super::PANEL;

    pub fn prepare_panel(_window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    /// AppIndicator delivers no click events; the menu opens the panel.
    pub fn tray_event(_app: &AppHandle, _event: TrayIconEvent) {}

    pub fn show_panel(app: &AppHandle, _anchor: Option<Rect>) {
        if let Some(window) = app.get_webview_window(PANEL) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}
