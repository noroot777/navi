// 壳和控制器（自带 node 跑的 desktop/windows/launcher/controller-main.mjs）之间的那根管子：一行一条 JSON。
// 控制器决定窗口此刻该是哪一屏、载哪个地址；这里照着做（src/window.rs、src/tray.rs），再把页面和用户的动静交回去。
// 控制器只活在壳的这一次运行里：壳退出 stdin 一断它就退；服务不归它们俩管。
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{paths, tray, update, window};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct Shell {
  stdin: Mutex<Option<ChildStdin>>,
  child: Mutex<Option<Child>>,
  /// 控制器起来之前就有的消息（启动参数里的链接）。
  queued: Mutex<Vec<Value>>,
  quitting: AtomicBool,
  /// 控制器 stderr 的末尾一截：它起来就崩时说给人听。
  stderr_tail: Arc<Mutex<String>>,
  /// 本地那一屏现在该画什么（ui/index.html 载进来时取）。
  pub screen: Mutex<Value>,
  pub page: Mutex<window::Page>,
  pub menu: Mutex<Option<tray::Items>>,
  /// 最近一次查到、还没装的那一版（src/update.rs）。
  pub update: Mutex<Option<tauri_plugin_updater::Update>>,
  /// 在下（或在装）的那一趟：取消和下完去装在这里裁决（src/update.rs）。
  pub download: Mutex<Option<update::Download>>,
}

impl Shell {
  pub fn send(&self, message: Value) {
    let mut stdin = self.stdin.lock().unwrap();
    match stdin.as_mut() {
      Some(pipe) => {
        let _ = writeln!(pipe, "{message}").and_then(|_| pipe.flush());
      }
      None => self.queued.lock().unwrap().push(message),
    }
  }

  /// 起控制器、接上它的输出。起不来就盖一屏说明（带「重试」，按了再起一次）。
  pub fn start(self: &Arc<Self>, app: &AppHandle) {
    let runtime = paths::bundled_runtime();
    let script = paths::controller_script(&runtime);
    if !script.is_file() || !paths::node(&runtime).is_file() {
      return self.fail(app, "找不到自带的 Navi", format!("{} 不完整（缺控制器或 node）。重新装一次 Navi。", runtime.display()));
    }
    let mut command = Command::new(paths::node(&runtime));
    command
      .arg(&script)
      .envs(paths::rehearsal_env().iter().map(|(key, value)| (key, value)))
      .env("NAVI_WIN_SHELL", std::env::current_exe().unwrap_or_default())
      .env("NAVI_WIN_VERSION", app.package_info().version.to_string())
      .env("NAVI_WIN_UPDATES", if update::configured(app) { "1" } else { "0" })
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
    let mut child = match command.spawn() {
      Ok(child) => child,
      Err(error) => return self.fail(app, "Navi 的启动器起不来", format!("{}：{error}", paths::node(&runtime).display())),
    };
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    *self.stdin.lock().unwrap() = child.stdin.take();
    *self.child.lock().unwrap() = Some(child);
    for message in std::mem::take(&mut *self.queued.lock().unwrap()) {
      self.send(message);
    }
    let tail = self.stderr_tail.clone();
    std::thread::spawn(move || {
      let mut buffer = [0u8; 4096];
      let mut reader = stderr;
      while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 { break; }
        let mut text = tail.lock().unwrap();
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
        let keep = text.len().saturating_sub(2000);
        if keep > 0 { *text = text[text.ceil_char_boundary(keep)..].to_string(); }
      }
    });
    let shell = self.clone();
    let app = app.clone();
    std::thread::spawn(move || {
      for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Ok(message) = serde_json::from_str::<Value>(&line) {
          shell.dispatch(&app, message);
        }
      }
      shell.exited(&app);
    });
  }

  fn exited(self: &Arc<Self>, app: &AppHandle) {
    *self.stdin.lock().unwrap() = None;
    update::abandon(self);
    let status = self.child.lock().unwrap().take().and_then(|mut child| child.wait().ok());
    if self.quitting.load(Ordering::SeqCst) {
      return;
    }
    let tail = self.stderr_tail.lock().unwrap().trim().to_string();
    let code = status.and_then(|status| status.code()).map(|code| format!("（退出码 {code}）")).unwrap_or_default();
    self.fail(app, "Navi 的启动器退出了", format!("{code}{}{tail}\n\n服务不受影响；点「重试」再接上。", if tail.is_empty() { "" } else { "\n" }));
  }

  fn fail(self: &Arc<Self>, app: &AppHandle, title: &str, detail: String) {
    let screen = json!({ "kind": "offline", "title": title, "detail": detail, "actions": [{ "id": "shell:restart", "title": "重试" }] });
    window::show_screen(app, self, screen);
    window::reveal(app);
  }

  /// 本地那一屏上的按钮。`shell:` 开头的归壳自己（控制器没了的时候也按得动）。
  pub fn action(self: &Arc<Self>, app: &AppHandle, id: &str) {
    if id == "shell:restart" {
      if self.stdin.lock().unwrap().is_none() {
        self.stderr_tail.lock().unwrap().clear();
        self.start(app);
      }
      return;
    }
    self.send(json!({ "type": "action", "id": id }));
  }

  fn dispatch(self: &Arc<Self>, app: &AppHandle, message: Value) {
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    match message.get("type").and_then(Value::as_str).unwrap_or_default() {
      "screen" => window::show_screen(app, self, message.get("screen").cloned().unwrap_or(Value::Null)),
      "load" => window::load(app, self, &text("url"), message.get("instance").and_then(Value::as_str), message.get("cookie")),
      "route" => window::route(app, &text("route")),
      "reload" => window::eval(app, "location.reload()"),
      "window" => window::size(app, &text("size")),
      "front" => window::front(app),
      "openExternal" => window::open_external(&text("url")),
      "openPath" => window::open_path(&text("path")),
      "menu" => tray::update(app, self, &message),
      "updateCheck" => update::check(app, self, message.get("id").cloned().unwrap_or(Value::Null)),
      "updateInstall" => update::install(self, message.get("id").cloned().unwrap_or(Value::Null), &text("version")),
      "updateCancel" => update::cancel(self, message.get("id").cloned().unwrap_or(Value::Null)),
      "dialog" => {
        let (app, shell, message) = (app.clone(), self.clone(), message.clone());
        std::thread::spawn(move || {
          let index = window::dialog(&app, &message);
          shell.send(json!({ "type": "dialogResult", "id": message.get("id"), "index": index }));
        });
      }
      _ => {}
    }
  }

  pub fn quit(&self) {
    self.quitting.store(true, Ordering::SeqCst);
    // 关掉 stdin 控制器就自己退了。
    *self.stdin.lock().unwrap() = None;
  }
}

/// `--start-server`：控制器的 --ensure 跑一遍、把它的退出码交出去。窗口不开。
pub fn ensure_once() -> i32 {
  let runtime = paths::bundled_runtime();
  let mut command = Command::new(paths::node(&runtime));
  command
    .arg(paths::controller_script(&runtime))
    .arg("--ensure")
    .envs(paths::rehearsal_env().iter().map(|(key, value)| (key, value)))
    .env("NAVI_WIN_SHELL", std::env::current_exe().unwrap_or_default())
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(windows)]
  std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
  command.status().ok().and_then(|status| status.code()).unwrap_or(1)
}

pub fn state(app: &AppHandle) -> Arc<Shell> {
  app.state::<Arc<Shell>>().inner().clone()
}
