// 壳要知道的几个位置。数据根、日志、运行时仓库这些由控制器算（launcher/config.mjs），壳只要找得到控制器本身，
// 以及 WebView2 的网页数据放哪 —— 都从 LOCALAPPDATA 派生，验证时换掉这个变量就和日常那份分开。
use std::path::PathBuf;

/// 自带运行时：安装包把它放在 exe 旁边的 `runtime\`；`NAVI_WIN_RUNTIME` 可以改指（验证用）。
pub fn bundled_runtime() -> PathBuf {
  if let Some(raw) = std::env::var_os("NAVI_WIN_RUNTIME").filter(|raw| !raw.is_empty()) {
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
  let root = std::env::var_os("LOCALAPPDATA").filter(|raw| !raw.is_empty())?;
  Some(PathBuf::from(root).join("Navi").join("webview"))
}
