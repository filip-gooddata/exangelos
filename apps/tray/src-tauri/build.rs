const COMMANDS: &[&str] = &[
    "relay_open",
    "relay_write",
    "relay_close",
    "tray_set_attention",
    "host_info",
    "host_smoke_report",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build script failed");
}
