import AppKit

/// 窗口「回到 navi」的那条路：认清端口上是谁 → 不在就起 → 首启先问数据从哪来 → 都对了才载页面。
extension BrowserWindowController {
  /// 本机地址先认清端口上是不是自己那份（不在就起，被别人占着就说明），确认了才载页面；
  /// 连别处的 navi 时直接载。
  ///
  /// `quietly`：不盖「正在启动」那一屏，眼下这一屏自己在说（首启那张卡上选中的那一项在转圈）。
  func loadHome(quietly: Bool = false) {
    resetPageConnection()
    guard NaviConfig.isLocal else { loadPage(); return }
    connect(quietly: quietly)
  }

  /// 页面载不进来（导航失败）。本机地址重走一遍 connect —— 服务可能挂了，也可能端口换了人。
  func showOffline(_ error: Error) {
    computerPreview?.stop()
    if NaviConfig.isLocal { loadHome(); return }
    resetPageConnection()
    offlineView.show(title: "连不上 Navi",
                     detail: "\(error.localizedDescription)\n\(NaviConfig.baseURL.absoluteString)\n服务恢复后自动回到工作区。",
                     actions: [OfflineView.Action(title: "重试") { [weak self] in self?.loadHome() }])
    startHealthPolling()
  }

  private func connect(quietly: Bool = false) {
    if let note = ServerLauncher.shared.hold {
      showInstalling(note)
      // 维护在别的进程里（另开的一份 app 在装更新）：它完了不会通知这里，过一会儿再看一次。
      if !UpdateGate.shared.isHolding {
        let generation = connectionGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
          guard let self, self.connectionGeneration == generation else { return }
          self.loadHome()
        }
      }
      return
    }
    pendingStartingScreen?.cancel()
    let starting = DispatchWorkItem { [weak self] in
      RuntimeLog.record("cover.show", ["kind": "starting"])
      self?.offlineView.show(title: "正在启动 Navi", detail: "就绪后自动回到工作区。", busy: true)
    }
    pendingStartingScreen = starting
    if !quietly { DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: starting) }
    let generation = connectionGeneration
    let asked = Date()
    ServerLauncher.shared.ensureRunning { [weak self] outcome in
      starting.cancel()
      RuntimeLog.record("server.ensure", ["outcome": outcome.logName, "ms": Int(Date().timeIntervalSince(asked) * 1000)])
      guard let self, self.connectionGeneration == generation else { return }
      self.present(outcome)
    }
  }

  private func present(_ outcome: ServerLauncher.Outcome) {
    let retry = OfflineView.Action(title: "重试") { [weak self] in self?.loadHome() }
    switch outcome {
    case .ready:
      loadPage()
      HostMcpSetup.runOnceIfNeeded(window: window)
      checkStaleServer()
    case .needsSetup:
      showFirstRun()
    case .occupied(let explanation):
      offlineView.show(title: "\(NaviConfig.port) 端口被占着", detail: explanation, actions: [retry])
      startHealthPolling(takeOverWhenFree: true)
    case .unresponsive(let holder, let explanation):
      showUnresponsive(holder, detail: explanation, force: false)
    case .failed(let reason):
      let log = ServerLauncher.shared.logURL
      var actions = [retry]
      if FileManager.default.fileExists(atPath: log.path) {
        actions.insert(OfflineView.Action(title: "日志") { NSWorkspace.shared.open(log) }, at: 0)
      }
      // 刚装完新版就起不来，多半是新版的迁移出了问题：指一下更新前的库备份在哪（怎么回到旧版见 README）。
      // 有固定着的恢复点就指最近那个 —— 它是这一版迁移之前的库（之后没有服务起来过），再往后的
      // 状态都可能是失败的迁移改出来的。更早的几个也还在（中间那几版可能也没起来过），提一句。
      // 只指确定是眼前这份库的：换过库（导入了另一份）时，别的库的备份不是它的底；认不出是哪份库的也不指。
      var detail = reason
      let points = DatabaseBackup.recoveryPointsOfCurrentDatabase()
      if let backup = DatabaseBackup.newestBackupOfCurrentDatabase() {
        detail += "\n\n刚更新过的话：更新前的库备份在 \(backup.path)，配上那一版 app 能回到旧版。"
        if points.count > 1 {
          detail += "\n更早几次没确认起来过的更新前备份也还留着（同一目录，共 \(points.count) 份）。"
        }
        actions.insert(OfflineView.Action(title: "更新前的备份") {
          NSWorkspace.shared.activateFileViewerSelecting([backup])
        }, at: 0)
      }
      offlineView.show(title: "Navi 服务没起来", detail: detail, actions: actions)
      startHealthPolling()
    }
  }

  /// 服务进程还在、却一直没应答（ServerLauncher.Outcome.unresponsive）：缓过来就自动接上；停不停由用户点。
  /// `force`：上一次点「停掉它」它没理会，这次的按钮是 SIGKILL。
  private func showUnresponsive(_ holder: LockHolder, detail: String, force: Bool) {
    let retry = OfflineView.Action(title: "重试") { [weak self] in self?.loadHome() }
    let stop = OfflineView.Action(title: force ? "强制结束" : "停掉它") { [weak self] in
      guard let self else { return }
      offlineView.show(title: "正在停止 Navi 服务", detail: "进程 \(holder.pid)", busy: true)
      // 停的这十秒里它可能缓过来、窗口已经接上了（健康轮询 → loadHome）：那时迟到的结果不再动这一屏。
      let generation = connectionGeneration
      DispatchQueue.global(qos: .userInitiated).async {
        let result = ServerShutdown.stopUnresponsive(holder, force: force)
        DispatchQueue.main.async { [weak self] in
          guard let self, self.connectionGeneration == generation else { return }
          guard case .stillRunning = result else { self.loadHome(); return }
          self.showUnresponsive(holder, detail: "进程 \(holder.pid) 收到停止信号后 10 秒还在，多半是卡死了、处理不了信号。\n\n"
            + "「强制结束」会立刻杀掉它（kill -9），它来不及收尾。", force: true)
        }
      }
    }
    offlineView.show(title: "Navi 服务没有应答", detail: detail, actions: [stop, retry])
    // 缓过来了就接上；它自己退了（锁的持有者不在了）也接着起，不用等人点「重试」。
    startHealthPolling(takeOverWhen: { !holder.isAlive })
  }

  /// 端口上那份是旧版 app 起的（见 ServerRecord）：过 UpdateGate 换成新版。
  private func checkStaleServer() {
    guard UpdateGate.shared.phase == .idle else { return }
    DispatchQueue.global(qos: .utility).async {
      guard case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs,
            let from = ServerRecord.staleVersion(servingPID: instance.pid) else { return }
      DispatchQueue.main.async {
        guard UpdateGate.shared.phase == .idle else { return }
        UpdateGate.shared.request(.staleServer(from: from)) {}
      }
    }
  }

  // MARK: 首启：全新开始 / 导入已有数据

  /// `problem`：上一次没成的原因（导入失败、选的目录不对），写在卡片上。
  private func showFirstRun(problem: String? = nil) {
    firstRunView.reset(dataPath: NaviConfig.dataURL.path, problem: problem)
    firstRunView.onChoose = { [weak self] choice in
      guard let self else { return }
      switch choice {
      case .fresh:
        self.firstRunView.setBusy(.fresh, detail: "正在启动 Navi…")
        ServerLauncher.shared.freshStartApproved = true
        self.loadHome(quietly: true)
      case .importData:
        self.chooseImport()
      }
    }
    offlineView.show(panel: firstRunView)
  }

  private func chooseImport() {
    guard let window else { return }
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.message = "选一份 Navi 的数据目录（里面有 \(DatabaseFile.name) 或改名之前的 \(LegacyIdentity.databaseFile)，比如仓库里的 data/）"
    panel.prompt = "导入"
    panel.beginSheetModal(for: window) { [weak self] response in
      guard response == .OK, let url = panel.url else { return }
      self?.importData(from: url)
    }
  }

  private func importData(from url: URL) {
    guard let window else { return }
    let source: DataImport.Source
    do {
      source = try DataImport.inspect(url)
    } catch {
      showFirstRun(problem: error.localizedDescription)
      return
    }
    guard let pid = source.livePID else { runImport(source); return }
    let alert = NSAlert()
    alert.messageText = "这份数据正被另一份 Navi 用着（进程 \(pid)）"
    alert.informativeText = "导入的是它此刻的快照，之后它那边的变化不会过来。它手上在跑的任务仍归它管，"
      + "导进来的那一份只记作暂停，不会去接管。打算从此改用 app 的话，先停掉它（kill \(pid)）再导入更干净。"
    alert.addButton(withTitle: "仍然导入")
    alert.addButton(withTitle: "取消")
    alert.beginSheetModal(for: window) { [weak self] response in
      if response == .alertFirstButtonReturn { self?.runImport(source) }
    }
  }

  private func runImport(_ source: DataImport.Source) {
    firstRunView.setBusy(.importData, detail: "正在导入 \((source.url.path as NSString).abbreviatingWithTildeInPath)…")
    DispatchQueue.global(qos: .userInitiated).async {
      let outcome = Result { try DataImport.run(source, into: NaviConfig.dataURL) }
      DispatchQueue.main.async { [weak self] in
        switch outcome {
        case .failure(let error): self?.showFirstRun(problem: "导入没成功：\(error.localizedDescription)")
        case .success(let report):
          self?.loadHome(quietly: true)
          self?.tellHeld(report)
        }
      }
    }
  }

  /// 导入时停下来的东西说一声：它们在源实例上可能还在跑，副本里只是记作暂停/停用，要接着做得自己点。
  private func tellHeld(_ report: DataImport.Report) {
    let labels: [(String, String)] = [
      ("tasks", "个在跑或排队的任务，已暂停"),
      ("monitors", "个在盯的哨兵，已结束"),
      ("gates", "次在跑的验收前置命令，记为被打断"),
      ("reviews", "个进行中的审查或辩论，已中止"),
      ("schedules", "个定时任务，已停用"),
      ("messages", "条还没发出的消息，已取消"),
    ]
    let lines = labels.compactMap { key, label in report.held[key].map { "· \($0) \(label)" } }
    guard !lines.isEmpty, let window else { return }
    let alert = NSAlert()
    alert.messageText = "导入好了，有些事没有接着做"
    alert.informativeText = "导入不是接管：原来那份 Navi 手上的活仍归它，这里不会替它续跑。\n\n"
      + lines.joined(separator: "\n") + "\n\n要在这里接着做，到对应的任务里继续或重新打开。"
    alert.beginSheetModal(for: window)
  }
}
