use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
pub const SIDECAR: &str = "exangelos";

#[derive(Debug, PartialEq, Eq)]
pub enum Daemon {
    Answering,
    Started,
}
pub fn sidecar_path() -> Result<PathBuf, String> {
    let host = std::env::current_exe()
        .map_err(|error| format!("the host executable path is unknown: {error}"))?;
    let directory = host
        .parent()
        .ok_or("the host executable has no parent directory")?;
    Ok(directory.join(SIDECAR))
}
/// Leaves an answering daemon alone. Otherwise runs `exangelos service status`,
/// which, like any CLI call that finds no daemon, installs and starts the user
/// service and waits until the socket answers. A failed start returns the
/// CLI's message.
pub fn ensure_daemon(socket: &Path, sidecar: &Path) -> Result<Daemon, String> {
    if UnixStream::connect(socket).is_ok() {
        return Ok(Daemon::Answering);
    }
    let output = Command::new(sidecar)
        .args(["service", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("starting {} failed: {error}", sidecar.display()))?;
    if output.status.success() {
        return Ok(Daemon::Started);
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if message.is_empty() {
        format!("{} service status failed: {}", sidecar.display(), output.status)
    } else {
        message
    })
}
