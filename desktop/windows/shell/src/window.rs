// 唯一的主窗口（对应 mac 的 BrowserWindowController 里画的那一半）：一个铺满的 WebView2，有时载着 navi 的页面，
// 有时是壳自己的那一屏（ui/index.html：正在启动、端口被占、首启……）。画哪一屏、载哪个地址都由控制器定。
//
// 和页面的约定照 mac 的 WindowChrome：页面写在 <html data-window-size="setup|work"> 上的那一屏要多大的窗、脚本没载成，
// 由 PAGE_SCRIPT 经 `page_report` 交回来；不认这套约定的文档（没有 navi-window-chrome 那行 meta）读完 <head> 报 titlebar。
// 页面那一份能调的只有 `page_report`：它的权限在载页面时按窗口专用端口现加（ensure_page_capability），本地那一屏的按钮它碰不到。
use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use crate::controller::{self, Shell};
use crate::{health, paths};

pub const LOCAL_HOST: &str = "tauri.localhost";
const SETUP: (f64, f64) = (980.0, 660.0);
const WORK: (f64, f64) = (1440.0, 900.0);

#[derive(Default)]
pub struct Page {
  /// 页面认的是哪一份服务（实例号已经作为 cookie 交给页面）；None = 不认人（连的是别处的 navi）。
  pub bound: Option<String>,
  /// 页面的来源（窗口专用端口那一个）。
  pub origin: Option<String>,
  granted: HashSet<String>,
}

const PAGE_SCRIPT: &str = r#"(() => {
  if (location.hostname === "tauri.localhost" || window.__naviShellReport) return;
  window.__naviShellReport = true;
  const post = (kind) => { try { window.__TAURI_INTERNALS__.invoke("page_report", { kind }); } catch {} };
  // WebView2 在文档刚建出来时就跑这段，那一刻 <html> 还没有（documentElement 是 null）：监听挂在 document 上、
  // 带 subtree，<html> 晚到也收得到；文档读完时再补报一次当前值，防它在监听生效之前就写好了。
  let reported = null;
  const report = () => {
    const size = document.documentElement?.dataset.windowSize;
    if (size && size !== reported) { reported = size; post("size:" + size); }
  };
  const declare = () => {
    if (!document.querySelector("meta[name='navi-window-chrome'][content='overlay'], meta[name='ash-window-chrome'][content='overlay']")) post("titlebar");
    report();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", declare, { once: true });
  else declare();
  new MutationObserver(report).observe(document, { attributes: true, attributeFilter: ["data-window-size"], subtree: true });
  window.addEventListener("error", (event) => {
    if (event.target instanceof HTMLScriptElement) post("broken:" + (event.target.src || "inline"));
  }, true);
})();"#;

pub fn create(app: &AppHandle, shell: &Arc<Shell>) -> tauri::Result<()> {
  let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
    .title("Navi")
    .inner_size(WORK.0, WORK.1)
    .min_inner_size(720.0, 480.0)
    .visible(false)
    .center()
    .background_color(tauri::window::Color(0xEF, 0xEF, 0xF0, 0xFF))
    .initialization_script(PAGE_SCRIPT)
    .on_navigation({
      let shell = shell.clone();
      move |url| allow_navigation(&shell, url)
    })
    .on_new_window({
      let app = app.clone();
      move |url, _features| {
        // window.open 与 target=_blank：同源的就地打开，不另起窗口；预览、外链都走系统浏览器。
        let same = app.state::<Arc<Shell>>().page.lock().unwrap().origin.as_deref() == Some(url.origin().ascii_serialization().as_str());
        if same {
          if let Some(window) = app.get_webview_window("main") { let _ = window.navigate(url); }
        } else {
          open_external(url.as_str());
        }
        NewWindowResponse::Deny
      }
    })
    .on_page_load({
      let shell = shell.clone();
      move |_window, payload| {
        if payload.event() == PageLoadEvent::Started {
          shell.send(json!({ "type": "started", "url": payload.url().as_str() }));
        }
      }
    })
    .on_document_title_changed(|window, title| {
      let _ = window.set_title(if title.trim().is_empty() || title == "index.html" { "Navi" } else { &title });
    });
  if let Some(data) = paths::webview_data() {
    builder = builder.data_directory(data);
  }
  let window = builder.build()?;
  append_user_agent(&window);
  let handle = window.clone();
  window.on_window_event(move |event| {
    // 关窗不退出：navi 是常驻的工作台，像邮件、Slack 那样点托盘图标就回来；托盘里「退出 Navi」才是真退出。
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      let _ = handle.hide();
    }
  });
  Ok(())
}

/// UA 后面补一段 `NaviWin/<版本>`（同 mac 的 `NaviMac/`）：页面据此知道数据那一站已经在壳的那一屏走过了。
fn append_user_agent(window: &WebviewWindow) {
  #[cfg(windows)]
  {
    let version = window.app_handle().package_info().version.to_string();
    let _ = window.with_webview(move |webview| unsafe {
      use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings2;
      use windows::core::{Interface, HSTRING, PWSTR};
      let Ok(core) = webview.controller().CoreWebView2() else { return };
      let Ok(settings) = core.Settings().and_then(|settings| settings.cast::<ICoreWebView2Settings2>()) else { return };
      let mut current = PWSTR::null();
      if settings.UserAgent(&mut current).is_err() { return; }
      let agent = current.to_string().unwrap_or_default();
      let _ = settings.SetUserAgent(&HSTRING::from(format!("{agent} NaviWin/{version}")));
    });
  }
}

/// 主框架要换文档：壳自己的那一屏和 about:blank 放行；窗口的来源要先认人；别的一律交给系统浏览器。
fn allow_navigation(shell: &Arc<Shell>, url: &Url) -> bool {
  if url.host_str() == Some(LOCAL_HOST) || matches!(url.scheme(), "about" | "data" | "blob") {
    return true;
  }
  let (origin, bound) = {
    let page = shell.page.lock().unwrap();
    (page.origin.clone(), page.bound.clone())
  };
  if origin.as_deref() != Some(url.origin().ascii_serialization().as_str()) {
    open_external(url.as_str());
    return false;
  }
  let Some(bound) = bound else { return true };
  let port = url.port_or_known_default().unwrap_or(80);
  let reason = match health::instance_on(port) {
    health::Answer::Instance(Some(id)) if id == bound => return true,
    health::Answer::Unreachable => "unreachable",
    health::Answer::Instance(_) => "changed",
  };
  shell.send(json!({ "type": "navigationBlocked", "url": url.as_str(), "reason": reason }));
  false
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
  app.get_webview_window("main")
}

/// 盖上本地那一屏：页面在着就先撤掉页面（载回 ui/index.html，它载进来时自己取这一屏）。
pub fn show_screen(app: &AppHandle, shell: &Arc<Shell>, screen: Value) {
  *shell.screen.lock().unwrap() = screen.clone();
  let Some(window) = main_window(app) else { return };
  let local = window.url().ok().is_some_and(|url| url.host_str() == Some(LOCAL_HOST));
  if local {
    let _ = window.emit_to("main", "screen", screen);
  } else if let Ok(url) = Url::parse(&format!("http://{LOCAL_HOST}/index.html")) {
    let _ = window.navigate(url);
  }
}

/// 先把实例号写成 cookie（只绑在窗口专用端口那个来源上），再载页面。在控制器那根管子的读线程上跑：
/// WebView2 的 cookie 接口在主线程的同步回调里调会死锁。
pub fn load(app: &AppHandle, shell: &Arc<Shell>, url: &str, instance: Option<&str>, cookie: Option<&Value>) {
  let Ok(target) = Url::parse(url) else { return };
  let Some(window) = main_window(app) else { return };
  let origin = target.origin().ascii_serialization();
  ensure_page_capability(app, shell, &origin);
  {
    let mut page = shell.page.lock().unwrap();
    page.origin = Some(origin);
    page.bound = instance.map(str::to_string);
  }
  if let (Some(name), Some(value), Some(host)) = (
    cookie.and_then(|cookie| cookie.get("name")).and_then(Value::as_str),
    cookie.and_then(|cookie| cookie.get("value")).and_then(Value::as_str),
    target.host_str(),
  ) {
    let cookie = tauri::webview::Cookie::build((name.to_string(), value.to_string())).domain(host.to_string()).path("/").build();
    let _ = window.set_cookie(cookie);
  }
  let _ = window.navigate(target);
}

/// 页面那一份能调 `page_report`，而且只能调它：按来源（窗口专用端口）现加一条权限。
fn ensure_page_capability(app: &AppHandle, shell: &Arc<Shell>, origin: &str) {
  let mut page = shell.page.lock().unwrap();
  if !page.granted.insert(origin.to_string()) {
    return;
  }
  let capability = tauri::ipc::CapabilityBuilder::new(format!("page-{}", page.granted.len()))
    .remote(format!("{origin}/*"))
    .window("main")
    .permission("allow-page-report");
  let _ = app.add_capability(capability);
}

/// 页面在着时原地换路由（同 web 里 git-workbench/navigation.ts 那样推一条历史、发一次 popstate），不重载。
pub fn route(app: &AppHandle, route: &str) {
  let Ok(literal) = serde_json::to_string(route) else { return };
  eval(app, &format!("history.pushState(null, '', {literal}); dispatchEvent(new PopStateEvent('popstate'))"));
}

pub fn eval(app: &AppHandle, script: &str) {
  if let Some(window) = main_window(app) {
    let _ = window.eval(script);
  }
}

/// 首次配置那扇小窗（壳的首启那一屏和随后 web 的三步向导都正好铺满它），进了工作台才展开成工作窗。
pub fn size(app: &AppHandle, size: &str) {
  let Some(window) = main_window(app) else { return };
  let (width, height) = if size == "setup" { SETUP } else { WORK };
  let _ = window.unmaximize();
  let _ = window.set_size(LogicalSize::new(width, height));
  let _ = window.center();
  reveal(app);
}

/// 第一次画出东西时才把窗口亮出来（建窗时是藏着的：免得先闪一扇大窗再缩成首启的小窗）。
pub fn reveal(app: &AppHandle) {
  if let Some(window) = main_window(app) {
    if !window.is_visible().unwrap_or(true) {
      let _ = window.show();
      let _ = window.set_focus();
    }
  }
}

pub fn front(app: &AppHandle) {
  if let Some(window) = main_window(app) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

/// 交给系统默认程序打开。只认网页和邮件链接：页面能发起导航，不能借这里拉起任意程序。
pub fn open_external(url: &str) {
  let Ok(parsed) = Url::parse(url) else { return };
  if matches!(parsed.scheme(), "http" | "https" | "mailto") {
    shell_open(parsed.as_str());
  }
}

pub fn open_path(path: &str) {
  if std::path::Path::new(path).is_dir() {
    shell_open(path);
  }
}

fn shell_open(target: &str) {
  #[cfg(windows)]
  unsafe {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    ShellExecuteW(None, w!("open"), &HSTRING::from(target), None, None, SW_SHOWNORMAL);
  }
  #[cfg(not(windows))]
  let _ = target;
}

/// 原生对话框，返回按下的是第几个按钮（关掉 = 最后一个，按「取消」算）。
pub fn dialog(app: &AppHandle, message: &Value) -> i64 {
  let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
  let buttons: Vec<String> = message.get("buttons").and_then(Value::as_array).map(|list| {
    list.iter().filter_map(Value::as_str).map(str::to_string).collect()
  }).unwrap_or_default();
  let mut builder = app.dialog().message(text("detail")).title(text("title")).kind(MessageDialogKind::Info);
  if let Some(window) = main_window(app).filter(|window| window.is_visible().unwrap_or(false)) {
    builder = builder.parent(&window);
  }
  match buttons.as_slice() {
    [first, second, ..] => {
      let result = builder.buttons(MessageDialogButtons::OkCancelCustom(first.clone(), second.clone())).blocking_show_with_result();
      match result {
        MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
        MessageDialogResult::Custom(label) if &label == first => 0,
        _ => 1,
      }
    }
    [only] => {
      builder.buttons(MessageDialogButtons::OkCustom(only.clone())).blocking_show_with_result();
      0
    }
    [] => {
      builder.blocking_show_with_result();
      0
    }
  }
}

// ── 页面与本地那一屏调的三条命令 ────────────────────────────────────────────

#[tauri::command]
pub fn shell_screen(app: AppHandle) -> Value {
  controller::state(&app).screen.lock().unwrap().clone()
}

#[tauri::command]
pub fn shell_action(app: AppHandle, id: String) {
  controller::state(&app).action(&app, &id);
}

#[tauri::command]
pub fn page_report(app: AppHandle, kind: String) {
  if kind.len() <= 2048 {
    controller::state(&app).send(json!({ "type": "report", "kind": kind }));
  }
}
