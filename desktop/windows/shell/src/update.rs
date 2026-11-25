// 自更新（对应 mac 的 Updater.swift 接 Sparkle 那一段）。检查、下载、验签、交给安装包这几步全在 tauri-plugin-updater
// 里：更新清单（latest.json）只是指路，下载下来的安装包要用编进壳的公钥（tauri.conf.json 的 plugins.updater.pubkey，
// 构建时取 desktop/windows/release.json）验 minisign 签名，签名里还绑着版本号（requireSignedVersion），验不过一律不装。
// 什么时候查、问不问、跳过哪一版由控制器定（launcher/updates.mjs）；这里只按它的话办，再把结果交回去：
//
//   控制器 → 壳  { type: "updateCheck", id }                 查一次
//   壳 → 控制器  { type: "updateResult", id, version?, notes?, error? }   version 为空 = 已经是最新
//   控制器 → 壳  { type: "updateInstall", id, version }      装刚查到的那一版
//   壳 → 控制器  { type: "updateProgress", id, percent } / { type: "updateResult", id, error }
//
// 装的时候插件把安装包交给系统（/UPDATE /P /R：不再问、装完重新打开 Navi）就让壳退出。换的只是安装目录里的壳和
// 运行时发布源：服务跑在 %LOCALAPPDATA%\Navi\runtimes 下发布出来的那份里，安装包碰不到它，agent 也不归壳管；
// 新壳起来后由控制器按接管流程换到新运行时（launcher/handover.mjs）。
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::controller::Shell;

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
    let found = match app.updater() {
      Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
      Err(error) => Err(error.to_string()),
    };
    let reply = match found {
      Ok(Some(update)) => {
        let reply = json!({ "type": "updateResult", "id": id, "version": update.version, "notes": update.body, "current": update.current_version });
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
  let shell = shell.clone();
  tauri::async_runtime::spawn(async move {
    let (mut received, mut reported) = (0u64, -1i64);
    let progress = {
      let (shell, id) = (shell.clone(), id.clone());
      move |chunk: usize, total: Option<u64>| {
        received += chunk as u64;
        let Some(total) = total.filter(|total| *total > 0) else { return };
        let percent = (received * 100 / total) as i64;
        if percent >= reported + 5 {
          reported = percent;
          shell.send(json!({ "type": "updateProgress", "id": id, "percent": percent }));
        }
      }
    };
    // 成功时走不到下面：Windows 上插件把安装包交出去之后直接退出这个进程（控制器的 stdin 随之断开，它也退出）。
    if let Err(error) = update.download_and_install(progress, || {}).await {
      shell.send(json!({ "type": "updateResult", "id": id, "error": error.to_string() }));
    }
  });
}
