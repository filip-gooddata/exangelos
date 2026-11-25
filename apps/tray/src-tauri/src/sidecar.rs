use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
pub const CORE: &str = "exangelos";

#[derive(Debug, PartialEq, Eq)]
pub enum Daemon {
    Answering,
    Started,
}

/// Where the tray looks for the `exangelos` core, in order: next to the tray
/// executable (the Linux package and a development bundle ship it there), the
/// Homebrew prefixes, the install script's `~/.local/bin`, then `PATH`. The
/// signed macOS app holds no core, so there it comes from the formula the
/// cask depends on.
pub fn core_candidates(
    host_directory: Option<&Path>,
    home: Option<&Path>,
    path: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = host_directory.map(Path::to_path_buf).into_iter().collect();
    directories.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/home/linuxbrew/.linuxbrew/bin",
        ]
        .iter()
        .map(PathBuf::from),
    );
    directories.extend(home.map(|home| home.join(".local").join("bin")));
    directories.extend(
        path.map(|path| {
            std::env::split_paths(path)
                .filter(|entry| entry.is_absolute())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default(),
    );
    let mut candidates: Vec<PathBuf> = Vec::new();
    for directory in directories {
        let candidate = directory.join(CORE);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// The first candidate that is an executable file.
pub fn find_core(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    candidates
        .iter()
        .find(|candidate| {
            fs::metadata(candidate)
                .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "no exangelos core found; install it with `brew install filip-gooddata/exangelos/exangelos` (looked in {})",
                candidates
                    .iter()
                    .filter_map(|candidate| candidate.parent())
                    .map(|directory| directory.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

pub fn core_path() -> Result<PathBuf, String> {
    let host = std::env::current_exe()
        .map_err(|error| format!("the host executable path is unknown: {error}"))?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path = std::env::var_os("PATH");
    find_core(&core_candidates(
        host.parent(),
        home.as_deref(),
        path.as_deref(),
    ))
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

/// Runs `exangelos --json debug report` and returns the path of the archive it wrote.
pub fn debug_report(sidecar: &Path) -> Result<PathBuf, String> {
    let output = Command::new(sidecar)
        .args(["--json", "debug", "report"])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("starting {} failed: {error}", sidecar.display()))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!(
                "{} debug report failed: {}",
                sidecar.display(),
                output.status
            )
        } else {
            message
        });
    }
    let written: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "{} debug report printed no JSON: {error}",
            sidecar.display()
        )
    })?;
    written["path"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| format!("{} debug report printed no path", sidecar.display()))
}

/// Shows `path` in the file manager: selected in Finder on macOS, its folder elsewhere.
pub fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg("-R").arg(path).status();
    #[cfg(not(target_os = "macos"))]
    let status = Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .status();
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("showing {} failed: {status}", path.display())),
        Err(error) => Err(format!("showing {} failed: {error}", path.display())),
    }
}
