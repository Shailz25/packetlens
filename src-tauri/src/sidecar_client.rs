use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::ipc::{ProxyCommand, ProxyEvent};

#[derive(Default)]
pub struct SidecarClientState {
    listener: Mutex<Option<thread::JoinHandle<()>>>,
}

#[tauri::command]
pub fn start_sidecar_listener(
    app: AppHandle,
    state: State<SidecarClientState>,
    ipc_port: u16,
) -> Result<(), String> {
    let mut guard = state.listener.lock().map_err(|_| "Listener lock poisoned")?;
    if guard.is_some() {
        return Ok(());
    }

    let handle = thread::spawn(move || loop {
        match TcpStream::connect(("127.0.0.1", ipc_port)) {
            Ok(stream) => {
                let reader = BufReader::new(stream);
                for line in reader.lines().flatten() {
                    if let Ok(event) = serde_json::from_str::<ProxyEvent>(&line) {
                        let _ = app.emit("proxy-event", event);
                    }
                }
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(800));
            }
        }
    });

    *guard = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn send_proxy_command(ipc_port: u16, command: ProxyCommand) -> Result<(), String> {
    let payload =
        serde_json::to_string(&command).map_err(|e| format!("Serialize failed: {e}"))?;
    let mut last_error = String::new();

    for attempt in 0..15 {
        match TcpStream::connect(("127.0.0.1", ipc_port)) {
            Ok(mut stream) => {
                stream
                    .write_all(format!("{payload}\n").as_bytes())
                    .map_err(|e| format!("Send failed: {e}"))?;
                return Ok(());
            }
            Err(e) => {
                last_error = e.to_string();
                if attempt < 14 {
                    thread::sleep(Duration::from_millis(200));
                }
            }
        }
    }

    Err(format!(
        "Connect failed after retries to 127.0.0.1:{ipc_port}: {last_error}"
    ))
}
