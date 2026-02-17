use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::net::TcpStream;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<Child>>,
}

fn sidecar_script_path(app: &AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let resource_dir: PathBuf = resource_dir;
        let candidate = resource_dir.join("sidecar").join("proxy_service.py");
        if candidate.exists() {
            return candidate;
        }
        let flat_candidate = resource_dir.join("proxy_service.py");
        if flat_candidate.exists() {
            return flat_candidate;
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .unwrap_or(&manifest_dir)
        .join("sidecar")
        .join("proxy_service.py")
}

fn sidecar_binary_path(app: &AppHandle) -> Option<PathBuf> {
    let file_name = if cfg!(target_os = "windows") {
        "packetlens-sidecar.exe"
    } else {
        "packetlens-sidecar"
    };

    if let Ok(resource_dir) = app.path().resource_dir() {
        let resource_dir: PathBuf = resource_dir;
        let candidates = [
            resource_dir.join("sidecar").join(file_name),
            resource_dir.join("dist").join(file_name),
            resource_dir.join(file_name),
        ];
        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            let candidates = [
                dir.join(file_name),
                dir.join("sidecar").join(file_name),
                dir.join("dist").join(file_name),
            ];
            for candidate in candidates {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir.parent().unwrap_or(&manifest_dir);
    let dev_candidate = project_root.join("sidecar").join("dist").join(file_name);
    if dev_candidate.exists() {
        return Some(dev_candidate);
    }

    None
}

fn wait_for_ipc_ready(ipc_port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", ipc_port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(80));
    }
    false
}

#[tauri::command]
pub fn start_sidecar(
    app: AppHandle,
    state: State<SidecarState>,
    ipc_port: u16,
) -> Result<(), String> {
    let mut child_guard = state.child.lock().map_err(|_| "Sidecar lock poisoned")?;
    if child_guard.is_some() {
        return Ok(());
    }

    let mut cmd = if cfg!(target_os = "windows") {
        let binary_path = sidecar_binary_path(&app).ok_or_else(|| {
            "packetlens-sidecar.exe not found. Rebuild and reinstall PacketLens.".to_string()
        })?;
        let mut cmd = Command::new(binary_path);
        cmd.arg("--ipc-port").arg(ipc_port.to_string());
        cmd
    } else if let Some(binary_path) = sidecar_binary_path(&app) {
        let mut cmd = Command::new(binary_path);
        cmd.arg("--ipc-port").arg(ipc_port.to_string());
        cmd
    } else {
        let script_path = sidecar_script_path(&app);
        let mut cmd = Command::new("python");
        cmd.arg(script_path)
            .arg("--ipc-port")
            .arg(ipc_port.to_string());
        cmd
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|err| format!("Failed to start sidecar: {err}"))?;
    // Detect fast startup failures and surface a clear error.
    thread::sleep(Duration::from_millis(600));
    if let Some(status) = child
        .try_wait()
        .map_err(|err| format!("Failed to check sidecar status: {err}"))?
    {
        return Err(format!(
            "Sidecar exited during startup (status: {status}). Check sidecar dependencies/install."
        ));
    }
    if !wait_for_ipc_ready(ipc_port, Duration::from_secs(10)) {
        let _ = child.kill();
        return Err(format!(
            "Sidecar IPC did not become ready on 127.0.0.1:{ipc_port} within timeout."
        ));
    }
    *child_guard = Some(child);
    Ok(())
}

#[tauri::command]
pub fn stop_sidecar(state: State<SidecarState>) -> Result<(), String> {
    let mut child_guard = state.child.lock().map_err(|_| "Sidecar lock poisoned")?;
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
    }
    Ok(())
}
