// 三条壳命令都登记进 app 清单：登记过的命令要有对应的权限才调得动（capabilities/local.json 给本地那一屏，
// 页面那一份由 src/window.rs 在载页面时按窗口专用端口现加），页面拿不到本地那一屏的按钮。
// 本地那一屏用的两个标从 docs/logo 拷进 ui/（不进仓库），得在 tauri_build 收 frontendDist 之前。
use std::path::Path;

fn main() {
  let logo = Path::new("../../../docs/logo");
  for name in ["icon.svg", "loader.svg"] {
    let source = logo.join(name);
    println!("cargo:rerun-if-changed={}", source.display());
    std::fs::copy(&source, Path::new("ui").join(name)).unwrap_or_else(|error| panic!("拷 {} 失败：{error}", source.display()));
  }
  let manifest = tauri_build::AppManifest::new().commands(&["shell_screen", "shell_action", "page_report"]);
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri-build 失败");
}
