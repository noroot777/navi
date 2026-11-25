// 自更新（对应 mac 的 Updater.swift 接 Sparkle 那一段）。检查、下载、验签、交给安装包这几步全在 tauri-plugin-updater
// 里：更新清单（latest.json）只是指路，下载下来的安装包要用编进壳的公钥（tauri.conf.json 的 plugins.updater.pubkey，
// 构建时取 desktop/windows/release.json）验 minisign 签名，签名里还绑着版本号（requireSignedVersion），验不过一律不装。
// 什么时候查、问不问、跳过哪一版由控制器定（launcher/updates.mjs）；这里只按它的话办，再把结果交回去：
//
//   控制器 → 壳  { type: "updateCheck", id }                 查一次
//   壳 → 控制器  { type: "updateResult", id, version?, notes?, error? }   version 为空 = 已经是最新
//   控制器 → 壳  { type: "updateInstall", id, version }      装刚查到的那一版
//   壳 → 控制器  { type: "updateProgress", id, received, percent? }      收到字节就报（至多一秒一次），没有总长度就没有 percent
//                { type: "updateProgress", id, installing: true }        下完了、验签装包，这之后取消不了
//                { type: "updateResult", id, error }                     没装成（装成了壳直接退出，回不来）
//   控制器 → 壳  { type: "updateCancel", id }                不下了（用户点了取消、或者控制器等过了头）
//   壳 → 控制器  { type: "updateCancelResult", id, outcome }  cancelled 收掉了 / installing 已经在装、取消不了 / gone 没有这一趟
//
// 「取消」和「下完去装」由这里裁决，同一把锁、按请求号认人（Download）：先到的那一个算数，另一个照着结果走。控制器
// 只凭 updateCancelResult 下结论，不凭「我发过取消」。控制器没了（stdin 断了）在下的那一趟也收掉，没人等它的结果。
//
// 每一步都有头：查一次最多 30 秒，下载最多 15 分钟、最多 300 MB（安装包几十 MB，超了按坏了的源算），到了就断、
// 回一条 updateResult error，控制器那边放开状态、页面回来。
//
// 装的时候插件把安装包交给系统（/UPDATE /P /R：不再问、装完重新打开 Navi）就让壳退出。换的只是安装目录里的壳和
// 运行时发布源：服务跑在 %LOCALAPPDATA%\Navi\runtimes 下发布出来的那份里，安装包碰不到它，agent 也不归壳管；
// 新壳起来后由控制器按接管流程换到新运行时（launcher/handover.mjs）。
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::controller::Shell;

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_BYTES: u64 = 300 * 1024 * 1024;
const BEAT: Duration = Duration::from_secs(1);

/// 在下（或在装）的那一趟。
pub struct Download {
  id: Value,
  installing: bool,
  handle: tauri::async_runtime::JoinHandle<()>,
}

/// 这份壳带没带更新源：没配公钥的构建（开发时的便携版）不查更新，菜单里也没有「检查更新…」。
pub fn configured(app: &AppHandle) -> bool {
  let updater = app.config().plugins.0.get("updater");
  let filled = |key: &str| updater.and_then(|config| config.get(key)).is_some_and(|value| match value {
    Value::String(text) => !text.trim().is_empty(),
    Value::Array(items) => !items.is_empty(),
    _ => false,
  });
  filled("pubkey") && filled("endpoints")
}

pub fn check(app: &AppHandle, shell: &Arc<Shell>, id: Value) {
  let (app, shell) = (app.clone(), shell.clone());
  tauri::async_runtime::spawn(async move {
    let found = match app.updater_builder().timeout(CHECK_TIMEOUT).build() {
      Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
      Err(error) => Err(error.to_string()),
    };
    let reply = match found {
      Ok(Some(mut update)) => {
        let reply = json!({ "type": "updateResult", "id": id, "version": update.version, "notes": update.body, "current": update.current_version });
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        *shell.update.lock().unwrap() = Some(update);
        reply
      }
      Ok(None) => json!({ "type": "updateResult", "id": id, "version": null }),
      Err(error) => json!({ "type": "updateResult", "id": id, "error": error }),
    };
    shell.send(reply);
  });
}

pub fn install(shell: &Arc<Shell>, id: Value, version: &str) {
  let pending = shell.update.lock().unwrap().take().filter(|update| update.version == version);
  let Some(update) = pending else {
    return shell.send(json!({ "type": "updateResult", "id": id, "error": format!("没有待装的 {version}，先检查一次更新。") }));
  };
  // 锁一直攥到登记好这一趟：worker 下完来认人时，登记一定已经在了。
  let mut slot = shell.download.lock().unwrap();
  if slot.is_some() {
    return shell.send(json!({ "type": "updateResult", "id": id, "error": "上一次更新还在下载或安装" }));
  }
  let (worker, mine) = (shell.clone(), id.clone());
  let handle = tauri::async_runtime::spawn(async move {
    let (mut received, mut reported, mut beat) = (0u64, -1i64, Instant::now() - BEAT);
    let progress = {
      let (shell, id) = (worker.clone(), mine.clone());
      move |chunk: usize, total: Option<u64>| {
        received += chunk as u64;
        if received > MAX_BYTES || total.is_some_and(|total| total > MAX_BYTES) {
          // 下一次等网络的时候这一趟就被收掉，不会走到装那一步。
          return refuse(&shell, &id, &format!("安装包超过 {} MB，不像是 Navi 的安装包，没下完就停了。", MAX_BYTES / 1024 / 1024));
        }
        let percent = total.filter(|total| *total > 0).map(|total| (received * 100 / total) as i64);
        // 心跳按收到的字节算，百分比只是给人看的：没有总长度、或者涨得慢，也照样一秒报一次。
        if beat.elapsed() >= BEAT || percent.is_some_and(|percent| percent >= reported + 5) {
          beat = Instant::now();
          if let Some(percent) = percent { reported = percent; }
          shell.send(json!({ "type": "updateProgress", "id": id, "received": received, "percent": percent }));
        }
      }
    };
    let downloaded = update.download(progress, || {}).await;
    let failed = {
      let mut slot = worker.download.lock().unwrap();
      // 这一趟已经不归自己了（取消、超限在先）：那边回过话了，不装。
      if !slot.as_ref().is_some_and(|download| download.id == mine) {
        return;
      }
      match downloaded {
        Ok(bytes) if bytes.len() as u64 > MAX_BYTES => Err(format!("安装包超过 {} MB，没装。", MAX_BYTES / 1024 / 1024)),
        Ok(bytes) => {
          slot.as_mut().unwrap().installing = true;
          Ok(bytes)
        }
        Err(error) => Err(error.to_string()),
      }
    };
    let error = match failed {
      Ok(bytes) => {
        worker.send(json!({ "type": "updateProgress", "id": mine, "installing": true }));
        // 装成了走不到下面：Windows 上插件把安装包交出去之后直接退出这个进程（控制器的 stdin 随之断开，它也退出）。
        update.install(bytes).err().map_or_else(|| "安装包交给系统了，但这个进程没有退出".to_string(), |error| error.to_string())
      }
      Err(error) => error,
    };
    worker.download.lock().unwrap().take();
    worker.send(json!({ "type": "updateResult", "id": mine, "error": error }));
  });
  *slot = Some(Download { id, installing: false, handle });
}

/// 控制器要取消请求号是 id 的那一趟：还在下就收掉，已经在装就说取消不了。结果回给控制器。
pub fn cancel(shell: &Arc<Shell>, id: Value) {
  let outcome = {
    let mut slot = shell.download.lock().unwrap();
    match slot.as_ref() {
      Some(download) if download.id == id && download.installing => "installing",
      Some(download) if download.id == id => {
        slot.take().unwrap().handle.abort();
        "cancelled"
      }
      _ => "gone",
    }
  };
  shell.send(json!({ "type": "updateCancelResult", "id": id, "outcome": outcome }));
}

/// 超了上限：还在下就收掉，替它回一条 updateResult error。
fn refuse(shell: &Arc<Shell>, id: &Value, why: &str) {
  let mut slot = shell.download.lock().unwrap();
  if !slot.as_ref().is_some_and(|download| &download.id == id && !download.installing) {
    return;
  }
  slot.take().unwrap().handle.abort();
  drop(slot);
  shell.send(json!({ "type": "updateResult", "id": id, "error": why }));
}

/// 控制器没了：在下的那一趟没人等结果了，收掉（已经在装的随它装完、壳退出）。
pub fn abandon(shell: &Arc<Shell>) {
  let mut slot = shell.download.lock().unwrap();
  if slot.as_ref().is_some_and(|download| !download.installing) {
    slot.take().unwrap().handle.abort();
  }
}
