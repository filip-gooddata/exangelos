use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
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
/// CLI's message; a CLI still running at `deadline` is killed.
pub fn ensure_daemon(socket: &Path, sidecar: &Path, deadline: Duration) -> Result<Daemon, String> {
    if UnixStream::connect(socket).is_ok() {
        return Ok(Daemon::Answering);
    }
    let mut child = Command::new(sidecar)
        .args(["service", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("starting {} failed: {error}", sidecar.display()))?;
    let until = Instant::now() + deadline;
    while child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{} service status did not finish within {} s",
                sidecar.display(),
                deadline.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(Daemon::Started);
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if message.is_empty() {
        format!(
            "{} service status failed: {}",
            sidecar.display(),
            output.status
        )
    } else {
        message
    })
}
