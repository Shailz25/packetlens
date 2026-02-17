mod ipc;
mod sidecar;
mod sidecar_client;
mod system;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .manage(sidecar::SidecarState::default())
    .manage(sidecar_client::SidecarClientState::default())
    .invoke_handler(tauri::generate_handler![
      sidecar::start_sidecar,
      sidecar::stop_sidecar,
      sidecar_client::start_sidecar_listener,
      sidecar_client::send_proxy_command,
      system::open_cert_folder,
      system::install_cert,
      system::uninstall_cert,
      system::open_browser
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
