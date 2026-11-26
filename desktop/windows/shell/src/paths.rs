// 壳要知道的几个位置。数据根、日志、运行时仓库这些由控制器算（launcher/config.mjs），壳只要找得到控制器本身，
// 以及 WebView2 的网页数据放哪 —— 都从 LOCALAPPDATA 派生，验证时换掉这个变量就和日常那份分开。
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::OnceLock;

/// 演练构建（desktop/windows/README.md「本地演练」）编进 exe 的一组环境变量：LOCALAPPDATA、NAVI_URL 这些指到临时位置。
/// 写在 exe 里而不是靠启动它的那一方传：更新装完后是安装包把新壳重新打开的，它不会带着演练时的环境。正式构建是空的。
///
/// 只在壳自己取值（`var`）和起控制器时用，不写进壳的进程环境：经 ShellExecute 打开的浏览器、交给系统的安装包继承的
/// 是壳的环境，写进去它们就跟着跑进演练目录（真机上浏览器在那里建了一份新配置，一直开着、占着目录）。
pub fn rehearsal_env() -> &'static [(String, String)] {
  static VARS: OnceLock<Vec<(String, String)>> = OnceLock::new();
  VARS.get_or_init(|| {
    let Some(raw) = option_env!("NAVI_WIN_REHEARSAL_ENV") else { return Vec::new() };
    let Ok(serde_json::Value::Object(vars)) = serde_json::from_str::<serde_json::Value>(raw) else { return Vec::new() };
    vars.into_iter().filter_map(|(key, value)| value.as_str().map(|value| (key, value.to_string()))).collect()
  })
}

/// 环境变量，演练构建编进来的那一份优先。
fn var(key: &str) -> Option<OsString> {
  rehearsal_env().iter().find(|(name, _)| name.eq_ignore_ascii_case(key)).map(|(_, value)| OsString::from(value)).or_else(|| std::env::var_os(key))
}

/// 自带运行时：安装包把它放在 exe 旁边的 `runtime\`；`NAVI_WIN_RUNTIME` 可以改指（验证用）。
pub fn bundled_runtime() -> PathBuf {
  if let Some(raw) = var("NAVI_WIN_RUNTIME").filter(|raw| !raw.is_empty()) {
    return PathBuf::from(raw);
  }
  let exe = std::env::current_exe().unwrap_or_default();
  exe.parent().map(|dir| dir.join("runtime")).unwrap_or_else(|| PathBuf::from("runtime"))
}

pub fn node(runtime: &std::path::Path) -> PathBuf {
  runtime.join("node").join(if cfg!(windows) { "node.exe" } else { "node" })
}

pub fn controller_script(runtime: &std::path::Path) -> PathBuf {
  runtime.join("desktop").join("windows").join("launcher").join("controller-main.mjs")
}

/// `%LOCALAPPDATA%\Navi\webview`：页面的 cookie、localStorage（主题、草稿）跨启动留在这里。
pub fn webview_data() -> Option<PathBuf> {
  let root = var("LOCALAPPDATA").filter(|raw| !raw.is_empty())?;
  Some(PathBuf::from(root).join("Navi").join("webview"))
}
