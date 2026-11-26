import Foundation
import Darwin

/// 「这份库最后交给哪一版 app 起、那一份起来过没有」。在数据根里记两件事，分开存：
///
///  · **在服务的那一份**（`pid` + `bundleVersion`）：确认应答过的那个进程、是哪一版 app 起的。只有确认
///    （`confirmServing`）会改它 —— 起服务的人自己说了不算。
///  · **这一次起服务**（`attempt`）：起之前先记下构建号和时刻（pid 还是 0；写不进去就不起），进程起来了补上 pid。
///    它应答了（不管是起它的那个启动器等到的，还是之后重开 app、登录项、另一个窗口看到的）才升成在服务的那一份。
///    没应答就退了、等超时了、端口被别人抢了，它都只是一次没成的尝试，留在 `attempt` 里，在服务的那一份原样不动。
///
/// 分开存是因为起服务的结局启动器自己说不准：被锁挡下、迟迟才退、起了一半又换了人……要是起之前就拿新进程
/// 盖掉在服务的那一份，任何一条没对上账的路都会让端口上那份旧服务从此「pid 对不上 = 不知道是谁」。
///
/// **确认是一次带时刻的比较交换**：几处（窗口、登录项、另一个 app 进程）各自探活、各自确认，探到和记账之间
/// 隔着多久谁也说不准。所以读、改、写都在同一把文件锁里（`locked`，恢复点清单的增删也在这把锁里），确认带上
/// 「这一眼是什么时候发出去的」：
///  · 应答的是这一次尝试的那个进程：升成在服务的那一份。尝试只有最新的一次（新的尝试会盖掉旧的），所以迟到的
///    一眼最多确认它自己那一代，盖不掉之后才起的那一次。
///  · 应答的是在服务的那一份：只有这一眼发出去的时候晚于这一次尝试开始，才算「尝试之后它还在写库」—— 更早
///    的一眼说明不了尝试之后的事，什么都不改。
/// current（新开的 MCP 用哪一版运行时，RuntimeStore.follow）在同一处、同一个判断下跟过去，切不过去就整次不记，
/// 下一眼再来。
///
/// 库最后交给了哪一版（`lastHandedTo`）：尝试比最近一次确认晚，就是尝试那一版 —— 它可能已经动过库（迁移不可逆），
/// 恢复点认「这一次备过没有」靠的就是它（DatabaseBackup.covers）。尝试之后在服务的那一份又被确认过（旧服务
/// 缓过来了、接着写库），就是在服务的那一版：下一次起之前要照常再备一份。
///
/// 换了新版 app（Sparkle 装完重开、`build.sh --install`）再连上时，在服务的那一份构建号不是自己 = 服务还在跑
/// 旧版代码。见 UpdateGate 的 `.staleServer`。pid 对不上就是「不知道」，不当成旧版。
struct ServerRecord: Codable {
  struct Attempt: Codable {
    let pid: Int
    let bundleVersion: String
    /// 这一次起服务记下的时刻（备份之后、起进程之前）。这之前留的恢复点都是给它的。
    let startedAt: Date
  }

  static let fileName = ".mac-server.json"
  static var url: URL { NaviConfig.dataURL.appendingPathComponent(fileName) }
  private static var lockURL: URL { NaviConfig.dataURL.appendingPathComponent(fileName + ".lock") }

  let pid: Int
  let bundleVersion: String
  /// 最近一次确认的时刻：比它早的恢复点作废（DatabaseBackup.validPins）。升级确认记的是那次尝试开始的时刻，
  /// 再确认记的是那一眼发出去的时刻 —— 都不会晚于「看到它在服务」，确认之后别人才留的底不会被它顺带作废。
  var confirmedAt: Date? = nil
  /// 最近一次起服务（见类型顶部）。
  var attempt: Attempt? = nil

  /// 库最后交给了哪一版 app（见类型顶部）。
  var lastHandedTo: String {
    guard let attempt, attempt.startedAt > (confirmedAt ?? .distantPast) else { return bundleVersion }
    return attempt.bundleVersion
  }

  /// 要起服务了：先记下是这一版、什么时候起的。写不进去抛错，调用方就别起。
  static func writeAttempt(version: String = NaviConfig.bundleVersion) throws {
    try locked {
      try save(with(attempt: Attempt(pid: 0, bundleVersion: version, startedAt: Date())))
    }
  }

  /// 起出来的进程号，补进这一次尝试（没有先记下尝试的 —— 回退时拉起旧版那一下 —— 从现在算起）。
  static func write(pid: Int, version: String = NaviConfig.bundleVersion) {
    try? locked {
      let pending = read()?.attempt.flatMap { $0.pid == 0 && $0.bundleVersion == version ? $0.startedAt : nil }
      try save(with(attempt: Attempt(pid: pid, bundleVersion: version, startedAt: pending ?? Date())))
    }
  }

  /// 端口上自己那份（`pid`，跑的是 `codeDir`）应答了，探活是 `observedAt` 发出去的。按类型顶部那两条记账；
  /// 记上了，比确认时刻早的恢复点作废。别的进程、过时的一眼不算。
  static func confirmServing(pid: Int?, codeDir: String? = nil, observedAt: Date) {
    guard let pid, pid > 1 else { return }
    try? locked {
      guard let record = read() else { return }
      let confirmed: ServerRecord
      if let attempt = record.attempt, attempt.pid == pid {
        confirmed = ServerRecord(pid: pid, bundleVersion: attempt.bundleVersion,
                                 confirmedAt: max(record.confirmedAt ?? .distantPast, attempt.startedAt))
      } else if record.pid == pid, observedAt > (record.attempt?.startedAt ?? .distantPast) {
        confirmed = ServerRecord(pid: pid, bundleVersion: record.bundleVersion,
                                 confirmedAt: max(record.confirmedAt ?? .distantPast, observedAt), attempt: record.attempt)
      } else { return }
      guard RuntimeStore.follow(codeDir) else {
        RuntimeLog.record("server.confirm_deferred", ["serverPid": pid, "step": "runtime"])
        return
      }
      do { try save(confirmed) } catch {
        RuntimeLog.record("server.confirm_deferred", ["serverPid": pid, "step": "record"])
        return
      }
      DatabaseBackup.dropReleasedPoints()
    }
  }

  static func read() -> ServerRecord? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(ServerRecord.self, from: data)
  }

  /// 原样换回一份（回退到迁移前时，换回切换之前那一份）。
  static func replace(with record: ServerRecord) throws {
    try locked { try save(record) }
  }

  /// 服务记录和恢复点清单的读改写都在这把锁里（跨进程，同一进程里的几个线程也互斥）。不可重入。
  static func locked<T>(_ body: () throws -> T) throws -> T {
    let fd = open(lockURL.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw SQLiteFile.Failure("打不开服务记录锁（\(String(cString: strerror(errno)))）") }
    defer { close(fd) }
    while flock(fd, LOCK_EX) != 0 {
      guard errno == EINTR else { throw SQLiteFile.Failure("拿不到服务记录锁（\(String(cString: strerror(errno)))）") }
    }
    return try body()
  }

  private static func with(attempt: Attempt) -> ServerRecord {
    let record = read()
    return ServerRecord(pid: record?.pid ?? 0, bundleVersion: record?.bundleVersion ?? "unknown",
                        confirmedAt: record?.confirmedAt, attempt: attempt)
  }

  private static func save(_ record: ServerRecord) throws {
    try JSONEncoder().encode(record).write(to: url, options: .atomic)
  }

  /// 正在应答的这个进程是哪一版 app 起的：在服务的那一份，或者这一次起出来、还没来得及确认的那个。认不出是 nil。
  private static func version(servingPID pid: Int?) -> String? {
    guard let pid, pid > 1, let record = read() else { return nil }
    if let attempt = record.attempt, attempt.pid == pid { return attempt.bundleVersion }
    return record.pid == pid ? record.bundleVersion : nil
  }

  /// 正在应答的这份（pid）就是这一版 app 起的。认不出是 false（不知道）。
  static func servesThisBuild(pid: Int?) -> Bool {
    version(servingPID: pid) == NaviConfig.bundleVersion
  }

  /// 正在应答的这份（pid）是不是由别的构建号的 app 起的；是就返回那个构建号。
  static func staleVersion(servingPID pid: Int?) -> String? {
    guard let version = version(servingPID: pid), version != NaviConfig.bundleVersion else { return nil }
    return version
  }
}

/// 评估时端口上是谁。放行之后只停评估过的那一份（ServerShutdown.stop）：中间换了人就重新评估，
/// 不拿上一次的结论去停另一份服务。
enum ServiceTarget: Equatable {
  /// 确认没人在听（连接被拒）。
  case absent
  /// 确认是别的 navi：它报了自己的数据根，不是这一份，用的不是这份库。
  case foreign(pid: Int?)
  /// 连的是别处的 navi（不是本机地址）：app 不管它的死活，换 app 也不重启它。
  case remote
  /// 自己那份，进程号是这个。
  case ours(pid: Int)
}

struct ServiceRecoveryIdentity {
  let id: String
  let pid: Int
  let dataDir: String
  let codeDir: String

  init?(_ instance: NaviInstance) {
    guard NaviConfig.isLocal, instance.isOurs, let id = instance.id, !id.isEmpty,
          let pid = instance.pid, pid > 1, let dataDir = instance.dataDir,
          let codeDir = instance.codeDir, RuntimeStore.contains(codeDir) else { return nil }
    self.id = id
    self.pid = pid
    self.dataDir = NaviHealth.realPath(dataDir)
    self.codeDir = NaviHealth.realPath(codeDir)
  }

  func matches(_ instance: NaviInstance) -> Bool {
    guard let current = ServiceRecoveryIdentity(instance) else { return false }
    return id == current.id && pid == current.pid && dataDir == current.dataDir && codeDir == current.codeDir
  }

  func verify() throws {
    guard case .navi(let instance) = NaviHealth.probeSync(), matches(instance) else {
      throw SQLiteFile.Failure("服务身份已变化或无法确认，本次强制切换已取消；没有停止其他服务。")
    }
  }
}

/// 让自己那份服务下线，给换代码让路。只停**评估过的那一份**（UpdateGate 问 restart-impact 时
/// 端口上的那个进程）：这会儿端口上换了人、或者认不出是谁，一律不停、回去重新评估 —— 不拿上一次
/// 「不会打断谁」的结论去停另一份服务。别的 navi 用的不是这份库，跟这次更新无关，不碰。
///
/// SIGTERM 就够了：在跑的单飞 agent 输出走文件，不随 server 死，新 server 起来按 pid 接管；团队
/// 调度台下次有人说话时 --resume 接回（server 的 reattach.ts）。会被真正打断的那些在这之前已经
/// 由 UpdateGate 问过用户。
enum ServerShutdown {
  enum Result: Equatable {
    /// 停了（或者确认本来就没在跑 / 端口上不是自己那份）。带上停掉的 pid。
    case stopped(Int?)
    /// 端口上已经不是评估过的那一份了（或者这会儿认不出来）：没停任何东西，该重新评估。
    case changed(String)
    case failed(String)
  }

  /// `target` 为 nil：用户在「确认不了」时点了「现在」—— 停那时候端口上自己那份，认不出是谁就不停。
  static func stop(expecting target: ServiceTarget?, timeout: TimeInterval = 20, identity: ServiceRecoveryIdentity? = nil,
                   beforeStop: () -> Bool = { true }, didSignal: () -> Void = {}) -> Result {
    if target == .remote { return .stopped(nil) }
    switch NaviHealth.probeSync() {
    case .down:
      // 没人在听了。评估过的那个进程要是还在（正在自己退出），等它退干净。
      guard case .ours(let pid) = target else { return .stopped(nil) }
      return waitGone(pid, timeout: timeout)
    case .unreachable(let why, _):
      return .changed("服务这会儿没有答复（\(why)）")
    case .notNavi(let what):
      return .changed("端口上的应答不像 Navi（\(what)）")
    case .navi(let instance) where !instance.isOurs:
      guard instance.dataDir != nil else { return .changed("端口上的 Navi 认不出是不是这一份") }
      if case .ours = target { return .changed("端口上换成了别的 Navi") }
      return .stopped(nil)
    case .navi(let instance):
      if let identity, !identity.matches(instance) { return .changed("服务身份已变化，本次强制切换已取消") }
      guard let pid = instance.pid, pid > 1 else { return .failed("服务没报自己的进程号，没法让它下线。") }
      if let target, target != .ours(pid: pid) { return .changed("服务换了一份（进程 \(pid)）") }
      guard let pid32 = Int32(exactly: pid) else { return .failed("服务的进程号不对：\(pid)") }
      guard beforeStop() else { return .changed("切换已取消，旧服务未停止") }
      if kill(pid32, SIGTERM) != 0 && errno != ESRCH {
        return .failed("停不了服务进程 \(pid)：\(String(cString: strerror(errno)))")
      }
      didSignal()
      return waitGone(pid, timeout: timeout)
    }
  }

  enum HolderStop { case stopped, stillRunning, changed }

  /// 用户在「服务没有应答」那一屏点了「停掉它」（`force`：它不理会、再点了「强制结束」）。只停认过的那一个进程：
  /// 它还活着、还握着这份库的锁、这会儿还是没应答；换了人或者缓过来了，一律不停（`changed`，回去重新认）。
  /// SIGTERM 要它自己的事件循环转起来才会处理，真卡死的进程等不到 —— 那时如实说（`stillRunning`），SIGKILL 由用户再点。
  static func stopUnresponsive(_ holder: LockHolder, force: Bool, timeout: TimeInterval = 10) -> HolderStop {
    guard DatabaseFile.liveHolder(in: NaviConfig.dataURL) == holder else { return .changed }
    if case .navi(let instance) = NaviHealth.probeSync(), instance.pid == Int(holder.pid) { return .changed }
    if kill(holder.pid, force ? SIGKILL : SIGTERM) != 0 { return errno == ESRCH ? .stopped : .changed }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if !holder.isAlive { return .stopped }
      Thread.sleep(forTimeInterval: 0.2)
    }
    return .stillRunning
  }

  private static func waitGone(_ pid: Int, timeout: TimeInterval) -> Result {
    guard let pid32 = Int32(exactly: pid) else { return .failed("服务的进程号不对：\(pid)") }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      let gone = kill(pid32, 0) != 0 && errno == ESRCH
      if gone, case .down = NaviHealth.probeSync() { return .stopped(pid) }
      Thread.sleep(forTimeInterval: 0.2)
    }
    return .failed("服务进程 \(pid) \(Int(timeout)) 秒内没有退出，更新没装。看日志 \(NaviConfig.serverLogURL.path)。")
  }
}

/// 维护期：UpdateGate 从停服务、备份库到 Sparkle 换完 app 这段时间，任何入口都不许起服务 ——
/// 这个窗口、登录项的 `--start-server`、另开的一份 app 都一样，否则旧代码会再起一份，迁移前的
/// 备份就白做了。所以它记在数据根里，不只在本进程内存里。两样一起用：
///  · 启动锁（.mac-launch.lock）由维护方一直攥着：正在起服务的那一处做完之前维护方拿不到它、
///    也就不会去停服务；维护方攥着时，起服务的那一处在拿锁之前就先看到下面的标记、直接不起。
///  · 标记文件说明「为什么不起」。持有它的进程活着才算数：进程没了（装完被 Sparkle 退掉了、崩了）
///    标记就作废，别处照常起。本进程自己的标记永远算数；别的进程的超过一刻钟也作废（防进程号复用）。
final class Maintenance {
  private struct Marker: Codable {
    let pid: Int32
    let note: String
    let since: Date
  }

  static let fileName = ".mac-maintenance.json"
  static var url: URL { NaviConfig.dataURL.appendingPathComponent(fileName) }
  private static let staleAfter: TimeInterval = 15 * 60

  private var lock: ServerStartLock?

  private init(lock: ServerStartLock) { self.lock = lock }

  /// 攥住启动锁、写标记。另一处正在起服务时等它做完，等满 timeout 秒还拿不到就报错。
  static func begin(note: String, timeout: TimeInterval) throws -> Maintenance {
    let lock = try ServerStartLock(dataDir: NaviConfig.dataURL)
    let deadline = Date().addingTimeInterval(timeout)
    while try !lock.tryAcquire() {
      guard Date() < deadline else { throw SQLiteFile.Failure("另一处正在起 Navi 服务，\(Int(timeout)) 秒还没完") }
      Thread.sleep(forTimeInterval: 0.2)
    }
    let marker = Marker(pid: getpid(), note: note, since: Date())
    try JSONEncoder().encode(marker).write(to: url, options: .atomic)
    return Maintenance(lock: lock)
  }

  /// 收回标记、松开启动锁。可以重复调。
  func end() {
    guard lock != nil else { return }
    if let marker = Self.readMarker(), marker.pid == getpid() { try? FileManager.default.removeItem(at: Self.url) }
    lock = nil  // 关掉描述符，flock 随之松开
  }

  /// 有维护在进行就返回那句说给用户听的话。作废的标记顺手删掉。
  static func activeNote() -> String? {
    guard let marker = readMarker() else { return nil }
    if marker.pid == getpid() { return marker.note }
    let alive = kill(marker.pid, 0) == 0 || errno == EPERM
    if alive && Date().timeIntervalSince(marker.since) < staleAfter { return marker.note }
    try? FileManager.default.removeItem(at: url)
    return nil
  }

  private static func readMarker() -> Marker? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Marker.self, from: data)
  }
}
