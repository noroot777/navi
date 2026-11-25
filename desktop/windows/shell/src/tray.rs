// 托盘图标和它的菜单（对应 mac 的应用菜单「Navi」那一栏）。两个勾的样子由控制器推过来（{"type":"menu"}）：
// 「允许其他设备访问」在跑的服务没按设置起时写成「（重启服务后生效）」，点它就是按设置重启；切换途中点不动。
// 勾选框被点时 Windows 自己会先翻一下勾，真实状态等控制器办完再推回来覆盖。
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::controller::Shell;
use crate::window;

pub struct Items {
  remote: CheckMenuItem<tauri::Wry>,
  login: CheckMenuItem<tauri::Wry>,
}

pub fn create(app: &AppHandle, shell: &Arc<Shell>) -> tauri::Result<()> {
  let show = MenuItem::with_id(app, "show", "显示 Navi", true, None::<&str>)?;
  let browser = MenuItem::with_id(app, "openInBrowser", "在浏览器中打开", true, None::<&str>)?;
  let logs = MenuItem::with_id(app, "logs", "日志", true, None::<&str>)?;
  let remote = CheckMenuItem::with_id(app, "toggleRemote", "允许其他设备访问", false, false, None::<&str>)?;
  let login = CheckMenuItem::with_id(app, "toggleLogin", "登录时启动 Navi 服务", false, false, None::<&str>)?;
  let about = MenuItem::with_id(app, "about", "关于 Navi", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出 Navi", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[
    &show,
    &browser,
    &logs,
    &PredefinedMenuItem::separator(app)?,
    &remote,
    &login,
    &PredefinedMenuItem::separator(app)?,
    &about,
    &quit,
  ])?;
  *shell.menu.lock().unwrap() = Some(Items { remote, login });
  let mut tray = TrayIconBuilder::with_id("navi")
    .tooltip("Navi")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event({
      let shell = shell.clone();
      move |app, event| match event.id().as_ref() {
        "show" => window::front(app),
        // 退出的只是壳：服务和 agent 照常跑，下次打开接着用。
        "quit" => app.exit(0),
        id => shell.send(json!({ "type": "menu", "id": id })),
      }
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        window::front(tray.app_handle());
      }
    });
  if let Some(icon) = app.default_window_icon() {
    tray = tray.icon(icon.clone());
  }
  tray.build(app)?;
  Ok(())
}

pub fn update(_app: &AppHandle, shell: &Arc<Shell>, message: &Value) {
  let menu = shell.menu.lock().unwrap();
  let Some(items) = menu.as_ref() else { return };
  for (item, key) in [(&items.remote, "remote"), (&items.login, "login")] {
    let Some(state) = message.get(key) else { continue };
    if let Some(checked) = state.get("checked").and_then(Value::as_bool) { let _ = item.set_checked(checked); }
    if let Some(enabled) = state.get("enabled").and_then(Value::as_bool) { let _ = item.set_enabled(enabled); }
    if let Some(title) = state.get("title").and_then(Value::as_str) { let _ = item.set_text(title); }
  }
}
