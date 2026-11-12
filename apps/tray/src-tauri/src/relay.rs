//! Byte pipe between the panel and the daemon's unix socket.
//!
//! The relay parses nothing and never reconnects. Each open connection has a
//! reader task that hands every socket read to the connection's sink, then a
//! single `Closed` or `Error` after which the connection is forgotten.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::task::JoinHandle;

const READ_BUFFER: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayEvent {
    Data(Vec<u8>),
    Closed,
    Error(String),
}

struct Connection {
    writer: Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
    reader: JoinHandle<()>,
}

type Connections = Arc<Mutex<HashMap<u32, Connection>>>;

#[derive(Default)]
pub struct Relay {
    connections: Connections,
    next_id: AtomicU32,
}

impl Relay {
    pub async fn open<F>(&self, socket: &Path, sink: F) -> Result<u32, String>
    where
        F: Fn(RelayEvent) + Send + 'static,
    {
        let stream = UnixStream::connect(socket)
            .await
            .map_err(|error| format!("cannot open {}: {error}", socket.display()))?;
        let (mut read_half, write_half) = stream.into_split();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let connections = Arc::clone(&self.connections);

        // The map lock is held while the reader starts, so the reader cannot
        // remove its entry before the entry exists.
        let mut map = self.connections.lock().unwrap();
        let reader = tokio::spawn(async move {
            let mut buffer = vec![0u8; READ_BUFFER];
            let last = loop {
                match read_half.read(&mut buffer).await {
                    Ok(0) => break RelayEvent::Closed,
                    Ok(n) => sink(RelayEvent::Data(buffer[..n].to_vec())),
                    Err(error) => break RelayEvent::Error(error.to_string()),
                }
            };
            connections.lock().unwrap().remove(&id);
            sink(last);
        });
        map.insert(
            id,
            Connection {
                writer: Arc::new(tokio::sync::Mutex::new(write_half)),
                reader,
            },
        );
        Ok(id)
    }

    pub async fn write(&self, id: u32, bytes: &[u8]) -> Result<(), String> {
        let writer = self
            .connections
            .lock()
            .unwrap()
            .get(&id)
            .map(|connection| Arc::clone(&connection.writer))
            .ok_or_else(|| format!("unknown connection {id}"))?;
        let mut writer = writer.lock().await;
        writer
            .write_all(bytes)
            .await
            .map_err(|error| format!("write to connection {id} failed: {error}"))
    }

    /// Forgets the connection without a `Closed` event. Unknown ids are fine.
    /// Writes that already found the connection still finish, and a read already
    /// handed to the sink is still delivered. Later writes get "unknown connection".
    pub fn close(&self, id: u32) {
        if let Some(connection) = self.connections.lock().unwrap().remove(&id) {
            connection.reader.abort();
        }
    }
}
