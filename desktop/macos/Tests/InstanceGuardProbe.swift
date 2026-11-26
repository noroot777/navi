import AppKit
import WebKit

/// 窗口在线之后端口换了人：页面得撤掉、盖上说明，自己那份回来再回到原路由。
///
/// 真的 BrowserWindowController（窗口不上屏），服务是测试脚本摆的假应答者。协议走 stdin/stdout：
/// 页面载好打印 `LOADED <url>`。短时探活超时后确认原文档还在；`unresponsive` 模式探活一直超时，
/// 读到 `STALLED` 前页面一刻都不许被盖上，之后确认原文档还在。读到 `FLIPPED` 后，`reload` 模式
/// 当场刷新一次 —— 定时认人调得很慢，验的是导航那一道；`watch` 模式什么都不做，验定时那一道。
/// 撤下后打印 `BLANKED …`，再读到 `BACK` 后等页面回来打印 `RESTORED <url>`，读到 `DONE` 退出。
func runInstanceGuardProbe(mode: String) -> Never {
  DispatchQueue.global().asyncAfter(deadline: .now() + 60) {
    fputs("FAIL: instance guard probe timed out\n", stderr)
    exit(1)
  }
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  app.finishLaunching()
  BrowserWindowController.instanceGuardInterval = ["reload", "recover"].contains(mode) ? 3600 : 0.5

  var lines: [String] = []
  let input = NSLock()
  Thread.detachNewThread {
    while let line = readLine() {
      input.lock(); lines.append(line); input.unlock()
    }
  }
  func received(_ line: String) -> Bool {
    input.lock(); defer { input.unlock() }
    return lines.contains(line)
  }
  func spin(until done: () -> Bool, _ what: String) {
    let deadline = Date().addingTimeInterval(20)
    while !done() {
      guard Date() < deadline else {
        fputs("FAIL: waiting for \(what)\n", stderr)
        exit(1)
      }
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
  }
  func texts(in view: NSView) -> [String] {
    ((view as? NSTextField).map { [$0.stringValue] } ?? []) + view.subviews.flatMap(texts)
  }
  func say(_ line: String) {
    print(line)
    fflush(stdout)
  }

  let controller = BrowserWindowController()
  let webView = controller.webView
  spin(until: { webView.title == "OURS" && webView.url?.path == "/route/abc" && !webView.isLoading }, "our page")
  var content: String?
  func readPage(_ script: String) -> String {
    content = nil
    webView.evaluateJavaScript(script) { value, error in
      content = error.map { "ERROR: \($0)" } ?? String(describing: value ?? "nil")
    }
    spin(until: { content != nil }, "the page content")
    return content!
  }
  _ = readPage("window.guardProbeMarker = 'original document'")
  if mode == "recover" {
    // 让首轮 MCP 自检的探活先完成，后面的故障只注入窗口导航。
    spin(until: { UserDefaults.standard.stringArray(forKey: "HostMcpSetupDone")?.contains(NaviConfig.dataURL.path) == true },
         "host MCP check to finish")
  }
  say("LOADED \(webView.url!.absoluteString)")
  if mode == "recover" {
    spin(until: { received("MAINTENANCE_ENDED") }, "maintenance to end")
    controller.showInstalling("正在重新连接 Navi")
    controller.loadHome()
    spin(until: { controller.offlineView.isHidden && !webView.isLoading }, "the new page to replace the maintenance screen")
    require(readPage("typeof window.guardProbeMarker") == "undefined", "the old document cannot satisfy the recovery handoff")
    say("MAINTENANCE_RECOVERED \(webView.url!.path)")

    spin(until: { received("CONTENT_EXITED") }, "the content process recovery scenario")
    _ = readPage("window.guardProbeMarker = 'old content document'")
    controller.webViewWebContentProcessDidTerminate(webView)
    spin(until: { !controller.offlineView.isHidden && texts(in: controller.offlineView).contains("连不上 Navi") },
         "the recovery failure screen")
    say("RECOVERY_FAILED")
    spin(until: { controller.offlineView.isHidden && !webView.isLoading }, "the page to return after health recovers")
    require(readPage("typeof window.guardProbeMarker") == "undefined", "the new page must finish the handoff after recovery fails")
    say("CONTENT_RECOVERED \(webView.url!.path)")
    exit(0)
  }
  if mode == "unresponsive" {
    spin(until: {
      require(controller.offlineView.isHidden && webView.url?.path == "/route/abc",
              "a guard probe that only timed out must leave the page in place")
      return received("STALLED")
    }, "the sustained stall")
    say("RETAINED \(readPage("window.guardProbeMarker"))")
  } else {
    if mode == "reload" {
      spin(until: { received("STALL") }, "the stalled navigation probe")
      controller.reloadPage(nil)
    }
    spin(until: { received("RECOVERED") && !webView.isLoading }, "the delayed probe to settle")
    say("RETAINED \(readPage("window.guardProbeMarker"))")
  }
  spin(until: { received("FLIPPED") }, "the flip")
  if mode == "reload" { controller.reloadPage(nil) }
  spin(until: { !controller.offlineView.isHidden && texts(in: controller.offlineView).contains { $0.contains("端口被占着") } },
       "the occupied screen")
  spin(until: { !webView.isLoading }, "the blank page")
  let blank = readPage("document.title + '|' + document.head.innerHTML + '|' + document.body.innerHTML")
  // 撤下的是整页：留下的文档里既没有原来那份的页面（它的脚本还在跑就会接着发请求），也没有新来的。
  say("BLANKED url=\(webView.url?.absoluteString ?? "nil") content=\(blank)")
  spin(until: { received("BACK") }, "our service coming back")
  spin(until: { controller.offlineView.isHidden && webView.title == "OURS" && !webView.isLoading }, "the page coming back")
  say("RESTORED \(webView.url!.absoluteString)")
  // 页面回来之后发的请求要带上新的实例号，脚本看到了再放行退出。
  spin(until: { received("DONE") }, "the script to finish")
  exit(0)
}
