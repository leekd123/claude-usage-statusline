// The usage-statusline desktop widget: a small translucent window showing the figures the mod writes to
// widget.json, next to which this program runs (the mod copies it there and starts it with explorer.exe, so
// it outlives Claude). Its own settings are in %APPDATA%\usage-widget\settings.json.
#![windows_subsystem = "windows"]
#![allow(static_mut_refs)]

mod format;

use format::{newer, usage, value, Data, ITEMS};
use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Registry::*;
use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
use windows_sys::Win32::UI::Controls::Dialogs::*;
use windows_sys::Win32::UI::HiDpi::*;
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const CLASS: &str = "UsageStatuslineWidget";
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "UsageStatuslineWidget";
// The mod writes widget.json at least each minute while a session runs; three missed minutes means Claude is gone.
const HEARTBEAT_MS: f64 = 180_000.0;
// Sent by a newer copy starting: close, without marking the widget closed.
const WM_APP_REPLACE: u32 = WM_APP + 1;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    items: Vec<String>,
    horizontal: bool,
    bars: bool, // a bar under each usage item
    bar_size: u32, // its thickness in pixels at 100% scaling
    font: String,
    font_size: f64,
    bold: bool,
    theme: String, // dark, light, system, custom
    text_color: u32, // COLORREF, 0x00BBGGRR; used by the custom theme
    back_color: u32,
    opacity: u32, // percent
    topmost: bool,
    close_with_claude: bool,
    start_with_windows: bool,
    x: Option<i32>,
    y: Option<i32>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            items: ["limit5", "reset5", "limit7", "reset7"].map(String::from).to_vec(),
            horizontal: true,
            bars: true,
            bar_size: 3,
            font: "Segoe UI".into(),
            font_size: 10.0,
            bold: false,
            theme: "system".into(),
            text_color: 0x00F0F0F0,
            back_color: 0x00202020,
            opacity: 85,
            topmost: true,
            close_with_claude: false,
            start_with_windows: false,
            x: None,
            y: None,
        }
    }
}

struct App {
    hwnd: HWND,
    dir: PathBuf,
    settings: Settings,
    settings_mtime: Option<SystemTime>,
    data: Data,
    data_mtime: Option<SystemTime>,
    seen_claude: bool,
    grace_until: f64,
    font: HFONT,
    // label column width, value column width per shown item (vertical uses the widest), line height, padding
    layout: Vec<(String, String, i32, i32)>,
    line: i32,
    pad: i32,
    bar: i32, // thickness at the window's DPI, 0 for none
    row: i32, // a line of text and the bar beneath it
}

static mut APP: Option<App> = None;
fn app() -> &'static mut App {
    unsafe { APP.as_mut().unwrap() }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn mtime(path: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn settings_path() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("usage-widget").join("settings.json")
}

fn load_settings() -> Settings {
    std::fs::read_to_string(settings_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_settings() {
    let a = app();
    let path = settings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&a.settings) {
        let _ = std::fs::write(&path, text);
    }
    a.settings_mtime = mtime(&path);
}

// A file cut off mid-write does not parse: the figures stay as they were until the next read.
fn load_data() -> bool {
    let a = app();
    let path = a.dir.join("widget.json");
    let m = mtime(&path);
    if m.is_none() || m == a.data_mtime {
        return false;
    }
    match std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Data>(&t).ok()) {
        Some(d) => {
            a.data = d;
            a.data_mtime = m;
            true
        }
        None => false,
    }
}

fn system_light() -> bool {
    let mut value: u32 = 0;
    let mut size = 4u32;
    let key = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let name = wide("AppsUseLightTheme");
    let ok = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD, null_mut(), &mut value as *mut u32 as *mut c_void, &mut size)
    };
    ok == ERROR_SUCCESS && value == 1
}

// text, background
fn colors(s: &Settings) -> (u32, u32) {
    let light = match s.theme.as_str() {
        "custom" => return (s.text_color, s.back_color),
        "light" => true,
        "dark" => false,
        _ => system_light(),
    };
    if light {
        (0x00202020, 0x00F5F5F5)
    } else {
        (0x00F0F0F0, 0x00202020)
    }
}

// `tenths` of a, the rest b: 6 for the labels, 2 for a bar's track.
fn blend(a: u32, b: u32, tenths: u32) -> u32 {
    let ch = |s: u32| ((a >> s & 0xFF) * tenths + (b >> s & 0xFF) * (10 - tenths)) / 10;
    ch(0) | ch(8) << 8 | ch(16) << 16
}

// The bar's fill: green, amber from 70%, red from 90%.
fn level(percent: f64) -> u32 {
    if percent >= 90.0 {
        0x005548E8
    } else if percent >= 70.0 {
        0x0000A5FF
    } else {
        0x0050AF4C
    }
}

fn set_run_key(on: bool) {
    let key = wide(RUN_KEY);
    let name = wide(RUN_VALUE);
    unsafe {
        if on {
            let exe = std::env::current_exe().unwrap_or_default();
            let cmd = wide(&format!("\"{}\"", exe.display()));
            RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, cmd.as_ptr() as *const c_void, (cmd.len() * 2) as u32);
        } else {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr());
        }
    }
}

fn text_size(dc: HDC, s: &str) -> SIZE {
    let w: Vec<u16> = s.encode_utf16().collect();
    let mut size = SIZE { cx: 0, cy: 0 };
    unsafe { GetTextExtentPoint32W(dc, w.as_ptr(), w.len() as i32, &mut size) };
    size
}

// The font at the window's DPI, each shown cell's widths from its widest value, and the window's size. The
// size changes only here: on a change of items, font, layout or DPI, never as the figures change.
fn relayout() {
    let a = app();
    let dpi = unsafe { GetDpiForWindow(a.hwnd) }.max(96) as f64;
    let mut lf: LOGFONTW = unsafe { std::mem::zeroed() };
    lf.lfHeight = -(a.settings.font_size * dpi / 72.0).round() as i32;
    lf.lfWeight = if a.settings.bold { 700 } else { 400 };
    lf.lfQuality = CLEARTYPE_QUALITY as u8;
    for (i, c) in a.settings.font.encode_utf16().take(31).enumerate() {
        lf.lfFaceName[i] = c;
    }
    unsafe {
        if !a.font.is_null() {
            DeleteObject(a.font);
        }
        a.font = CreateFontIndirectW(&lf);
    }
    let dc = unsafe { GetDC(a.hwnd) };
    let old = unsafe { SelectObject(dc, a.font) };
    let line = text_size(dc, "Ag").cy;
    a.line = line;
    a.pad = line / 2;
    a.layout = ITEMS
        .iter()
        .filter(|(id, _, _)| a.settings.items.iter().any(|s| s == id))
        .map(|(id, label, widest)| (id.to_string(), label.to_string(), text_size(dc, label).cx, text_size(dc, widest).cx))
        .collect();
    let usage_shown = a.layout.iter().any(|(id, _, _, _)| id.starts_with("limit"));
    a.bar = if a.settings.bars && usage_shown { (a.settings.bar_size as f64 * dpi / 96.0).round().max(1.0) as i32 } else { 0 };
    a.row = if a.bar > 0 { line + a.bar + a.bar / 2 + 1 } else { line };
    unsafe {
        SelectObject(dc, old);
        ReleaseDC(a.hwnd, dc);
    }
    let gap = a.pad;
    let (w, h) = if a.layout.is_empty() {
        (line * 4, line + 2 * a.pad)
    } else if a.settings.horizontal {
        let cells: i32 = a.layout.iter().map(|(_, _, l, v)| l + gap / 2 + v).sum();
        (cells + gap * (a.layout.len() as i32 - 1) * 2 + 2 * a.pad, a.row + 2 * a.pad)
    } else {
        let l = a.layout.iter().map(|x| x.2).max().unwrap_or(0);
        let v = a.layout.iter().map(|x| x.3).max().unwrap_or(0);
        (l + gap * 2 + v + 2 * a.pad, a.row * a.layout.len() as i32 + 2 * a.pad)
    };
    place(w, h);
}

// Resizes, keeping the edge of the screen the widget sits against, and back on a screen if it is off all of them.
fn place(w: i32, h: i32) {
    let a = app();
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetWindowRect(a.hwnd, &mut r) };
    let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    unsafe { GetMonitorInfoW(MonitorFromWindow(a.hwnd, MONITOR_DEFAULTTONEAREST), &mut mi) };
    let work = mi.rcWork;
    let near = a.line;
    let mut x = if (work.right - r.right).abs() <= near { r.right - w } else { r.left };
    let mut y = if (work.bottom - r.bottom).abs() <= near { r.bottom - h } else { r.top };
    x = x.clamp(work.left, (work.right - w).max(work.left));
    y = y.clamp(work.top, (work.bottom - h).max(work.top));
    let after = if a.settings.topmost { HWND_TOPMOST } else { HWND_NOTOPMOST };
    unsafe {
        SetWindowPos(a.hwnd, after, x, y, w, h, SWP_NOACTIVATE);
        InvalidateRect(a.hwnd, null(), 0);
    }
}

fn apply_look() {
    let a = app();
    let alpha = (a.settings.opacity.clamp(20, 100) * 255 / 100) as u8;
    unsafe { SetLayeredWindowAttributes(a.hwnd, 0, alpha, LWA_ALPHA) };
    relayout();
}

fn paint(hwnd: HWND) {
    let a = app();
    let mut ps: PAINTSTRUCT = unsafe { std::mem::zeroed() };
    let dc = unsafe { BeginPaint(hwnd, &mut ps) };
    let mut rc = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetClientRect(hwnd, &mut rc) };
    let (text, back) = colors(&a.settings);
    let now = now_ms();
    unsafe {
        // Drawn off screen, then copied in one go, so a redraw never flickers.
        let mem = CreateCompatibleDC(dc);
        let bmp = CreateCompatibleBitmap(dc, rc.right, rc.bottom);
        let old_bmp = SelectObject(mem, bmp);
        let brush = CreateSolidBrush(back);
        FillRect(mem, &rc, brush);
        DeleteObject(brush);
        let old_font = SelectObject(mem, a.font);
        SetBkMode(mem, TRANSPARENT as _);
        let out = |x: i32, y: i32, s: &str, color: u32| {
            let w: Vec<u16> = s.encode_utf16().collect();
            SetTextColor(mem, color);
            TextOutW(mem, x, y, w.as_ptr(), w.len() as i32);
        };
        // Under a usage item's line, across the whole item, label and figure: the item's window at 100%.
        let bar = |left: i32, right: i32, top: i32, id: &str| {
            let Some(p) = usage(id, &a.data, now).filter(|_| a.bar > 0) else { return };
            let r = RECT { left, top: top + a.line, right, bottom: top + a.line + a.bar };
            let track = CreateSolidBrush(blend(text, back, 2));
            FillRect(mem, &r, track);
            DeleteObject(track);
            let fill = CreateSolidBrush(level(p));
            FillRect(mem, &RECT { right: left + ((right - left) as f64 * p / 100.0).round() as i32, ..r }, fill);
            DeleteObject(fill);
        };
        let gap = a.pad;
        if a.layout.is_empty() {
            out(a.pad, a.pad, "…", blend(text, back, 6));
        } else if a.settings.horizontal {
            let mut x = a.pad;
            for (id, label, lw, vw) in &a.layout {
                out(x, a.pad, label, blend(text, back, 6));
                let v = value(id, &a.data, now);
                let right = x + lw + gap / 2 + vw;
                out(right - text_size(mem, &v).cx, a.pad, &v, text);
                bar(x, right, a.pad, id);
                x = right + gap * 2;
            }
        } else {
            let right = rc.right - a.pad;
            for (i, (id, label, _, _)) in a.layout.iter().enumerate() {
                let y = a.pad + a.row * i as i32;
                out(a.pad, y, label, blend(text, back, 6));
                let v = value(id, &a.data, now);
                out(right - text_size(mem, &v).cx, y, &v, text);
                bar(a.pad, right, y, id);
            }
        }
        BitBlt(dc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
        SelectObject(mem, old_font);
        SelectObject(mem, old_bmp);
        DeleteObject(bmp);
        DeleteDC(mem);
        EndPaint(hwnd, &ps);
    }
}

// Each second: new figures, the countdowns, settings changed in the file by hand, and Claude's heartbeat.
fn tick() {
    let a = app();
    load_data();
    let path = settings_path();
    let m = mtime(&path);
    if m.is_some() && m != a.settings_mtime {
        a.settings = load_settings();
        a.settings_mtime = m;
        apply_look();
    }
    let now = now_ms();
    if now - a.data.at <= HEARTBEAT_MS {
        a.seen_claude = true;
    } else if a.settings.close_with_claude && a.seen_claude && now > a.grace_until {
        // Claude was running and is gone. Not closed by the person, so the next session starts it again.
        unsafe { DestroyWindow(a.hwnd) };
        return;
    }
    unsafe { InvalidateRect(a.hwnd, null(), 0) };
}

fn open_stats() {
    let a = app();
    if a.data.stats.is_empty() || !PathBuf::from(&a.data.stats).exists() {
        return;
    }
    let file = wide(&a.data.stats);
    let verb = wide("open");
    unsafe { ShellExecuteW(null_mut(), verb.as_ptr(), file.as_ptr(), null(), null(), SW_SHOWNORMAL) };
}

fn choose_color(current: u32) -> Option<u32> {
    static mut CUSTOM: [u32; 16] = [0x00FFFFFF; 16];
    let mut cc: CHOOSECOLORW = unsafe { std::mem::zeroed() };
    cc.lStructSize = std::mem::size_of::<CHOOSECOLORW>() as u32;
    cc.hwndOwner = app().hwnd;
    cc.rgbResult = current;
    cc.lpCustColors = unsafe { CUSTOM.as_mut_ptr() };
    cc.Flags = CC_RGBINIT | CC_FULLOPEN;
    (unsafe { ChooseColorW(&mut cc) } != 0).then_some(cc.rgbResult)
}

fn choose_font() {
    let a = app();
    let mut lf: LOGFONTW = unsafe { std::mem::zeroed() };
    lf.lfHeight = -(a.settings.font_size * 96.0 / 72.0).round() as i32;
    lf.lfWeight = if a.settings.bold { 700 } else { 400 };
    for (i, c) in a.settings.font.encode_utf16().take(31).enumerate() {
        lf.lfFaceName[i] = c;
    }
    let mut cf: CHOOSEFONTW = unsafe { std::mem::zeroed() };
    cf.lStructSize = std::mem::size_of::<CHOOSEFONTW>() as u32;
    cf.hwndOwner = a.hwnd;
    cf.lpLogFont = &mut lf;
    cf.Flags = CF_INITTOLOGFONTSTRUCT | CF_SCREENFONTS | CF_NOVERTFONTS;
    if unsafe { ChooseFontW(&mut cf) } == 0 {
        return;
    }
    let end = lf.lfFaceName.iter().position(|&c| c == 0).unwrap_or(32);
    a.settings.font = String::from_utf16_lossy(&lf.lfFaceName[..end]);
    a.settings.font_size = (cf.iPointSize as f64 / 10.0).max(6.0);
    a.settings.bold = lf.lfWeight >= 600;
}

// Menu ids: items are 100 + their index.
const ID_HORIZONTAL: usize = 200;
const ID_VERTICAL: usize = 201;
const ID_FONT: usize = 202;
const ID_BARS: usize = 205;
const ID_BAR_SIZE: usize = 260; // + index in BAR_SIZES
const ID_TEXT: usize = 203;
const ID_BACK: usize = 204;
const ID_THEME: usize = 210; // + 0 system, 1 dark, 2 light
const ID_OPACITY: usize = 220; // + 0 70%, 1 85%, 2 100%
const ID_TOPMOST: usize = 230;
const ID_CLOSE_WITH_CLAUDE: usize = 231;
const ID_STARTUP: usize = 232;
const ID_STATS: usize = 240;
const ID_EXIT: usize = 250;
const THEMES: [(&str, &str); 3] = [("system", "System"), ("dark", "Dark"), ("light", "Light")];
const OPACITIES: [u32; 3] = [70, 85, 100];
const BAR_SIZES: [(u32, &str); 4] = [(2, "Thin"), (3, "Medium"), (5, "Thick"), (8, "Extra thick")];

fn menu() {
    let a = app();
    let s = &a.settings;
    let check = |on: bool| if on { MF_CHECKED } else { MF_UNCHECKED };
    unsafe {
        let m = CreatePopupMenu();
        let add = |m: HMENU, flags: u32, id: usize, text: &str| {
            let w = wide(text);
            AppendMenuW(m, flags, id, w.as_ptr());
        };
        for (i, (id, label, _)) in ITEMS.iter().enumerate() {
            add(m, check(s.items.iter().any(|x| x == id)), 100 + i, label);
        }
        add(m, MF_SEPARATOR, 0, "");
        let look = CreatePopupMenu();
        add(look, check(s.horizontal), ID_HORIZONTAL, "Horizontal");
        add(look, check(!s.horizontal), ID_VERTICAL, "Vertical");
        add(look, check(s.bars), ID_BARS, "Usage bars");
        let sizes = CreatePopupMenu();
        for (i, (px, name)) in BAR_SIZES.iter().enumerate() {
            add(sizes, check(s.bar_size == *px), ID_BAR_SIZE + i, name);
        }
        add(look, if s.bars { MF_POPUP } else { MF_POPUP | MF_GRAYED }, sizes as usize, "Bar thickness");
        add(look, MF_SEPARATOR, 0, "");
        add(look, MF_STRING, ID_FONT, "Font…");
        for (i, (key, name)) in THEMES.iter().enumerate() {
            add(look, check(s.theme == *key), ID_THEME + i, &format!("{name} theme"));
        }
        add(look, check(s.theme == "custom"), ID_TEXT, "Text color…");
        add(look, check(s.theme == "custom"), ID_BACK, "Background color…");
        add(look, MF_SEPARATOR, 0, "");
        for (i, o) in OPACITIES.iter().enumerate() {
            add(look, check(s.opacity == *o), ID_OPACITY + i, &format!("Opacity {o}%"));
        }
        add(m, MF_POPUP, look as usize, "Appearance");
        add(m, check(s.topmost), ID_TOPMOST, "Always on top");
        add(m, check(s.close_with_claude), ID_CLOSE_WITH_CLAUDE, "Close when Claude closes");
        add(m, check(s.start_with_windows), ID_STARTUP, "Start with Windows");
        add(m, MF_SEPARATOR, 0, "");
        let stats = !a.data.stats.is_empty() && PathBuf::from(&a.data.stats).exists();
        add(m, if stats { MF_STRING } else { MF_GRAYED }, ID_STATS, "Open statistics");
        add(m, MF_STRING, ID_EXIT, "Exit");
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        SetForegroundWindow(a.hwnd);
        let id = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, a.hwnd, null()) as usize;
        DestroyMenu(m);
        command(id);
    }
}

fn command(id: usize) {
    let a = app();
    let s = &mut a.settings;
    match id {
        0 => return,
        100..=199 if id - 100 < ITEMS.len() => {
            let item = ITEMS[id - 100].0.to_string();
            if let Some(i) = s.items.iter().position(|x| *x == item) {
                s.items.remove(i);
            } else {
                // kept in the order the menu lists them
                s.items.push(item);
                s.items.sort_by_key(|x| ITEMS.iter().position(|(id, _, _)| id == x));
            }
        }
        ID_HORIZONTAL => s.horizontal = true,
        ID_VERTICAL => s.horizontal = false,
        ID_BARS => s.bars = !s.bars,
        ID_BAR_SIZE..=263 => s.bar_size = BAR_SIZES[id - ID_BAR_SIZE].0,
        ID_FONT => choose_font(),
        ID_TEXT | ID_BACK => {
            let (text, back) = colors(s);
            let picked = choose_color(if id == ID_TEXT { text } else { back });
            let s = &mut app().settings;
            if let Some(c) = picked {
                (s.text_color, s.back_color) = if id == ID_TEXT { (c, back) } else { (text, c) };
                s.theme = "custom".into();
            }
        }
        ID_THEME..=212 => s.theme = THEMES[id - ID_THEME].0.into(),
        ID_OPACITY..=222 => s.opacity = OPACITIES[id - ID_OPACITY],
        ID_TOPMOST => s.topmost = !s.topmost,
        ID_CLOSE_WITH_CLAUDE => s.close_with_claude = !s.close_with_claude,
        ID_STARTUP => {
            s.start_with_windows = !s.start_with_windows;
            set_run_key(s.start_with_windows);
        }
        ID_STATS => return open_stats(),
        ID_EXIT => {
            // Closed by the person: sessions leave it closed until /usage-widget, or until it starts with Windows.
            let _ = std::fs::write(a.dir.join("widget.closed"), "closed");
            unsafe { DestroyWindow(a.hwnd) };
            return;
        }
        _ => return,
    }
    save_settings();
    apply_look();
}

fn save_position() {
    let a = app();
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetWindowRect(a.hwnd, &mut r) };
    (a.settings.x, a.settings.y) = (Some(r.left), Some(r.top));
    save_settings();
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            paint(hwnd);
            0
        }
        WM_ERASEBKGND => 1,
        // The whole window drags it; a double click opens the statistics, a right click the menu.
        WM_NCHITTEST => HTCAPTION as LRESULT,
        WM_NCLBUTTONDBLCLK => {
            open_stats();
            0
        }
        WM_NCRBUTTONUP => {
            menu();
            0
        }
        WM_CONTEXTMENU | WM_NCRBUTTONDOWN => 0,
        WM_EXITSIZEMOVE => {
            save_position();
            0
        }
        WM_TIMER => {
            tick();
            0
        }
        WM_DPICHANGED => {
            relayout();
            0
        }
        WM_SETTINGCHANGE => {
            InvalidateRect(hwnd, null(), 0);
            0
        }
        // After sleep the heartbeat has not moved for a while: give Claude time to write it again.
        WM_POWERBROADCAST => {
            if wp as u32 == PBT_APMRESUMEAUTOMATIC {
                app().grace_until = now_ms() + HEARTBEAT_MS;
            }
            1
        }
        WM_APP_REPLACE => {
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

// One widget at a time. A copy of the same or an older version brings the running one forward and exits; a
// newer one asks the running one to close and takes its place (after a mod update).
fn single_instance() -> bool {
    let name = wide("Local\\UsageStatuslineWidget");
    let class = wide(CLASS);
    unsafe {
        let mutex = CreateMutexW(null(), 0, name.as_ptr());
        if WaitForSingleObject(mutex, 0) != WAIT_TIMEOUT {
            return true;
        }
        let running = FindWindowW(class.as_ptr(), null());
        let mut title = [0u16; 64];
        let n = GetWindowTextW(running, title.as_mut_ptr(), 64).max(0) as usize;
        let theirs = String::from_utf16_lossy(&title[..n]);
        let theirs = theirs.rsplit(' ').next().unwrap_or("");
        if running.is_null() || !newer(VERSION, theirs) {
            if !running.is_null() {
                SetForegroundWindow(running);
            }
            return false;
        }
        PostMessageW(running, WM_APP_REPLACE, 0, 0);
        WaitForSingleObject(mutex, 5000) != WAIT_TIMEOUT
    }
}

fn main() {
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if !single_instance() {
        return;
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(PathBuf::from).unwrap_or_default();
    // Started (by a session, by Windows or by hand): it is open now, so sessions start it again.
    let _ = std::fs::write(dir.join("widget.closed"), "");
    // Copies of older versions the mod left (a newer one may be about to start): one still running is locked and stays.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let version = name.strip_prefix("usage-widget-").and_then(|n| n.strip_suffix(".exe"));
            if version.is_some_and(|v| newer(VERSION, v)) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let settings = load_settings();
    if settings.start_with_windows {
        set_run_key(true); // this copy's path, after an update
    }
    unsafe {
        APP = Some(App {
            hwnd: null_mut(),
            dir,
            settings_mtime: mtime(&settings_path()),
            settings,
            data: Data::default(),
            data_mtime: None,
            seen_claude: false,
            grace_until: 0.0,
            font: null_mut(),
            layout: vec![],
            line: 0,
            pad: 0,
            bar: 0,
            row: 0,
        });
        let instance = GetModuleHandleW(null());
        let class = wide(CLASS);
        let wc = WNDCLASSW {
            style: CS_DBLCLKS,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: null_mut(),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        let a = app();
        // Bottom right of the main screen until the person moves it.
        let mut work = RECT { left: 0, top: 0, right: 800, bottom: 600 };
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut RECT as *mut c_void, 0);
        let x = a.settings.x.unwrap_or(work.right - 300);
        let y = a.settings.y.unwrap_or(work.bottom - 60);
        let title = wide(&format!("usage-widget {VERSION}"));
        a.hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            x,
            y,
            300,
            40,
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        load_data();
        apply_look();
        ShowWindow(a.hwnd, SW_SHOWNOACTIVATE);
        SetTimer(a.hwnd, 1, 1000, None);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
