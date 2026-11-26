import Foundation

/// 「现在重启服务会打断谁」—— 问的是 server 的 `/api/restart-impact`，与 `npm run restart` 的安全闸
/// 同一条口径（判据和分类的依据都在 server/src/reattach.ts）。换 app 就是重启它里面的服务，所以
/// 装更新前问的也是它。
///
/// 算「会打断」的两类：
///  · interrupted   重启后接不回来、会被判 failed 的（排队中还没进程的、进程已经不在的……）
///  · mcpDisrupted  进程活得过重启，但手里握着 navi MCP：服务换代码那几十秒里它的交卷撞上就失败，
///                  restart.mjs 对它们的默认也是「不动」
/// survives（会被接管）和 resumes（调度台自动接回）不算。问的时候带了 `?shutdown=1`（「允许其他设备访问」那条）
/// 再加一类：随服务一起关掉的终端、聊天、AI 协助、预览试跑（shutdown.resources）。
struct RestartImpact: Decodable {
  struct Item: Decodable {
    let id: String
    let title: String
    let reason: String?
  }

  let survives: [Item]
  let resumes: [Item]
  let interrupted: [Item]
  let mcpDisrupted: [Item]
  struct Handover: Decodable {
    struct Target: Decodable { let `protocol`: Int; let schema: String }
    let blocked: [Item]
    let sessions: [String]
    let target: Target?
  }
  let runtimeHandover: Handover?
  /// 认不认「重启前冻结」那道关口（server/src/restart-freeze.ts）：老版本服务不带这个字段。
  let restartFreeze: Int?
  struct Shutdown: Decodable {
    struct Resource: Decodable { let kind: String; let id: String; let label: String? }
    let resources: [Resource]
  }
  let shutdown: Shutdown?

  /// 同一个任务两类都占时只算一次（interrupted 优先：它说的后果更重）。
  var disrupted: [ImpactItem] { disrupted(includingShutdown: true) }

  /// `includingShutdown` 为假：随服务关掉的资源不算（装更新另有自己的资源闸；冻结快照里却总带着它们）。
  func disrupted(includingShutdown: Bool) -> [ImpactItem] {
    var seen = Set<String>()
    var out: [ImpactItem] = []
    for item in interrupted where seen.insert(item.id).inserted {
      out.append((item.id, item.title, item.reason.map { "会被判失败：\($0)" } ?? "会被判失败"))
    }
    for item in mcpDisrupted where seen.insert(item.id).inserted {
      out.append((item.id, item.title, "手里握着 Navi MCP，服务重启那会儿交卷可能失败"))
    }
    for resource in includingShutdown ? shutdown?.resources ?? [] : [] {
      out.append(("\(resource.kind):\(resource.id)", resource.label ?? resource.kind, "会随服务一起关掉"))
    }
    return out
  }
}

/// 会被打断的一项。`id` 是任务号（拿来比「点头之后多出了谁」）；不是来自名单的那种（「旧服务」）没有。
typealias ImpactItem = (id: String?, title: String, why: String)

/// 问一次的结果。
enum ImpactVerdict {
  /// 确认不会打断任何任务：自己那份没在跑、端口上是别的 navi，或者问到了、是空的。
  case clear(ServiceTarget)
  case disrupts(ServiceTarget, [ImpactItem])
  /// 确认不了：服务没答复、答的不像 navi、没报身份，或者 restart-impact 问不出来（拒答、超时、
  /// 答非所问）。**确认不了不等于没有**：按会打断对待，只有用户点了「现在」才往下走。
  case unknown(String)

  var needsConsent: Bool {
    if case .clear = self { return false }
    return true
  }

  /// 放行后该停的那一份；确认不了时是 nil（用户点了「现在」：停那时候端口上自己那份）。
  var target: ServiceTarget? {
    switch self {
    case .clear(let target), .disrupts(let target, _): return target
    case .unknown: return nil
    }
  }

  /// 用户点头之后再看一眼，比他同意过的那一份（`self`）多出了什么：多出了会打断的任务、从确认得了变成确认不了、
  /// 端口上换了一份服务 —— 这些都是他没同意过的，要重新问。名单变短、照旧不算。（同 Windows 壳 restart.mjs 的 widened）
  func widened(to now: ImpactVerdict) -> Bool {
    if case .unknown = now {
      if case .unknown = self { return false }
      return true
    }
    if case .unknown = self { return false }
    if target != now.target { return true }
    guard case .disrupts(_, let items) = now else { return false }
    var known = Set<String>()
    if case .disrupts(_, let agreed) = self { for item in agreed { known.insert(item.id ?? item.title) } }
    return items.contains { !known.contains($0.id ?? $0.title) }
  }
}

enum RestartImpactProbe {
  struct RecoveryAssessment {
    let identity: ServiceRecoveryIdentity
    let verdict: ImpactVerdict
  }

  static func assessRecoverySync() throws -> RecoveryAssessment {
    guard case .navi(let instance) = NaviHealth.probeSync(),
          let identity = ServiceRecoveryIdentity(instance) else {
      throw SQLiteFile.Failure("无法确认本机外置旧服务的身份，未强制切换；旧服务和任务保持原样。")
    }
    return RecoveryAssessment(identity: identity,
      verdict: askImpact(of: .ours(pid: identity.pid), instance: identity.id, preservingRuntime: false, recovery: true))
  }

  /// 只在后台队列上调。
  static func assessSync(preservingRuntime: Bool = false) -> ImpactVerdict {
    assessDetailedSync(preservingRuntime: preservingRuntime).verdict
  }

  /// 认不认「重启前冻结」：只有拿到一份看得懂的 restart-impact 答复才分得出前两档。没答上来、答不像 navi
  /// 是第三档 —— 那不是「老服务不认」，不能拿它当退回老路的理由。
  enum FreezeSupport { case supported, unsupported, undetermined }

  /// 同上，再带上冻结那一步要的两样：认的是哪一份（实例号）、它认不认「重启前冻结」。
  struct Assessment {
    let verdict: ImpactVerdict
    let instance: String?
    let freezeSupport: FreezeSupport
    var freezable: Bool { freezeSupport == .supported }
  }

  /// `includingShutdown`：连随服务一起关掉的资源也算进来（「允许其他设备访问」那条；装更新另有自己的资源闸）。
  static func assessDetailedSync(preservingRuntime: Bool = false, includingShutdown: Bool = false) -> Assessment {
    var support = FreezeSupport.undetermined
    var instanceID: String?
    let verdict = assessVerdict(preservingRuntime: preservingRuntime, includingShutdown: includingShutdown,
      instanceID: &instanceID, freezable: &support)
    return Assessment(verdict: verdict, instance: instanceID, freezeSupport: support)
  }

  private static func assessVerdict(preservingRuntime: Bool, includingShutdown: Bool, instanceID: inout String?,
                                    freezable: inout FreezeSupport) -> ImpactVerdict {
    guard NaviConfig.isLocal else { return .clear(.remote) }
    switch NaviHealth.probeSync() {
    case .down:
      return .clear(.absent)
    case .unreachable(let why):
      return .unknown("服务没有答复：\(why)")
    case .notNavi(let what):
      // 自己那份正忙、正在重启时也会这样（比如一次 503），不能当成「端口上不是 navi」。
      return .unknown("端口上的应答不像 Navi（\(what)）")
    case .navi(let instance) where !instance.isOurs:
      guard instance.dataDir != nil else { return .unknown("端口上的 Navi 没报数据根在哪，认不出是不是这一份") }
      return .clear(.foreign(pid: instance.pid))
    case .navi(let instance):
      guard let pid = instance.pid, pid > 1 else { return .unknown("服务没报自己的进程号") }
      instanceID = instance.id
      return askImpact(of: .ours(pid: pid), instance: instance.id, preservingRuntime: preservingRuntime,
        includingShutdown: includingShutdown, freezable: &freezable)
    }
  }

  /// 带着认过的那一份的实例号问：问到之前端口换了人，新来的那份不答（server/src/instance-binding.ts），
  /// 闸拿不到别人的名单。
  private static func askImpact(of target: ServiceTarget, instance: String?, preservingRuntime: Bool, recovery: Bool = false) -> ImpactVerdict {
    var support = FreezeSupport.undetermined
    return askImpact(of: target, instance: instance, preservingRuntime: preservingRuntime, recovery: recovery, freezable: &support)
  }

  private static func askImpact(of target: ServiceTarget, instance: String?, preservingRuntime: Bool, recovery: Bool = false,
                                includingShutdown: Bool = false, freezable: inout FreezeSupport) -> ImpactVerdict {
    var url = URLComponents(url: NaviConfig.baseURL.appendingPathComponent("api/restart-impact"), resolvingAgainstBaseURL: false)!
    if includingShutdown { url.queryItems = [URLQueryItem(name: "shutdown", value: "1")] }
    var nextSchema: String?
    if preservingRuntime {
      guard let next = RuntimeHandover.compatibility(), next["protocol"] as? Int == 1,
            let schema = next["schema"] as? String else { return .unknown("新版接管协议无法核实") }
      nextSchema = schema
      url.queryItems = [URLQueryItem(name: "protocol", value: "1"), URLQueryItem(name: "schema", value: schema)]
    }
    var request = URLRequest(url: url.url!, timeoutInterval: 8)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    // 与 restart.mjs 同一张凭证：单实例锁里那串 token（文件 0600）。本机直连多半用不上，带着不吃亏。
    if let token = hostToken() { request.setValue(token, forHTTPHeaderField: "x-ash-host-token") }
    if let instance { request.setValue(instance, forHTTPHeaderField: "x-ash-instance") }
    let done = DispatchSemaphore(value: 0)
    var verdict = ImpactVerdict.unknown("没有答复")
    var understoodFreeze = FreezeSupport.undetermined
    URLSession.shared.dataTask(with: request) { data, response, error in
      defer { done.signal() }
      if let error { verdict = .unknown(error.localizedDescription); return }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard status == 200, let data else { verdict = .unknown("服务端回 \(status)"); return }
      guard let impact = try? JSONDecoder().decode(RestartImpact.self, from: data) else {
        verdict = .unknown("答复看不懂（服务端版本太旧？）")
        return
      }
      understoodFreeze = impact.restartFreeze == RestartFreeze.protocolVersion ? .supported : .unsupported
      if let nextSchema, impact.runtimeHandover?.target?.protocol != 1 || impact.runtimeHandover?.target?.schema != nextSchema {
        verdict = .unknown("旧服务未核对新版兼容性，未切换服务")
        return
      }
      if recovery {
        var seen = Set<String>()
        let affected = (impact.interrupted + impact.resumes + impact.survives + impact.mcpDisrupted
          + (impact.runtimeHandover?.blocked ?? [])).filter { seen.insert($0.id).inserted }
        verdict = affected.isEmpty ? .clear(target) : .disrupts(target, affected.map {
          ($0.id, $0.title, $0.reason ?? "强制切换不保证接管，任务或 MCP 交卷可能中断")
        })
        return
      }
      let disrupted: [ImpactItem] = preservingRuntime
        ? (impact.runtimeHandover?.blocked.map { (id: $0.id, title: $0.title, why: $0.reason ?? "不可接管") }
          ?? [(id: nil, title: "旧服务", why: "没有可验证的安全接管能力")])
        : impact.disrupted
      verdict = disrupted.isEmpty ? .clear(target) : .disrupts(target, disrupted)
    }.resume()
    done.wait()
    freezable = understoodFreeze
    return verdict
  }

  static func hostToken() -> String? {
    guard let db = try? DatabaseFile.existing(in: NaviConfig.dataURL) else { return nil }
    for lock in DatabaseFile.lockFiles(of: db) {
      if let data = try? Data(contentsOf: lock), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let token = json["token"] as? String { return token }
    }
    return nil
  }
}

enum RuntimeHandover {
  static func compatibility() -> [String: Any]? {
    guard let data = try? Data(contentsOf: NaviConfig.targetRuntimeURL.appendingPathComponent(".handover.json")) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  static func acquire(target: ServiceTarget?) -> String? {
    guard case .ours(let pid) = target,
          case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs, instance.pid == pid,
          let codeDir = instance.codeDir, RuntimeStore.contains(codeDir), let id = instance.id else { return nil }
    guard let compatibility = compatibility(),
          let result = send(instance: id, body: compatibility), let lease = result["lease"] as? String else { return nil }
    guard result["protocol"] as? Int == 1 else { _ = send(instance: id, body: ["release": lease]); return nil }
    return lease
  }

  static func release(_ lease: String) {
    guard case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs, let id = instance.id else { return }
    _ = send(instance: id, body: ["release": lease])
  }

  static func isValid(_ lease: String) -> Bool {
    guard case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs, let id = instance.id else { return false }
    return send(instance: id, body: ["check": lease])?["valid"] as? Bool == true
  }

  private static func send(instance: String, body: [String: Any]) -> [String: Any]? {
    guard let token = RestartImpactProbe.hostToken() else { return nil }
    var request = URLRequest(url: NaviConfig.baseURL.appendingPathComponent("api/runtime-handover"), timeoutInterval: 45)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(token, forHTTPHeaderField: "x-navi-host-token")
    request.setValue(instance, forHTTPHeaderField: "x-navi-instance")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    let done = DispatchSemaphore(value: 0)
    var result: [String: Any]?
    URLSession.shared.dataTask(with: request) { data, response, _ in
      if (response as? HTTPURLResponse)?.statusCode == 200, let data {
        result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      }
      done.signal()
    }.resume()
    done.wait()
    return result
  }
}

/// 「为了重启而停服务」的冻结关口，app 这一半（服务端 server/src/restart-freeze.ts，协议同 scripts/restart-freeze.mjs）。
///
/// 用户点头之后先让服务冻结接活，拿冻结之下的快照跟他同意过的那份比；冻着的时候不起新回合、新 agent、新终端，
/// 所以停下之前影响不会再变多。下刀前续一次期（顺带核对冻结还在），没停成就放掉；停成了不用放，服务退了冻结跟着没了，
/// app 自己崩了冻结也会到期自己解。老版本服务不认这道关口：退回即时再评估。
enum RestartFreeze {
  static let protocolVersion = 1

  struct Lease {
    let token: String
    let instance: String
  }

  enum Outcome {
    /// 冻住了；verdict 是冻结之下的那份，停下之前不会再变多。
    case frozen(Lease, ImpactVerdict)
    /// 确认了不用冻：服务明确答了不认这道关口（老版本），或者端口上不是自己那份。verdict 是即时再评估的。
    case unfrozen(ImpactVerdict)
    /// 分不出认不认（服务一时没答上来、答的不像 navi）、或者冻结那一下认不出是刚才那份：不是「老服务」，
    /// 不能退回不冻的老路 —— 调用方当成「确认不了」，重新问或者不停。
    case undetermined(String)
    /// 认这道关口却冻不了（另一处正在准备重启、没有权限、没答上来）：不停。
    case refused(String)
  }

  /// 只在后台队列上调。`includingShutdown` 要跟用户同意过的那份口径一致（见 RestartImpact.disrupted）。
  static func acquire(includingShutdown: Bool = true) -> Outcome {
    let now = RestartImpactProbe.assessDetailedSync(includingShutdown: includingShutdown)
    if case .unknown(let why) = now.verdict { return .undetermined(why) }
    guard case .ours(let pid) = now.verdict.target else { return .unfrozen(now.verdict) }
    switch now.freezeSupport {
    case .unsupported: return .unfrozen(now.verdict)
    case .undetermined: return .undetermined("认不出这份服务认不认重启前冻结")
    case .supported: break
    }
    guard let instance = now.instance else { return .undetermined("服务没报实例号") }
    let reply = send(instance: instance, body: [:])
    guard let json = reply.json, json["protocol"] as? Int == protocolVersion else {
      return .refused(reply.status == 0 ? "没有答复" : "服务端回 \(reply.status)")
    }
    guard reply.status == 200, let token = json["lease"] as? String else {
      return .refused(json["error"] as? String ?? "服务端回 \(reply.status)")
    }
    let lease = Lease(token: token, instance: instance)
    // 冻住的必须是刚认过的那一份：问到之前端口换了人的话，新来的那份不答（instance-binding.ts），这里是兜底。
    guard json["instance"] as? String == instance, json["pid"] as? Int == pid,
          let body = json["impact"], let data = try? JSONSerialization.data(withJSONObject: body),
          let impact = try? JSONDecoder().decode(RestartImpact.self, from: data) else {
      release(lease)
      return .undetermined("冻结时端口上换了一份服务，或者快照看不懂")
    }
    return .frozen(lease, verdict(of: impact, pid: pid, includingShutdown: includingShutdown))
  }

  private static func verdict(of impact: RestartImpact, pid: Int, includingShutdown: Bool) -> ImpactVerdict {
    let items = impact.disrupted(includingShutdown: includingShutdown)
    return items.isEmpty ? .clear(.ours(pid: pid)) : .disrupts(.ours(pid: pid), items)
  }

  enum Check {
    case valid
    /// 此刻的名单比用户同意过的多出了谁：带着此刻那份（拿去重新问）和一句原因。
    case widened(ImpactVerdict, String)
    /// 冻结失效了、续期没答上来、此刻的名单没给出来。
    case invalid(String)
  }

  /// 下刀前续一次期，顺带拿此刻的名单跟 `agreed`（用户点头的那份）比。名单会多是因为已经在跑的 agent 中途拉起
  /// navi MCP 这件事服务端冻不住（见 server/src/restart-freeze.ts）。
  static func check(_ lease: Lease, agreed: ImpactVerdict, includingShutdown: Bool = true) -> Check {
    let reply = send(instance: lease.instance, body: ["renew": lease.token])
    guard reply.status == 200, reply.json?["valid"] as? Bool == true else {
      return .invalid(reply.status == 200 ? "冻结已经失效（到期了，或者被放掉了）" : "续期没有答复（服务端回 \(reply.status)）")
    }
    guard case .ours(let pid) = agreed.target else { return .valid }
    guard let body = reply.json?["impact"], let data = try? JSONSerialization.data(withJSONObject: body),
          let impact = try? JSONDecoder().decode(RestartImpact.self, from: data) else {
      return .invalid("续期答复里没有此刻的影响名单，核对不了")
    }
    let now = verdict(of: impact, pid: pid, includingShutdown: includingShutdown)
    guard agreed.widened(to: now), case .disrupts(_, let items) = now else { return .valid }
    var known = Set<String>()
    if case .disrupts(_, let had) = agreed { for item in had { known.insert(item.id ?? item.title) } }
    let extra = items.filter { !known.contains($0.id ?? $0.title) }.map(\.title)
    return .widened(now, "确认之后又多了会被打断的：\(extra.prefix(5).joined(separator: "、"))\(extra.count > 5 ? " 等 \(extra.count) 项" : "")")
  }

  /// 同 `check`，只要一句原因：nil = 可以停。
  static func renew(_ lease: Lease, agreed: ImpactVerdict) -> String? {
    switch check(lease, agreed: agreed) {
    case .valid: return nil
    case .widened(_, let why), .invalid(let why): return why
    }
  }

  static func release(_ lease: Lease) {
    _ = send(instance: lease.instance, body: ["release": lease.token])
  }

  /// status 为 0 = 没答上来。
  private static func send(instance: String, body: [String: Any]) -> (status: Int, json: [String: Any]?) {
    var request = URLRequest(url: NaviConfig.baseURL.appendingPathComponent("api/restart-freeze"), timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    if let token = RestartImpactProbe.hostToken() { request.setValue(token, forHTTPHeaderField: "x-navi-host-token") }
    request.setValue(instance, forHTTPHeaderField: "x-navi-instance")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    let done = DispatchSemaphore(value: 0)
    var result: (status: Int, json: [String: Any]?) = (0, nil)
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      result = (status, data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] })
      done.signal()
    }.resume()
    done.wait()
    return result
  }
}
