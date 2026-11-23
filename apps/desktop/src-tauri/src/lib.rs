mod appimage_env;
mod autostart;
mod host;
mod html_preview;
#[cfg(target_os = "linux")]
mod linux_graphics;
mod speech;
#[cfg(target_os = "macos")]
mod system_speech;
#[cfg(any(target_os = "windows", target_os = "linux"))]
#[path = "local_speech.rs"]
mod system_speech;
mod terminal;
mod transfer;
mod tray;
mod update_download;
mod update_route;
mod updater;

use host::HostManager;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use terminal::TerminalManager;
use transfer::DownloadManager;
use updater::UpdateManager;

pub use appimage_env::drop_stale_entries as drop_stale_appimage_env;
#[cfg(target_os = "linux")]
pub use linux_graphics::configure as configure_linux_graphics;

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Quit the whole app (the close button only hides the window).
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    if autostart::is_background_launch(std::env::args_os()) {
        if let Some(window) = context
            .config_mut()
            .app
            .windows
            .iter_mut()
            .find(|window| window.label == "main")
        {
            window.visible = false;
            window.focus = false;
        }
    }
    let builder = tauri::Builder::default()
        // Must be registered first: a second launch focuses the running instance instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !autostart::is_background_launch(argv) {
                show_main_window(app);
            }
        }));
    let app = autostart::configure(builder)
        .register_uri_scheme_protocol("pier-preview", |_context, request| {
            html_preview::response(&request)
        })
        .on_permission_request(speech::permission)
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            system_speech::system_speech_authorize,
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            system_speech::system_speech_transcribe,
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            system_speech::system_speech_cancel,
            autostart::autostart_status,
            autostart::autostart_set_enabled,
            host::host_status,
            host::host_logs,
            host::host_restart,
            updater::update_status,
            updater::update_check,
            updater::update_cancel_check,
            updater::update_install,
            updater::update_cancel_install,
            updater::update_set_auto_check,
            updater::update_set_mirror,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_kill_all,
            transfer::download_begin,
            transfer::download_write,
            transfer::download_finish,
            transfer::download_abort,
            quit_app
        ])
        .setup(|app| {
            let manager = HostManager::new(app.handle().clone());
            app.manage(manager.clone());
            app.manage(TerminalManager::default());
            app.manage(DownloadManager::default());
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            app.manage(system_speech::SpeechJobs::default());
            let updates = UpdateManager::new(app.handle().clone());
            app.manage(updates.clone());
            let update_item = tray::create(app.handle())?;
            updates.set_tray_item(update_item);
            manager.start();
            updates.start_scheduler();
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Pier (and running agents) alive in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(context)
        .expect("failed to build the Pier desktop app");

    app.run(|app, event| match event {
        // Only an explicit quit (tray menu / app.exit) ends the process.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        RunEvent::Exit => {
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            app.state::<system_speech::SpeechJobs>().shutdown();
            app.state::<TerminalManager>().kill_all();
            app.state::<HostManager>().shutdown();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app),
        _ => {}
    });
}
