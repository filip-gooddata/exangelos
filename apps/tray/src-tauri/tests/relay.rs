use std::time::Duration;

use exangelos_tray_lib::relay::{Relay, RelayEvent};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::mpsc;
use tokio::time::timeout;

async fn next(events: &mut mpsc::UnboundedReceiver<RelayEvent>) -> RelayEvent {
    timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("no relay event within 5 s")
        .expect("sink dropped")
}

#[tokio::test]
async fn passes_bytes_both_ways_and_reports_close() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("daemon.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let relay = Relay::default();
    let (send, mut events) = mpsc::unbounded_channel();

    let id = relay
        .open(&socket, move |event| send.send(event).unwrap())
        .await
        .unwrap();
    let (mut server, _) = listener.accept().await.unwrap();

    relay.write(id, b"ping\n").await.unwrap();
    let mut received = [0u8; 5];
    server.read_exact(&mut received).await.unwrap();
    assert_eq!(&received, b"ping\n");

    server.write_all(b"pong\n").await.unwrap();
    let mut echoed = Vec::new();
    while echoed.len() < 5 {
        match next(&mut events).await {
            RelayEvent::Data(bytes) => echoed.extend(bytes),
            other => panic!("expected data, got {other:?}"),
        }
    }
    assert_eq!(echoed, b"pong\n");

    drop(server);
    assert_eq!(next(&mut events).await, RelayEvent::Closed);
    assert!(relay.write(id, b"late").await.is_err());
}

#[tokio::test]
async fn open_fails_when_no_socket_exists() {
    let dir = tempfile::tempdir().unwrap();
    let error = Relay::default()
        .open(&dir.path().join("daemon.sock"), |_| {})
        .await
        .unwrap_err();
    assert!(error.contains("daemon.sock"), "{error}");
}
