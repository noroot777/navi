import Foundation

/// 壳这一侧的运行日志：窗口什么时候、为什么撤下页面或重载页面，什么时候起过服务、结果如何。
///
/// 写在数据根的 `logs/diagnostics/mac.jsonl`，跟服务端那份（server.jsonl）同一个目录、同一种格式
/// （@navi/shared/runtime-log），`npm run diagnose` 把两份对齐，才说得清「闪一下」那一刻服务那边在干什么。
/// 设置 →「运行日志」导出的包里也带着这一份。
///
/// 只记运行状况：事件名、原因的枚举、错误码、进程号、版本号。不记 URL（路由里有任务号和文件名）、
/// 不记系统给的错误原文（里面可能带地址）。写入是尽力而为：放在串行队列上，写不进去就算了。
enum RuntimeLog {
  private static let queue = DispatchQueue(label: "dev.navi.runtime-log", qos: .utility)
  private static let rotateBytes: UInt64 = 2 * 1024 * 1024
  private static var writes = 0

  static var directory: URL { NaviConfig.logURL.appendingPathComponent("diagnostics", isDirectory: true) }
  static var fileURL: URL { directory.appendingPathComponent("mac.jsonl") }

  private static let iso: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  /// 记一条。`fields` 只放数字、布尔和代码里写死的短串。`wait`：等它落盘再返回（app 正在退出时用）。
  static func record(_ event: String, _ fields: [String: Any] = [:], wait: Bool = false) {
    // 连别处的 navi 时数据根不是这台机器上那份服务的，壳自己的事也就不往那里记。
    guard NaviConfig.isLocal else { return }
    let at = Date()
    let write = {
      var line: [String: Any] = fields
      line["at"] = iso.string(from: at)
      line["src"] = "mac"
      line["pid"] = Int(getpid())
      line["ev"] = event
      guard JSONSerialization.isValidJSONObject(line),
            let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
      append(data)
    }
    if wait { queue.sync(execute: write) } else { queue.async(execute: write) }
  }

  private static func append(_ data: Data) {
    let manager = FileManager.default
    do {
      try manager.createDirectory(at: directory, withIntermediateDirectories: true)
      writes += 1
      if writes % 100 == 1, let size = (try? manager.attributesOfItem(atPath: fileURL.path))?[.size] as? UInt64, size > rotateBytes {
        // 只改名不重写，同 server 那一侧：别的 app 进程（另开的一份）可能正往同一个文件追加。
        // rename(2) 一步把当前这份换成上一代（覆盖旧的上一代）；两份同时轮转时后到的那份找不到源文件、
        // 直接失败，不会像「先删 .1 再挪」那样把对方刚轮转出来的上一代删掉。
        _ = rename(fileURL.path, fileURL.appendingPathExtension("1").path)
      }
      // O_APPEND：定位到末尾和写入由内核一步做完。另开的一份 app 同时在写时，先 seek 再 write
      // 会让两边落在同一个偏移上、互相盖掉一截。
      let fd = open(fileURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
      guard fd >= 0 else { return }
      defer { close(fd) }
      // 前后各带换行：上一条写到半行就断了时，这一条照样自成一行。
      var framed = Data("\n".utf8)
      framed.append(data)
      framed.append(Data("\n".utf8))
      _ = framed.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    } catch {
      // 日志写不进去不影响窗口本身。
    }
  }

  /// 探活结果压成日志字段：哪一类、错误码 / HTTP 状态码。不带说明原文。
  static func fields(of probe: NaviProbe) -> [String: Any] {
    switch probe {
    case .down: return ["probe": "down"]
    case .unreachable(_, let code): return ["probe": "unreachable", "code": code]
    case .notNavi(let what): return ["probe": "not_navi", "status": what.hasPrefix("HTTP ") ? String(what.dropFirst(5)) : "?"]
    case .navi(let instance): return ["probe": instance.isOurs ? "ours" : "not_ours", "serverPid": instance.pid ?? -1]
    }
  }
}
