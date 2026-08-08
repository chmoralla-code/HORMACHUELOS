//! A deliberately narrow screenshot bridge for Design mode.
//!
//! This is not part of Computer Use: it never enumerates desktop windows,
//! accepts no window handle, and can only capture a user-selected rectangle in
//! the webview that invoked it. Its only consumer is the Design-mode feature
//! reference attached to the active chat request.

use serde::Deserialize;
use tauri::WebviewWindow;

const MAX_CAPTURE_PIXELS: u64 = 8_000_000;
const MAX_CAPTURE_SIDE: i32 = 4_096;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCaptureRegion {
    /// CSS-pixel origin relative to the app webview's client area.
    pub x: f64,
    pub y: f64,
    /// CSS-pixel dimensions of the explicit feature selection.
    pub width: f64,
    pub height: f64,
    /// The WebView's actual CSS-to-device-pixel scale.
    pub device_pixel_ratio: f64,
}

/// Capture a bounded region in the calling app window for a Design-mode
/// reference image. This is intentionally unavailable as a generic screen or
/// arbitrary-window capture API.
#[tauri::command]
pub fn capture_preview_selection(
    window: WebviewWindow,
    region: PreviewCaptureRegion,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        platform::capture_preview_selection(window, region)
    }

    #[cfg(not(windows))]
    {
        let _ = (window, region);
        Err("Preview feature screenshots are currently available on Windows only.".into())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use base64::Engine;
    use std::mem::size_of;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    fn physical(value: f64, scale: f64, field: &str, allow_zero: bool) -> Result<i32, String> {
        if !value.is_finite() || value < 0.0 || (!allow_zero && value <= 0.0) {
            return Err(format!("Preview capture {field} is invalid."));
        }
        let scaled = (value * scale).round();
        if !scaled.is_finite() || scaled > i32::MAX as f64 {
            return Err(format!("Preview capture {field} is too large."));
        }
        Ok(scaled as i32)
    }

    pub fn capture_preview_selection(
        window: WebviewWindow,
        region: PreviewCaptureRegion,
    ) -> Result<String, String> {
        let scale = region.device_pixel_ratio;
        if !scale.is_finite() || !(0.5..=8.0).contains(&scale) {
            return Err("Preview capture display scale is invalid.".into());
        }

        let x = physical(region.x, scale, "x", true)?;
        let y = physical(region.y, scale, "y", true)?;
        let width = physical(region.width, scale, "width", false)?;
        let height = physical(region.height, scale, "height", false)?;
        if width > MAX_CAPTURE_SIDE || height > MAX_CAPTURE_SIDE {
            return Err("Selected feature is too large to capture safely.".into());
        }
        if (width as u64).saturating_mul(height as u64) > MAX_CAPTURE_PIXELS {
            return Err("Selected feature is too large to capture safely.".into());
        }

        // Tauri's runtime and the direct Windows bindings currently resolve
        // different compatible `windows` crate versions. Convert only the
        // opaque native handle; no ownership or window lookup crosses this
        // boundary.
        let tauri_hwnd = window
            .hwnd()
            .map_err(|error| format!("Could not access the preview window: {error}"))?;
        let hwnd = HWND(tauri_hwnd.0);
        let inner = window
            .inner_position()
            .map_err(|error| format!("Could not locate the preview window: {error}"))?;
        let mut outer = RECT::default();
        unsafe {
            GetWindowRect(hwnd, &mut outer)
                .map_err(|error| format!("Could not locate the preview surface: {error}"))?;
        }
        let full_width = outer.right - outer.left;
        let full_height = outer.bottom - outer.top;
        if full_width <= 0 || full_height <= 0 {
            return Err("The preview window is not available for capture.".into());
        }

        // `inner_position` is the top-left of the webview client area in
        // physical screen pixels. PrintWindow starts at the outer window edge,
        // so translate the user-selected CSS rectangle into that surface.
        let crop_x = i64::from(inner.x) - i64::from(outer.left) + i64::from(x);
        let crop_y = i64::from(inner.y) - i64::from(outer.top) + i64::from(y);
        let right = crop_x + i64::from(width);
        let bottom = crop_y + i64::from(height);
        if crop_x < 0
            || crop_y < 0
            || right > i64::from(full_width)
            || bottom > i64::from(full_height)
        {
            return Err("The selected feature is outside the visible preview.".into());
        }

        unsafe {
            capture_crop_png(
                hwnd,
                full_width,
                full_height,
                crop_x as i32,
                crop_y as i32,
                width,
                height,
            )
        }
    }

    unsafe fn capture_crop_png(
        hwnd: HWND,
        full_width: i32,
        full_height: i32,
        crop_x: i32,
        crop_y: i32,
        crop_width: i32,
        crop_height: i32,
    ) -> Result<String, String> {
        let full_pixels = (full_width as u64).saturating_mul(full_height as u64);
        if full_pixels == 0 || full_pixels > 24_000_000 {
            return Err("Preview window is too large to capture safely.".into());
        }

        let source_dc = GetDC(hwnd);
        if source_dc.0.is_null() {
            return Err("Could not access the preview surface.".into());
        }
        let memory_dc = CreateCompatibleDC(source_dc);
        if memory_dc.0.is_null() {
            let _ = ReleaseDC(hwnd, source_dc);
            return Err("Could not create a preview capture surface.".into());
        }
        let bitmap = CreateCompatibleBitmap(source_dc, full_width, full_height);
        if bitmap.0.is_null() {
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(hwnd, source_dc);
            return Err("Could not create a preview capture bitmap.".into());
        }
        let old_object = SelectObject(memory_dc, HGDIOBJ(bitmap.0));
        if old_object.0.is_null() || old_object.0 as isize == -1 {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(hwnd, source_dc);
            return Err("Could not prepare the preview capture bitmap.".into());
        }

        let result = (|| -> Result<Vec<u8>, String> {
            // PW_RENDERFULLCONTENT (2) captures WebView2 content without ever
            // falling back to a desktop copy, which could include another app.
            let printed = PrintWindow(hwnd, memory_dc, PRINT_WINDOW_FLAGS(2)).as_bool()
                || PrintWindow(hwnd, memory_dc, PRINT_WINDOW_FLAGS(0)).as_bool();
            if !printed {
                return Err("Windows could not capture this preview.".into());
            }

            let mut bitmap_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: full_width,
                    biHeight: -full_height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let full_byte_len = (full_width as usize)
                .checked_mul(full_height as usize)
                .and_then(|pixels| pixels.checked_mul(4))
                .ok_or_else(|| "Preview capture size overflow.".to_string())?;
            let mut bgra = vec![0u8; full_byte_len];
            let rows = GetDIBits(
                memory_dc,
                bitmap,
                0,
                full_height as u32,
                Some(bgra.as_mut_ptr().cast()),
                &mut bitmap_info,
                DIB_RGB_COLORS,
            );
            if rows != full_height {
                return Err("Could not read preview pixels.".into());
            }

            let row_bytes = (crop_width as usize)
                .checked_mul(4)
                .ok_or_else(|| "Preview capture row overflow.".to_string())?;
            let mut rgba = vec![0u8; row_bytes * crop_height as usize];
            let source_stride = full_width as usize * 4;
            for row in 0..crop_height as usize {
                let source_offset = (crop_y as usize + row) * source_stride + crop_x as usize * 4;
                let target_offset = row * row_bytes;
                rgba[target_offset..target_offset + row_bytes]
                    .copy_from_slice(&bgra[source_offset..source_offset + row_bytes]);
            }
            for pixel in rgba.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                pixel[3] = 255;
            }

            let mut png_bytes = Vec::new();
            {
                let mut encoder =
                    png::Encoder::new(&mut png_bytes, crop_width as u32, crop_height as u32);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
                writer
                    .write_image_data(&rgba)
                    .map_err(|error| error.to_string())?;
            }
            Ok(png_bytes)
        })();

        let _ = SelectObject(memory_dc, old_object);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(hwnd, source_dc);

        let png = result?;
        Ok(base64::engine::general_purpose::STANDARD.encode(png))
    }
}
