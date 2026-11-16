//! App and game pictures for the UI, as `data:` URLs: Steam/Xbox art files
//! as they are, and icons pulled out of .exe/.ico/.dll files at 64 px.

use base64::Engine;
use std::path::Path;

pub fn data_url(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    let (mime, bytes) = match ext.as_str() {
        "png" => ("image/png", std::fs::read(path).ok()?),
        "jpg" | "jpeg" => ("image/jpeg", std::fs::read(path).ok()?),
        "exe" | "ico" | "dll" => ("image/png", exe_icon_png(path, 64)?),
        _ => return None,
    };
    // shortcut: art is passed inline; huge images would bloat IPC, so skip them.
    if bytes.len() > 3_000_000 {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

#[cfg(windows)]
fn exe_icon_png(path: &Path, size: u32) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::Shell::SHDefExtractIconW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut icon = std::ptr::null_mut();
    // SAFETY: `wide` is NUL-terminated; `icon` is a valid out-pointer.
    let hr = unsafe { SHDefExtractIconW(wide.as_ptr(), 0, 0, &mut icon, std::ptr::null_mut(), size) };
    if hr != 0 || icon.is_null() {
        return None;
    }
    // SAFETY: plain Win32 GDI calls on handles we own and release below.
    let rgba = unsafe {
        let mut ii: ICONINFO = std::mem::zeroed();
        let ok = GetIconInfo(icon, &mut ii);
        DestroyIcon(icon);
        if ok == 0 || ii.hbmColor.is_null() {
            if !ii.hbmMask.is_null() {
                DeleteObject(ii.hbmMask);
            }
            return None;
        }
        let mut bm: BITMAP = std::mem::zeroed();
        GetObjectW(ii.hbmColor, std::mem::size_of::<BITMAP>() as i32, &mut bm as *mut _ as *mut _);
        let (w, h) = (bm.bmWidth.max(0) as u32, bm.bmHeight.max(0) as u32);
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w as i32;
        bmi.bmiHeader.biHeight = -(h as i32); // top-down rows
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        let lines = GetDIBits(dc, ii.hbmColor, 0, h, buf.as_mut_ptr() as *mut _, &mut bmi, DIB_RGB_COLORS);
        DeleteDC(dc);
        DeleteObject(ii.hbmColor);
        DeleteObject(ii.hbmMask);
        if lines == 0 || w == 0 {
            return None;
        }
        (w, h, buf)
    };
    let (w, h, mut buf) = rgba;
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2); // BGRA -> RGBA
    }
    // Old icons have no alpha channel at all: make them opaque.
    if buf.chunks_exact(4).all(|p| p[3] == 0) {
        buf.chunks_exact_mut(4).for_each(|p| p[3] = 255);
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&buf).ok()?;
    }
    Some(out)
}

#[cfg(not(windows))]
fn exe_icon_png(_path: &Path, _size: u32) -> Option<Vec<u8>> {
    None
}
