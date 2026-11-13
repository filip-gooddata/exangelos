use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use exangelos_tray_lib::sidecar::{ensure_daemon, Daemon};

fn fake_sidecar(directory: &Path) -> std::path::PathBuf {
    let sidecar = directory.join("exangelos");
    let marker = directory.join("started");
    fs::write(
        &sidecar,
        format!(
            "#!/bin/sh\necho \"$@\" > '{0}.part' && mv '{0}.part' '{0}'\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).unwrap();
    sidecar
}

#[test]
fn leaves_an_answering_daemon_alone() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("daemon.sock");
    let _listener = UnixListener::bind(&socket).unwrap();
    let sidecar = fake_sidecar(directory.path());

    assert_eq!(ensure_daemon(&socket, &sidecar), Ok(Daemon::Answering));
    thread::sleep(Duration::from_millis(200));
    assert!(!directory.path().join("started").exists());
}

#[test]
fn starts_the_sidecar_daemon_when_the_socket_is_silent() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("daemon.sock");
    let sidecar = fake_sidecar(directory.path());

    assert!(matches!(
        ensure_daemon(&socket, &sidecar),
        Ok(Daemon::Started { .. })
    ));
    let marker = directory.path().join("started");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_to_string(marker).unwrap(), "daemon\n");
}

#[test]
fn reports_a_missing_sidecar() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("daemon.sock");

    assert!(ensure_daemon(&socket, &directory.path().join("exangelos")).is_err());
}
