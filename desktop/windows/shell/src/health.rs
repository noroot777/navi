// 导航前认一次人（对应 mac WebViewBridge 的 verifyLocalNavigation）：页面自己的刷新、前进后退、跳转放行之前，
// 问一下窗口专用端口上此刻是不是认过的那一份（实例号一样）。WebView2 的导航事件要当场给答复，所以这里是同步的、
// 只读 health 里的实例号；完整的判据（数据根、代码、桌面版标记）在控制器那边，绑定实例号之前已经过了一遍。
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub enum Answer {
  /// 应答了，带着这个实例号（不报的是 None）。
  Instance(Option<String>),
  /// 连不上或者没答完：可能没人，也可能服务这会儿忙。
  Unreachable,
}

pub fn instance_on(port: u16) -> Answer {
  let timeout = Duration::from_millis(800);
  let address = SocketAddr::from(([127, 0, 0, 1], port));
  let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else { return Answer::Unreachable };
  let _ = stream.set_read_timeout(Some(timeout));
  let _ = stream.set_write_timeout(Some(timeout));
  let request = format!("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
  if stream.write_all(request.as_bytes()).is_err() {
    return Answer::Unreachable;
  }
  let mut raw = Vec::new();
  if stream.read_to_end(&mut raw).is_err() && raw.is_empty() {
    return Answer::Unreachable;
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
