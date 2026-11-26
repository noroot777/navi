// Navi 的 Windows 壳。三种跑法（参数在建 Tauri 应用之前就分开：后两种不开窗口、也不进单实例）：
//
//   Navi.exe [navi://…]                         窗口。第二次打开时把链接交给已开的那个窗口（单实例）。
//   Navi.exe --start-server                     登录时那一档：确保服务在跑就退出（控制器的 --ensure）。
//   Navi.exe --spawn-detached <日志> <程序> …    控制器起服务时借壳脱离 Job（src/spawn.rs），打印 pid 就退出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod controller;
mod health;
mod notify;
mod paths;
#[cfg(windows)]
mod spawn;
mod tray;
mod update;
mod window;

use std::sync::Arc;

use controller::Shell;
use tauri::Manager;

fn main() {
  let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
  if args.first().is_some_and(|arg| arg == "--spawn-detached") {
    #[cfg(windows)]
    std::process::exit(spawn::run(&args[1..]));
    #[cfg(not(windows))]
    std::process::exit(2);
  }
  if args.iter().any(|arg| arg == "--start-server") {
    std::process::exit(controller::ensure_once());
  }
  let links: Vec<String> = args.iter().filter_map(|arg| arg.to_str()).filter(|arg| is_link(arg)).map(str::to_string).collect();

  let shell = Arc::new(Shell::default());
  let app = tauri::Builder::default()
    // 单实例要最先登记：第二份一起来就把参数交给第一份、自己退出，后面的插件和窗口都不会建。
    .plugin(tauri_plugin_single_instance::init({
      let shell = shell.clone();
      move |app, argv, _cwd| {
        window::front(app);
        for link in argv.iter().filter(|arg| is_link(arg)) {
          shell.send(serde_json::json!({ "type": "link", "url": link }));
        }
      }
    }))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(shell.clone())
    .invoke_handler(tauri::generate_handler![window::shell_screen, window::shell_action, window::page_report, window::page_notify])
    .setup(move |app| {
      let handle = app.handle().clone();
      window::create(&handle, &shell)?;
      tray::create(&handle, &shell)?;
      shell.start(&handle);
      for link in &links {
        shell.send(serde_json::json!({ "type": "link", "url": link }));
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("Navi 起不来");
  app.run(|handle, event| {
    // 关窗不退出（src/window.rs 把关窗改成了藏起来）：托盘里「退出 Navi」才走到这里。服务不归壳管，不停。
    if let tauri::RunEvent::ExitRequested { .. } = event {
      handle.state::<Arc<Shell>>().quit();
    }
  });
}

fn is_link(arg: &str) -> bool {
  arg.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("navi://")) && arg.len() > 7
}
