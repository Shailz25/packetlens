use std::env;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn home_dir() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("USERPROFILE") {
        return Ok(PathBuf::from(path));
    }
    if let Ok(path) = env::var("HOME") {
        return Ok(PathBuf::from(path));
    }
    Err("Home directory not found".into())
}

fn cert_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".mitmproxy"))
}

fn cert_path() -> Result<PathBuf, String> {
    Ok(cert_dir()?.join("mitmproxy-ca-cert.cer"))
}

#[cfg(target_os = "windows")]
fn browser_candidates(browser: &str) -> Vec<PathBuf> {
    let local_app_data = env::var("LOCALAPPDATA").unwrap_or_default();
    match browser {
        "edge" => vec![
            PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        ],
        "chrome" => vec![
            PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
            PathBuf::from(local_app_data)
                .join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe"),
        ],
        "brave" => vec![
            PathBuf::from(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
            PathBuf::from(r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"),
            PathBuf::from(local_app_data)
                .join("BraveSoftware")
                .join("Brave-Browser")
                .join("Application")
                .join("brave.exe"),
        ],
        "firefox" => vec![
            PathBuf::from(r"C:\Program Files\Mozilla Firefox\firefox.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe"),
        ],
        _ => vec![],
    }
}

#[cfg(target_os = "windows")]
fn resolve_browser_exe(browser: &str) -> Result<PathBuf, String> {
    let normalized = browser.trim().to_lowercase();

    if normalized == "edge" || normalized == "chrome" || normalized == "brave" || normalized == "firefox" {
        for candidate in browser_candidates(&normalized) {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
        return Err(format!("Requested browser '{normalized}' was not found on this PC."));
    }
    Err(format!(
        "Unsupported browser '{browser}'. Choose one of: edge, chrome, firefox, brave."
    ))
}

#[cfg(target_os = "windows")]
fn wait_for_proxy_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok()
            || TcpStream::connect(("localhost", port)).is_ok()
        {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

#[tauri::command]
pub fn open_cert_folder() -> Result<(), String> {
    let dir = cert_dir()?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|err| format!("Failed to open cert folder: {err}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("PacketLens is supported on Windows only.".into())
}

#[tauri::command]
pub fn install_cert() -> Result<(), String> {
    let cert = cert_path()?;
    #[cfg(target_os = "windows")]
    {
        let result = Command::new("certutil")
            .args(["-user", "-addstore", "Root"])
            .arg(cert)
            .output()
            .map_err(|err| format!("Failed to run certutil: {err}"))?;
        if !result.status.success() {
            return Err(String::from_utf8_lossy(&result.stderr).to_string());
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("PacketLens is supported on Windows only.".into())
    }
}

#[tauri::command]
pub fn uninstall_cert() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let result = Command::new("certutil")
            .args(["-user", "-delstore", "Root", "mitmproxy"])
            .output()
            .map_err(|err| format!("Failed to run certutil: {err}"))?;
        if !result.status.success() {
            return Err(String::from_utf8_lossy(&result.stderr).to_string());
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("PacketLens is supported on Windows only.".into())
    }
}

#[tauri::command]
pub fn open_browser(port: u16, browser: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let browser_exe = resolve_browser_exe(&browser)?;
        if !wait_for_proxy_port(port, Duration::from_secs(12)) {
            return Err(format!(
                "Proxy is not ready on 127.0.0.1:{port}. Click Start Capture, wait for Running status, then retry."
            ));
        }
        let profile_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("Clock error: {e}"))?
            .as_millis();
        let profile_dir = env::temp_dir().join(format!("packetlens-browser-profile-{profile_id}"));

        Command::new(browser_exe)
            .args([
                format!("--proxy-server=127.0.0.1:{port}"),
                "--proxy-bypass-list=localhost;127.0.0.1;::1".to_string(),
                "--disable-quic".to_string(),
                format!("--user-data-dir={}", profile_dir.display()),
                "--no-first-run".to_string(),
                "--new-window".to_string(),
                "about:blank".to_string(),
            ])
            .spawn()
            .map_err(|err| format!("Failed to open browser with proxy: {err}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("PacketLens is supported on Windows only.".into())
    }
}
