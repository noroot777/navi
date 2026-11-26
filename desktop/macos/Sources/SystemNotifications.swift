import AppKit
import UserNotifications
import WebKit

/// 系统通知：页面（web/src/lib/systemNotify.ts）收到服务端的 task.notify 后经 `naviNotify` 交过来，这里弹成
/// macOS 通知；点了把窗口拉到前面、打开那个任务（当成一条 navi:// 链接，走 DeepLink 那条路）。
/// WKWebView 里没有网页通知，只能这样接。弹不弹、弹什么字都是服务端和页面定的，这里只管弹。
///
/// 授权等到头一条要弹时才问：用不上通知的人不该一打开就被问一遍。系统设置里关了就不弹。
/// app 在前台也照弹：页面已经把「正对着看的那个任务」筛掉了，交到这里的都是别处的事。
final class SystemNotifications: NSObject, UNUserNotificationCenterDelegate {
  static let shared = SystemNotifications()
  /// 点了通知要去的地方（AppDelegate 当成 navi:// 链接处理，窗口还没建好时它先记着）。
  var open: ((URL) -> Void)?

  /// 要在 app 启动完成之前设上：点通知中心里的旧通知把 app 拉起来时，系统一启动就把那一下交给 delegate。
  func install() {
    UNUserNotificationCenter.current().delegate = self
  }

  struct Notice {
    let key: String
    let title: String
    let subtitle: String
    let body: String
    let project: String?
    let task: String?

    /// 页面交来的字典。字段不对就不弹；字都截短（通知横幅本来也只显示几行）。
    init?(_ body: Any) {
      guard let dict = body as? [String: Any], let key = dict["key"] as? String, !key.isEmpty,
            let title = dict["title"] as? String, let text = dict["body"] as? String else { return nil }
      self.key = String(key.prefix(400))
      self.title = String(title.prefix(200))
      self.subtitle = String((dict["subtitle"] as? String ?? "").prefix(100))
      self.body = String(text.prefix(500))
      project = dict["project"] as? String
      task = dict["task"] as? String
    }
  }

  func post(_ notice: Notice) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional:
        self.add(notice, to: center)
      case .notDetermined:
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
          if granted { self.add(notice, to: center) }
        }
      default:
        break
      }
    }
  }

  private func add(_ notice: Notice, to center: UNUserNotificationCenter) {
    let content = UNMutableNotificationContent()
    content.title = notice.title
    content.subtitle = notice.subtitle
    content.body = notice.body
    content.sound = .default
    // 同一个项目的归成一摞
    if let project = notice.project { content.threadIdentifier = project }
    content.userInfo = ["project": notice.project ?? "", "task": notice.task ?? ""]
    // 同一件事的 key 相同：几个页面各交一份时只留一条
    center.add(UNNotificationRequest(identifier: notice.key, content: content, trigger: nil))
  }

  /// 点了要去哪儿：有项目就是那个任务的 navi:// 链接；合成的那一条没有，只把窗口拉到前面（DeepLink 认不出就只拉前台）。
  static func link(project: String?, task: String?) -> URL {
    var parts = URLComponents()
    parts.scheme = "navi"
    parts.host = "open"
    if let project, !project.isEmpty {
      parts.queryItems = [URLQueryItem(name: "project", value: project)]
        + (task.flatMap { $0.isEmpty ? nil : [URLQueryItem(name: "task", value: $0)] } ?? [])
    }
    return parts.url ?? URL(string: "navi://open")!
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler completionHandler: @escaping () -> Void) {
    let info = response.notification.request.content.userInfo
    let url = Self.link(project: info["project"] as? String, task: info["task"] as? String)
    DispatchQueue.main.async {
      self.open?(url)
      completionHandler()
    }
  }
}

/// 页面那一头的入口：`window.webkit.messageHandlers.naviNotify.postMessage({...})`。只收自家页面主框架发的。
final class SystemNotificationBridge: NSObject, WKScriptMessageHandler {
  static let messageName = "naviNotify"
  private weak var webView: WKWebView?
  var post: (SystemNotifications.Notice) -> Void = { SystemNotifications.shared.post($0) }

  init(webView: WKWebView) {
    self.webView = webView
    super.init()
    webView.configuration.userContentController.add(WeakMessageHandler(self), name: Self.messageName)
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url, NaviConfig.isSameOrigin(page),
          let current = webView?.url, NaviConfig.isSameOrigin(current),
          let notice = SystemNotifications.Notice(message.body) else { return }
    post(notice)
  }
}
