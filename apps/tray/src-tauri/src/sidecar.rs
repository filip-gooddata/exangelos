use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

/// The sidecar's file name next to the host executable. Tauri strips the
/// target triple from `bundle.externalBin` entries when it places them.
pub const SIDECAR: &str = "exangelos";

#[derive(Debug, PartialEq, Eq)]
pub enum Daemon {
    Answering,
    Started { pid: u32 },
}

/// The sidecar beside the host executable.
pub fn sidecar_path() -> Result<PathBuf, String> {
    let host = std::env::current_exe()
        .map_err(|error| format!("the host executable path is unknown: {error}"))?;
    let directory = host
        .parent()
        .ok_or("the host executable has no parent directory")?;
    Ok(directory.join(SIDECAR))
}

/// Leaves a daemon that answers on `socket` alone. Otherwise starts
/// `<sidecar> daemon` in its own process group with no standard streams, so
/// it outlives the host. The daemon takes its own lock, so a race with
/// another starter leaves one daemon.
pub fn ensure_daemon(socket: &Path, sidecar: &Path) -> Result<Daemon, String> {
    if UnixStream::connect(socket).is_ok() {
        return Ok(Daemon::Answering);
    }
    let mut child = Command::new(sidecar)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|error| format!("starting {} failed: {error}", sidecar.display()))?;
    let pid = child.id();
    thread::spawn(move || child.wait());
    Ok(Daemon::Started { pid })
}
