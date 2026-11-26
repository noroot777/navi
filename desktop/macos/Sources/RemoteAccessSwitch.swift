import AppKit

/// 菜单里「允许其他设备访问」那一项：改 `NaviConfig.allowsOtherDevices`，再让自己那份服务按新设置重起。
///
/// 服务听在哪、远程配对开不开，是起服务那一下由 `NAVI_LOCAL_ONLY` 定的（ServerLauncher），所以光改
/// 设置不够，得重启。重启用的是装更新那一套零件，只是不备份库、不换代码：先问会打断谁
/// （RestartImpact），会打断或者确认不了就摆给用户、让他选；放行后攥住维护锁（这期间登录项、别的窗口
/// 都不许起服务，见 Maintenance），只停评估过的那一份（ServerShutdown），松锁后窗口照常 loadHome，
/// ServerLauncher 按新设置起一份。服务本来没在跑、端口上是别的 navi：只记下设置，下次起服务时生效。
///
/// 确认框可能开着好一阵，这期间别处又起了任务，用户点头时看到的名单就过时了。所以攥住维护锁之后、停服务
/// 之前先让服务冻结接活、拿冻结之下的快照（RestartFreeze，server/src/restart-freeze.ts）；多出了他没同意过的
/// 影响就放开冻结、松锁、把新名单重新摆给他，没多出来才凭这份快照停，下刀前续一次期确认冻结还在、此刻的名单也没
/// 多出谁（已经在跑的 agent 中途拉起 MCP 服务端冻不住，多了就不停）。冻着的时候不起新回合。名单里也算随服务一起
/// 关掉的终端、聊天这些。老版本服务不认这道关口：退回即时再评估，确认框里如实说这一下堵不上。
///
/// 设置**在旧服务确认停下之后、松开维护锁之前**才落盘：锁攥着谁也起不了服务，所以中途在哪一步退出、
/// 崩掉，留下的都是一对对得上的「设置 + 服务」—— 没落盘就是旧设置（旧服务要么还在、要么停了等着按旧设置
/// 重起），落了盘服务一定已经停了、下一次按新设置起。没停成就什么都不落。
/// 剩下对不上的来路（手动改 defaults、上一版 app 起的服务）由 ServedInstance 看出来：菜单如实写「重启服务
/// 后生效」，这时点它不是翻转设置，而是按现在的设置重启。只在主线程上用。
enum RemoteAccessSwitch {
  private(set) static var busy = false

  static func toggle(_ controller: BrowserWindowController?) {
    guard !busy else { return }
    if let note = ServerLauncher.shared.hold {
      alert("现在改不了", "\(note)。等它完了再改。")
      return
    }
    busy = true
    let enable = ServedInstance.networkPending ? NaviConfig.allowsOtherDevices : !NaviConfig.allowsOtherDevices
    DispatchQueue.global(qos: .userInitiated).async {
      let assessment = RestartImpactProbe.assessDetailedSync(includingShutdown: true)
      DispatchQueue.main.async {
        decide(enable: enable, verdict: assessment.verdict, freezable: assessment.freezable, changed: false, controller: controller)
      }
    }
  }

  private static func decide(enable: Bool, verdict: ImpactVerdict, freezable: Bool, changed: Bool, controller: BrowserWindowController?) {
    guard confirm(enable: enable, verdict: verdict, freezable: freezable, changed: changed, window: controller?.window) else {
      busy = false
      if changed { controller?.loadHome() }
      return
    }
    apply(enable: enable, verdict: verdict, controller: controller)
  }

  private static func confirm(enable: Bool, verdict: ImpactVerdict, freezable: Bool, changed: Bool, window: NSWindow?) -> Bool {
    // 改回只听本机是收窄，不打断谁就直接办。
    guard enable || verdict.needsConsent else { return true }
    let alert = NSAlert()
    var lines: [String] = changed ? ["刚才确认之后情况变了，按现在的样子再确认一次。"] : []
    if enable {
      alert.messageText = "允许其他设备访问这台 Navi？"
      lines.append("服务不再只听 127.0.0.1：同一 Tailscale 或局域网里的设备连得上 \(NaviConfig.port) 端口，"
        + "进来仍要在这台电脑上批准配对，或者输入访问密钥（设置 › 默认规则 › 远程访问）。"
        + "手机上点飞书卡片的「在 Navi 中打开」也就打得开了。")
      lines.append("macOS 防火墙开着的话，会问一次要不要让 node 接受传入连接，选「允许」。")
      alert.addButton(withTitle: "打开并重启服务")
    } else {
      alert.messageText = "改回只允许本机访问？"
      alert.addButton(withTitle: "重启服务")
    }
    alert.addButton(withTitle: "取消")
    switch verdict {
    case .clear: lines.append("要重启 Navi 服务才生效，几秒钟就好；在跑的任务照常接着跑。")
    case .disrupts(_, let items):
      let shown = items.prefix(8).map { "· \($0.title) —— \($0.why)" }
      let more = items.count > shown.count ? ["…另有 \(items.count - shown.count) 个"] : []
      lines.append((["要重启 Navi 服务才生效，现在重启会打断："] + shown + more).joined(separator: "\n"))
    case .unknown(let why):
      lines.append("要重启 Navi 服务才生效。确认不了重启会不会打断任务（\(why)），按会打断对待。")
    }
    if case .ours = verdict.target, !freezable {
      lines.append("这一版服务不支持重启前冻结：确认之后到停下之间新起的任务不在上面，也会被打断。")
    }
    alert.informativeText = lines.joined(separator: "\n\n")
    return alert.runModal() == .alertFirstButtonReturn
  }

  /// `agreed`：用户刚点头同意的那一份。
  private static func apply(enable: Bool, verdict agreed: ImpactVerdict, controller: BrowserWindowController?) {
    let note = "正在按新设置重启 Navi 服务…"
    controller?.showInstalling("正在重启 Navi", detail: "正在应用访问设置，就绪后自动回到工作区。")
    DispatchQueue.global(qos: .userInitiated).async {
      var failure: String?
      var retry: (verdict: ImpactVerdict, freezable: Bool)?
      do {
        let maintenance = try Maintenance.begin(note: note, timeout: 50)
        var lease: RestartFreeze.Lease?
        var now: (verdict: ImpactVerdict, freezable: Bool)?
        switch RestartFreeze.acquire() {
        case .refused(let why): failure = "服务这会儿冻结不了接活（\(why)），这次没有重启。"
        case .unfrozen(let fresh): now = (fresh, false)
        // 分不出认不认冻结：按「确认不了」比 —— 同意过的不是「确认不了」就重新问，不退回不冻的老路。
        case .undetermined(let why): now = (.unknown(why), false)
        case .frozen(let held, let fresh):
          lease = held
          now = (fresh, true)
        }
        if let now {
          if agreed.widened(to: now.verdict) {
            retry = now
          } else {
            let stopped = ServerShutdown.stop(expecting: agreed.target, beforeStop: {
              guard let lease else { return true }
              guard let why = RestartFreeze.renew(lease, agreed: agreed) else { return true }
              failure = "\(why)，这次没有重启。"
              return false
            })
            switch stopped {
            case .stopped:
              lease = nil // 服务退了，冻结跟着没了
              ServedInstance.forget()
              NaviConfig.allowsOtherDevices = enable
            case .changed(let why): if failure == nil { failure = "评估之后服务变了（\(why)），这次没有重启。" }
            case .failed(let why): failure = why
            }
          }
        }
        // 没停成（名单变了要重问、停不下来）：服务还在，冻结当场放开，被挡住的任务接着起。
        if let lease { RestartFreeze.release(lease) }
        maintenance.end()
      } catch {
        failure = "没能让服务下线：\(error.localizedDescription)"
      }
      DispatchQueue.main.async {
        if let retry, failure == nil {
          decide(enable: enable, verdict: retry.verdict, freezable: retry.freezable, changed: true, controller: controller)
          return
        }
        busy = false
        if let failure { alert("没有切换", "\(failure)\n\n设置没改，可以再试一次。") }
        controller?.loadHome()
      }
    }
  }

  private static func alert(_ title: String, _ detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    alert.addButton(withTitle: "好")
    alert.runModal()
  }
}
