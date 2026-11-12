use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
pub const SIDECAR: &str = "exangelos";

#[derive(Debug, PartialEq, Eq)]
pub enum Daemon {
    Answering,
    Started { pid: u32 },
}
pub fn sidecar_path() -> Result<PathBuf, String> {
    let host = std::env::current_exe()
        .map_err(|error| format!("the host executable path is unknown: {error}"))?;
    let directory = host
        .parent()
        .ok_or("the host executable has no parent directory")?;
    Ok(directory.join(SIDECAR))
}
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
pub fn wait_until_answering(socket: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if UnixStream::connect(socket).is_ok() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}
