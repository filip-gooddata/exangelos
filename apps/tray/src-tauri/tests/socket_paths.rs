use std::collections::HashMap;
use std::path::PathBuf;

use exangelos_tray_lib::socket::daemon_socket_path;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    env: HashMap<String, String>,
    socket_path: Option<String>,
}

#[test]
fn resolves_every_shared_fixture_case() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/socket-paths.json")).unwrap();
    for case in cases {
        let resolved = daemon_socket_path(|name| case.env.get(name).cloned());
        match &case.socket_path {
            Some(expected) => assert_eq!(resolved, Ok(PathBuf::from(expected)), "{:?}", case.env),
            None => assert!(resolved.is_err(), "{:?} resolved to {resolved:?}", case.env),
        }
    }
}

#[test]
fn names_the_limit_when_the_path_is_too_long() {
    let home = format!("/{}", "a".repeat(91));
    let error =
        daemon_socket_path(|name| (name == "EXANGELOS_HOME").then(|| home.clone())).unwrap_err();
    assert!(error.starts_with("SocketPathTooLong:"), "{error}");
    assert!(error.contains(&home) && error.contains("103"), "{error}");
}
