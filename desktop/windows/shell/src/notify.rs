// 系统通知（对应 mac 的 SystemNotifications.swift）：页面（web/src/lib/systemNotify.ts）收到服务端的 task.notify 后经
// `page_notify` 交过来，这里弹成 Windows 的 toast；点了把窗口拉到前面、打开那个任务（当成一条 navi:// 链接交给控制器，
// 走 deep-link.mjs 那条路）。弹不弹、弹什么字都是服务端和页面定的，这里只管弹。
//
// 来源（AUMID）用包标识 —— 安装包给开始菜单快捷方式写的 AppUserModelID 就是它（Tauri NSIS 模板的 SetLnkAppUserModelId），
// 系统认这个快捷方式才肯弹。便携版没有这个快捷方式，系统不认来源，弹不出来。
//
// 点通知走进程内的 Activated：壳常驻托盘，通知发出去的时候它一定在。toast 对象留着最近一批，留着它点击才回得来；
// 壳重启之后再点通知中心里的旧通知，系统按快捷方式把 Navi 打开（单实例交给开着的那份），不带去哪个任务。
use serde_json::Value;
use tauri::AppHandle;

/// 页面交来的一条。字段不对就不弹；字都截短（toast 本来也只显示几行）。
pub struct Notice {
  pub key: String,
  pub title: String,
  pub subtitle: String,
  pub body: String,
  pub project: Option<String>,
  pub task: Option<String>,
}

fn text(value: &Value, name: &str, max: usize) -> Option<String> {
  value.get(name).and_then(Value::as_str).map(|text| text.chars().take(max).collect())
}

impl Notice {
  pub fn parse(value: &Value) -> Option<Notice> {
    let key = text(value, "key", 400).filter(|key| !key.is_empty())?;
    Some(Notice {
      key,
      title: text(value, "title", 200)?,
      subtitle: text(value, "subtitle", 100).unwrap_or_default(),
      body: text(value, "body", 500)?,
      project: text(value, "project", 80).filter(|id| !id.is_empty()),
      task: text(value, "task", 80).filter(|id| !id.is_empty()),
    })
  }

  /// 点了去哪儿：有项目就是那个任务的 navi:// 链接（控制器按 deep-link.mjs 的规矩校验）；合成的那一条只把窗口拉到前面。
  pub fn link(&self) -> Option<String> {
    let project = self.project.as_deref()?;
    let task = self.task.as_deref().map(|task| format!("&task={}", encode(task))).unwrap_or_default();
    Some(format!("navi://open?project={}{task}", encode(project)))
  }
}

fn encode(value: &str) -> String {
  value.bytes().map(|byte| match byte {
    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
    _ => format!("%{byte:02X}"),
  }).collect()
}

fn escape(text: &str) -> String {
  text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// toast 的 XML。项目名放在署名那一行（标题下面的小字）。
pub fn toast_xml(notice: &Notice) -> String {
  let attribution = if notice.subtitle.is_empty() {
    String::new()
  } else {
    format!(r#"<text placement="attribution">{}</text>"#, escape(&notice.subtitle))
  };
  format!(
    r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text>{attribution}</binding></visual></toast>"#,
    escape(&notice.title),
    escape(&notice.body),
  )
}

/// 系统给 tag 的上限是 64 个字符：同一件事的 key 折成固定长度（几个页面各交一份时按它替换成一条）。
pub fn tag_of(key: &str) -> String {
  let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
  for byte in key.bytes() {
    hash ^= u64::from(byte);
    hash = hash.wrapping_mul(0x0100_0000_01b3);
  }
  format!("{hash:016x}")
}

#[cfg(windows)]
mod native {
  use std::collections::VecDeque;
  use std::sync::Mutex;

  use tauri::AppHandle;
  use windows::core::{IInspectable, HSTRING};
  use windows::Data::Xml::Dom::XmlDocument;
  use windows::Foundation::TypedEventHandler;
  use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

  use super::{tag_of, toast_xml, Notice};
  use crate::{controller, window};

  /// 留着最近这么多条的 toast 对象：放掉了，点通知中心里的它就回不到这个进程。
  const KEEP: usize = 50;
  static SHOWN: Mutex<VecDeque<ToastNotification>> = Mutex::new(VecDeque::new());

  pub fn show(app: &AppHandle, notice: Notice) -> windows::core::Result<()> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(toast_xml(&notice)))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    toast.SetTag(&HSTRING::from(tag_of(&notice.key)))?;
    let link = notice.link();
    let handle = app.clone();
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
      window::front(&handle);
      if let Some(url) = &link {
        controller::state(&handle).send(serde_json::json!({ "type": "link", "url": url }));
      }
      Ok(())
    }))?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app.config().identifier.as_str()))?;
    notifier.Show(&toast)?;
    let mut shown = SHOWN.lock().unwrap();
    shown.push_back(toast);
    while shown.len() > KEEP {
      shown.pop_front();
    }
    Ok(())
  }
}

pub fn show(app: &AppHandle, notice: Notice) {
  #[cfg(windows)]
  if let Err(error) = native::show(app, notice) {
    eprintln!("[navi] 系统通知没弹出来：{error}");
  }
  #[cfg(not(windows))]
  let _ = (app, notice);
}

