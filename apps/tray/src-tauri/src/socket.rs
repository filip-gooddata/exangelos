use std::path::PathBuf;

/// The longest socket path, in UTF-8 bytes, that fits `sockaddr_un` on every
/// supported platform.
pub const MAX_SOCKET_PATH_BYTES: usize = 103;

/// Resolves the daemon socket the way the daemon's Paths adapter does:
/// `$EXANGELOS_HOME/daemon.sock`, else
/// `${XDG_STATE_HOME:-$HOME/.local/state}/exangelos/daemon.sock`. Empty
/// variables count as unset, HOME is required whenever EXANGELOS_HOME is
/// unset, and parts are joined as strings, as the adapter does.
pub fn daemon_socket_path(env: impl Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    let set = |name: &str| env(name).filter(|value| !value.is_empty());
    let state = match set("EXANGELOS_HOME") {
        Some(single) => single,
        None => {
            let home = set("HOME")
                .ok_or("HOME is not set, so the daemon socket path cannot be resolved")?;
            let base = set("XDG_STATE_HOME").unwrap_or_else(|| format!("{home}/.local/state"));
            format!("{base}/exangelos")
        }
    };
    let socket = format!("{state}/daemon.sock");
    let length = socket.len();
    if length > MAX_SOCKET_PATH_BYTES {
        return Err(format!(
            "SocketPathTooLong: {socket} is {length} bytes, over the limit of {MAX_SOCKET_PATH_BYTES}"
        ));
    }
    Ok(PathBuf::from(socket))
}
