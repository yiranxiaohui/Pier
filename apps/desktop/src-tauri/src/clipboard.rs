//! Copies an image to the system clipboard.
//!
//! The webview decodes the image and sends its RGBA pixels as the raw request body (as a JSON
//! argument they would be several times larger); the size travels in the
//! `Pier-Image-Width` / `Pier-Image-Height` headers.

use std::borrow::Cow;

use tauri::image::Image;
use tauri::ipc::{InvokeBody, Request};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

fn dimension(request: &Request<'_>, header: &str) -> Result<u32, String> {
    request
        .headers()
        .get(header)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("missing or invalid {header} header"))
}

/// The request body as bytes: raw normally, a JSON array when the IPC fell back to `postMessage`.
fn body_bytes<'a>(request: &'a Request<'_>) -> Result<Cow<'a, [u8]>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        InvokeBody::Json(value) => serde_json::from_value::<Vec<u8>>(value.clone())
            .map(Cow::Owned)
            .map_err(|_| "expected raw RGBA image data".to_string()),
    }
}

/// Validate the pixel data against the declared size.
fn check_size(len: usize, width: u32, height: u32) -> Result<(), String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4));
    if expected == Some(len) {
        Ok(())
    } else {
        Err(format!(
            "{len} bytes of image data do not match a {width}x{height} RGBA image"
        ))
    }
}

/// Async so the clipboard is never touched on the main thread (it can deadlock on Linux).
#[tauri::command]
pub async fn clipboard_write_image(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let width = dimension(&request, "pier-image-width")?;
    let height = dimension(&request, "pier-image-height")?;
    let rgba = body_bytes(&request)?;
    check_size(rgba.len(), width, height)?;
    app.clipboard()
        .write_image(&Image::new(&rgba, width, height))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::check_size;

    #[test]
    fn accepts_matching_rgba_data() {
        assert!(check_size(2 * 3 * 4, 2, 3).is_ok());
    }

    #[test]
    fn rejects_mismatched_or_overflowing_sizes() {
        assert!(check_size(2 * 3 * 4 - 1, 2, 3).is_err());
        assert!(check_size(0, u32::MAX, u32::MAX).is_err());
    }
}
