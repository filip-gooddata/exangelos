use std::env;
use std::path::PathBuf;

/// `$EXANGELOS_HOME/daemon.sock`, else
/// `${XDG_STATE_HOME:-$HOME/.local/state}/exangelos/daemon.sock`.
pub fn daemon_socket_path() -> PathBuf {
    let set = |name: &str| env::var_os(name).filter(|value| !value.is_empty());
    if let Some(home) = set("EXANGELOS_HOME") {
        return PathBuf::from(home).join("daemon.sock");
    }
    let state = set("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(set("HOME").unwrap_or_default()).join(".local/state"));
    state.join("exangelos").join("daemon.sock")
}
