use std::ffi::OsStr;

use tauri::AppHandle;
#[cfg(target_os = "linux")]
use tauri::Manager;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri_plugin_autostart::ManagerExt;

pub(crate) const STARTUP_ARG: &str = "--autostart";

pub(crate) fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let builder = builder.plugin(
        tauri_plugin_autostart::Builder::new()
            .app_name("Pier")
            .arg(STARTUP_ARG)
            .build(),
    );
    builder
}

/// Only launches from the system startup entry stay in the tray.
pub(crate) fn is_background_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == STARTUP_ARG)
}

#[tauri::command]
pub(crate) fn autostart_status(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        linux::status(&linux::entry_path(&app)?)
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn autostart_set_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let entry = linux::entry_path(&app)?;
        if enabled {
            let executable = std::env::var_os("PIER_PORTABLE_EXECUTABLE")
                .or_else(|| app.env().appimage)
                .map(std::path::PathBuf::from)
                .map(Ok)
                .unwrap_or_else(std::env::current_exe)
                .map_err(|e| e.to_string())?;
            linux::enable(&entry, &executable)?;
        } else {
            linux::disable(&entry)?;
        }
        linux::status(&entry)
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let manager = app.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        if enabled {
            quote_windows_startup_command().map_err(|e| e.to_string())?;
        }
        manager.is_enabled().map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
fn quote_windows_startup_command() -> std::io::Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    // auto-launch 0.5 writes the executable without quotes. Keep its registration
    // and Task Manager handling, but make paths such as Program Files launchable.
    let executable = std::env::current_exe()?;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            KEY_SET_VALUE,
        )?
        .set_value(
            "Pier",
            &format!("\"{}\" {STARTUP_ARG}", executable.display()),
        )
}

// Use an XDG entry on Linux: the generic plugin ignores XDG_CONFIG_HOME and does
// not quote executable paths, which breaks AppImages in directories with spaces.
#[cfg(target_os = "linux")]
mod linux {
    use std::fs;
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};

    use tauri::{AppHandle, Manager};

    use super::STARTUP_ARG;

    pub(super) fn entry_path(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .config_dir()
            .map(|dir| dir.join("autostart/dev.pier.desktop.desktop"))
            .map_err(|e| e.to_string())
    }

    pub(super) fn status(entry: &Path) -> Result<bool, String> {
        let text = match fs::read_to_string(entry) {
            Ok(text) => text,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.to_string()),
        };
        let mut desktop_entry = false;
        let mut found_entry = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                desktop_entry = line == "[Desktop Entry]";
                found_entry |= desktop_entry;
            } else if desktop_entry {
                if let Some((key, value)) = line.split_once('=') {
                    if matches!(
                        (key.trim(), value.trim()),
                        ("Hidden", "true") | ("X-GNOME-Autostart-enabled", "false")
                    ) {
                        return Ok(false);
                    }
                }
            }
        }
        Ok(found_entry)
    }

    fn quoted_executable(executable: &Path) -> Result<String, String> {
        let path = executable.to_str().ok_or("应用路径不是有效的 UTF-8")?;
        if !executable.is_absolute() || path.contains(['\n', '\r']) {
            return Err("应用路径必须是绝对路径且不能包含换行".into());
        }
        // Exec is parsed twice: desktop-entry string escapes, then command-line
        // quoting. Percent signs must also escape Exec field-code expansion.
        let mut quoted = String::from("\"");
        for ch in path.chars() {
            match ch {
                '\\' => quoted.push_str("\\\\\\\\"),
                '"' | '`' | '$' => {
                    quoted.push_str("\\\\");
                    quoted.push(ch);
                }
                '%' => quoted.push_str("%%"),
                _ => quoted.push(ch),
            }
        }
        quoted.push('"');
        Ok(quoted)
    }

    pub(super) fn enable(entry: &Path, executable: &Path) -> Result<(), String> {
        let exec = quoted_executable(executable)?;
        let parent = entry.parent().ok_or("无法确定启动项目录")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        fs::write(
            entry,
            format!(
                "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Pier\nExec={exec} {STARTUP_ARG}\nTerminal=false\nStartupNotify=false\n"
            ),
        )
        .map_err(|e| e.to_string())
    }

    pub(super) fn disable(entry: &Path) -> Result<(), String> {
        match fs::remove_file(entry) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct TestDir(PathBuf);

        impl TestDir {
            fn new() -> Self {
                static NEXT: AtomicUsize = AtomicUsize::new(0);
                let dir = std::env::temp_dir().join(format!(
                    "pier-autostart-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&dir).unwrap();
                Self(dir)
            }
        }

        impl Drop for TestDir {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn creates_and_removes_only_piers_startup_entry() {
            let dir = TestDir::new();
            let entry = dir.0.join("config/autostart/dev.pier.desktop.desktop");
            assert!(!status(&entry).unwrap());
            enable(&entry, Path::new("/home/user/My Apps/Pier.AppImage")).unwrap();
            let text = fs::read_to_string(&entry).unwrap();
            assert!(text.contains("Exec=\"/home/user/My Apps/Pier.AppImage\" --autostart\n"));
            assert!(status(&entry).unwrap());
            let other = entry.with_file_name("other.desktop");
            fs::write(&other, "other app").unwrap();
            disable(&entry).unwrap();
            disable(&entry).unwrap();
            assert!(!status(&entry).unwrap());
            assert_eq!(fs::read_to_string(other).unwrap(), "other app");
        }

        #[test]
        fn reflects_external_changes_and_reports_filesystem_errors() {
            let dir = TestDir::new();
            let entry = dir.0.join("Pier.desktop");
            for disabled in ["Hidden=true", "X-GNOME-Autostart-enabled=false"] {
                fs::write(&entry, format!("[Desktop Entry]\n{disabled}\n")).unwrap();
                assert!(!status(&entry).unwrap());
            }
            fs::write(
                &entry,
                "[Desktop Entry]\nType=Application\n[Desktop Action Open]\nHidden=true\n",
            )
            .unwrap();
            assert!(status(&entry).unwrap());
            fs::remove_file(&entry).unwrap();
            fs::create_dir(&entry).unwrap();
            assert!(status(&entry).is_err());
            assert!(enable(&entry, Path::new("/opt/Pier")).is_err());
            assert!(disable(&entry).is_err());
        }

        #[test]
        fn escapes_exec_metacharacters_and_rejects_entry_injection() {
            assert_eq!(
                quoted_executable(Path::new("/Apps/Pier $`\"\\%.AppImage")).unwrap(),
                "\"/Apps/Pier \\\\$\\\\`\\\\\"\\\\\\\\%%.AppImage\""
            );
            assert!(quoted_executable(Path::new("/Apps/Pier\nHidden=true")).is_err());
            assert!(quoted_executable(Path::new("Pier.AppImage")).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_startup_argument_hides_the_window() {
        assert!(is_background_launch(["Pier", STARTUP_ARG]));
        assert!(is_background_launch(["Pier", "other", STARTUP_ARG]));
        assert!(!is_background_launch(["Pier"]));
        assert!(!is_background_launch([STARTUP_ARG]));
        assert!(!is_background_launch(["Pier", "--autostart=false"]));
        assert!(!is_background_launch(["/opt/--autostart/Pier"]));
    }
}
