use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::thread;
use std::time::Duration;

use exangelos_tray_lib::sidecar::{
    core_candidates, debug_report, ensure_daemon, find_core, Daemon,
};
use std::ffi::OsStr;
use std::path::PathBuf;

const DEADLINE: Duration = Duration::from_secs(5);

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

    assert_eq!(
        ensure_daemon(&socket, &sidecar, DEADLINE),
        Ok(Daemon::Answering)
    );
    thread::sleep(Duration::from_millis(200));
    assert!(!directory.path().join("started").exists());
}

#[test]
fn starts_the_service_through_the_sidecar_when_the_socket_is_silent() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("daemon.sock");
    let sidecar = fake_sidecar(directory.path());

    assert_eq!(
        ensure_daemon(&socket, &sidecar, DEADLINE),
        Ok(Daemon::Started)
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("started")).unwrap(),
        "service status\n"
    );
}

#[test]
fn reports_the_sidecar_message_when_the_start_fails() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("daemon.sock");
    let sidecar = directory.path().join("exangelos");
    fs::write(
        &sidecar,
        "#!/bin/sh\necho 'No Exangelos daemon is running, and starting it failed: refused.' >&2\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(
        ensure_daemon(&socket, &sidecar, DEADLINE),
        Err("No Exangelos daemon is running, and starting it failed: refused.".to_string())
    );
}

#[test]
fn reports_a_missing_sidecar() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("daemon.sock");

    assert!(ensure_daemon(&socket, &directory.path().join("exangelos"), DEADLINE).is_err());
}

#[test]
fn kills_a_sidecar_that_outlives_the_deadline() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("daemon.sock");
    let sidecar = directory.path().join("exangelos");
    fs::write(&sidecar, "#!/bin/sh\nexec sleep 30\n").unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).unwrap();

    let error = ensure_daemon(&socket, &sidecar, Duration::from_millis(300)).unwrap_err();
    assert!(error.contains("did not finish within"), "{error}");
}

fn script(directory: &Path, body: &str) -> std::path::PathBuf {
    let sidecar = directory.join("exangelos");
    fs::write(&sidecar, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).unwrap();
    sidecar
}

#[test]
fn makes_a_debug_report_through_the_sidecar() {
    let directory = tempfile::tempdir().unwrap();
    let sidecar = script(
        directory.path(),
        "[ \"$*\" = \"--json debug report\" ] || exit 2\necho '{\"path\":\"/state/reports/r.tar.gz\",\"entries\":[],\"payloads\":false}'",
    );

    assert_eq!(
        debug_report(&sidecar),
        Ok(std::path::PathBuf::from("/state/reports/r.tar.gz"))
    );
}

#[test]
fn reports_why_the_debug_report_failed() {
    let directory = tempfile::tempdir().unwrap();
    let sidecar = script(directory.path(), "echo 'no space left' >&2\nexit 1");

    assert_eq!(debug_report(&sidecar), Err("no space left".to_string()));
}

#[test]
fn looks_for_the_core_next_to_the_tray_then_in_homebrew_the_install_script_folder_and_path() {
    let candidates = core_candidates(
        Some(Path::new("/Applications/Exangelos.app/Contents/MacOS")),
        Some(Path::new("/Users/me")),
        Some(OsStr::new("/usr/local/bin:relative/bin:/Users/me/bin")),
    );
    assert_eq!(
        candidates,
        [
            "/Applications/Exangelos.app/Contents/MacOS/exangelos",
            "/opt/homebrew/bin/exangelos",
            "/usr/local/bin/exangelos",
            "/home/linuxbrew/.linuxbrew/bin/exangelos",
            "/Users/me/.local/bin/exangelos",
            "/Users/me/bin/exangelos",
        ]
        .map(PathBuf::from)
    );
}

#[test]
fn takes_the_first_executable_candidate() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing").join("exangelos");
    let plain = directory.path().join("plain");
    fs::create_dir(&plain).unwrap();
    fs::write(plain.join("exangelos"), "").unwrap();
    let folder = directory.path().join("folder");
    fs::create_dir_all(folder.join("exangelos")).unwrap();
    let installed = directory.path().join("installed");
    fs::create_dir(&installed).unwrap();
    let core = fake_sidecar(&installed);
    let candidates = [
        missing.clone(),
        plain.join("exangelos"),
        folder.join("exangelos"),
        core.clone(),
    ];
    assert_eq!(find_core(&candidates), Ok(core));
    let message = find_core(&candidates[..3]).unwrap_err();
    assert!(
        message.contains("brew install filip-gooddata/exangelos/exangelos"),
        "{message}"
    );
    assert!(message.contains(&plain.display().to_string()), "{message}");
}
