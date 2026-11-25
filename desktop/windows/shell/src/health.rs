// 导航前认一次人（对应 mac WebViewBridge 的 verifyLocalNavigation）：页面自己的刷新、前进后退、跳转放行之前，
// 问一下窗口专用端口上此刻是不是认过的那一份（实例号一样）。WebView2 的导航事件要当场给答复，所以这里是同步的、
// 只读 health 里的实例号；完整的判据（数据根、代码、桌面版标记）在控制器那边，绑定实例号之前已经过了一遍。
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// 从连上到读完的总期限：导航回调要当场答复，窗口在这期间不处理别的事件，所以对方一点一点吐、不结束答复，也只等这么久。
const DEADLINE: Duration = Duration::from_millis(800);
/// health 的答复就几百字节；读到这么多还没完的不是 navi。
const MAX_RESPONSE: usize = 64 * 1024;

pub enum Answer {
  /// 应答了，带着这个实例号（不报的是 None）。
  Instance(Option<String>),
  /// 连不上或者没答完：可能没人，也可能服务这会儿忙。
  Unreachable,
}

pub fn instance_on(port: u16) -> Answer {
  let started = Instant::now();
  let address = SocketAddr::from(([127, 0, 0, 1], port));
  let Ok(mut stream) = TcpStream::connect_timeout(&address, DEADLINE) else { return Answer::Unreachable };
  let _ = stream.set_write_timeout(Some(DEADLINE));
  let request = format!("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
  if stream.write_all(request.as_bytes()).is_err() {
    return Answer::Unreachable;
  }
  // 不用 read_to_end：读超时只管单次读，每来一点数据就重新计时。每读一次之前把读超时设成剩下的时间。
  let mut raw = Vec::new();
  let mut chunk = [0u8; 4096];
  loop {
    let Some(left) = DEADLINE.checked_sub(started.elapsed()).filter(|left| !left.is_zero()) else { return Answer::Unreachable };
    if stream.set_read_timeout(Some(left)).is_err() {
      return Answer::Unreachable;
    }
    match stream.read(&mut chunk) {
      Ok(0) => break,
      Ok(read) => raw.extend_from_slice(&chunk[..read]),
      Err(_) => return Answer::Unreachable,
    }
    if raw.len() > MAX_RESPONSE {
      return Answer::Instance(None);
    }
  }
  let text = String::from_utf8_lossy(&raw);
  let Some((head, body)) = text.split_once("\r\n\r\n") else { return Answer::Unreachable };
  if !head.starts_with("HTTP/1.") || head.split_whitespace().nth(1) != Some("200") {
    return Answer::Instance(None);
  }
  let id = serde_json::from_str::<serde_json::Value>(body)
    .ok()
    .and_then(|health| health.pointer("/instance/id").and_then(|id| id.as_str()).map(str::to_string));
  Answer::Instance(id)
}
