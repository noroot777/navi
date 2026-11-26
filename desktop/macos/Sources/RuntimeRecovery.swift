import Foundation
import Darwin

enum RuntimeRecovery {
  struct Record: Codable {
    let previous: String
    let next: String
    let backup: String?
    let server: ServerRecord?
    let finalized: Bool?
    var adopting = false
  }
  struct Pause: Codable {
    let previous: String
    let version: String
    let reason: String
  }
  static var url: URL { NaviConfig.dataURL.appendingPathComponent(".mac-runtime-recovery.json") }
  static var pauseURL: URL { NaviConfig.dataURL.appendingPathComponent(".mac-runtime-paused.json") }

  static func paused() throws -> Pause? {
    guard FileManager.default.fileExists(atPath: pauseURL.path) else { return nil }
    let pause = try JSONDecoder().decode(Pause.self, from: Data(contentsOf: pauseURL))
    guard RuntimeStore.contains(pause.previous) else { throw SQLiteFile.Failure("暂停记录的旧运行时身份不符，未启动其他版本") }
    return pause
  }

  static func authorizeTarget() throws {
    let record = try JSONDecoder().decode(Record.self, from: Data(contentsOf: url))
    guard record.finalized == true, !record.adopting,
          NaviHealth.samePath(record.next, NaviConfig.targetRuntimeURL.path) else {
      throw SQLiteFile.Failure("新版切换恢复记录未定稿，未解除回退暂停")
    }
    RuntimeStore.launchTarget()
    if FileManager.default.fileExists(atPath: pauseURL.path) { try FileManager.default.removeItem(at: pauseURL) }
  }

  static func record(previous: String, backup: URL?, finalized: Bool = false) throws {
    guard RuntimeStore.contains(previous) else { throw SQLiteFile.Failure("旧运行时身份不符") }
    // 跟确认（ServerRecord.confirmServing 里的 `confirmed`）在同一把锁里：迟到的确认删不到之后才记的这一份，
    // 记下的「切换前在服务的那一份」也是这一刻的。
    try ServerRecord.locked {
      let record = Record(previous: NaviHealth.realPath(previous), next: NaviHealth.realPath(NaviConfig.targetRuntimeURL.path),
                          backup: backup?.path, server: ServerRecord.read(), finalized: finalized)
      try JSONEncoder().encode(record).write(to: url, options: .atomic)
    }
  }

  /// 新版（`codeDir` 就是这次切换的目标）在这份库上应答了：切换了结。只由 ServerRecord.confirmServing 在它那把
  /// 锁里、认准这一眼算数之后调。
  static func confirmed(codeDir: String?) {
    guard let code = codeDir, let data = try? Data(contentsOf: url),
          let record = try? JSONDecoder().decode(Record.self, from: data), NaviHealth.samePath(record.next, code) else { return }
    try? FileManager.default.removeItem(at: url)
  }

  static func restoreBeforeAdoption(reason: String = "新版启动失败") throws -> URL? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    let record = try JSONDecoder().decode(Record.self, from: data)
    guard case .down = NaviHealth.probeSync(), NaviHealth.samePath(record.next, NaviConfig.targetRuntimeURL.path),
          RuntimeStore.contains(record.previous), !record.adopting, record.finalized == true else {
      throw SQLiteFile.Failure("新版已开始接管或恢复身份不符，未自动覆盖数据库；迁移前恢复点仍保留。")
    }
    if let backup = record.backup, let database = try DatabaseFile.existing(in: NaviConfig.dataURL) {
      guard NaviHealth.samePath(URL(fileURLWithPath: backup).deletingLastPathComponent().path, NaviConfig.backupURL.path) else {
        throw SQLiteFile.Failure("恢复点不属于本数据根")
      }
      let stage = database.appendingPathExtension("restoring-" + UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: stage) }
      try SQLiteFile.snapshot(from: URL(fileURLWithPath: backup), to: stage)
      try SQLiteFile.snapshot(from: database, to: database.appendingPathExtension("failed-" + UUID().uuidString))
      guard rename(stage.path, database.path) == 0 else { throw SQLiteFile.Failure("无法发布恢复后的数据库") }
      for suffix in ["-wal", "-shm", "-journal"] { try? FileManager.default.removeItem(atPath: database.path + suffix) }
    }
    let previous = URL(fileURLWithPath: record.previous, isDirectory: true)
    let pause = Pause(previous: record.previous, version: record.server?.bundleVersion ?? "unknown", reason: reason)
    try JSONEncoder().encode(pause).write(to: pauseURL, options: .atomic)
    try RuntimeStore.activate(previous)
    if let server = record.server { try ServerRecord.replace(with: server) }
    try FileManager.default.removeItem(at: url)
    return previous
  }
}
