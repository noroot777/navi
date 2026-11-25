// `Navi.exe --spawn-detached <日志> <程序> [参数…]`：控制器起服务时借壳拉起进程（desktop/windows/launcher/launcher.mjs）。
//
// 服务要和壳彻底解绑：关窗、退出壳、壳被强杀，都不带走服务和 agent。进程层用 DETACHED_PROCESS +
// CREATE_NEW_PROCESS_GROUP（同 scripts/start-detached.mjs，服务没有控制台、不收父进程的 Ctrl+C）。Job 层 node 做不到：
// 壳要是被放进了带 KILL_ON_JOB_CLOSE 的 Job，Job 的句柄一关，里面的进程连同后代全被结束；libuv 的 detached 不带
// CREATE_BREAKAWAY_FROM_JOB。所以这里一律带上它起：
//   · 不在 Job 里：这个标志不起作用；
//   · 在 Job 里、Job 允许脱离：服务起在 Job 外面（从资源管理器、开始菜单打开时就是这样，explorer 给的 Job 是 0x1800）；
//   · Job 不许脱离（CreateProcess 报拒绝访问）：Job 关掉时不连带结束子进程的，留在里面起，照实报出来；
//     会连带结束的，不起 —— 起了也会跟着壳一起没了，说清楚让人换个方式打开（Navi 自己的应用内终端里就是 0x2000）。
//
// 句柄：Windows 的子进程会继承父进程**所有**可继承的句柄，不只是那三个标准句柄。服务一跑就是几天，它手里要是攥着
// 拉起 Navi.exe 的那一方的管道（控制器的、PowerShell 的、随便哪个工具的），读那根管道的人就永远等不到 EOF —— 实测
// 过：调用方卡到超时。所以用 PROC_THREAD_ATTRIBUTE_HANDLE_LIST 点名只给日志文件和 NUL，别的一个都不继承。
//
// 输出一行 JSON：{"pid":…, "job":"none|escaped|stayed"} 或 {"error":…}。
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;

use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
use windows::Win32::System::JobObjects::{
  IsProcessInJob, JobObjectExtendedLimitInformation, QueryInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
  CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
  CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_UNICODE_ENVIRONMENT, DETACHED_PROCESS, EXTENDED_STARTUPINFO_PRESENT,
  LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

const ERROR_ACCESS_DENIED: i32 = 5;

pub fn run(args: &[OsString]) -> i32 {
  let [log, program, rest @ ..] = args else {
    return report(serde_json::json!({ "error": "用法：--spawn-detached <日志> <程序> [参数…]" }), 2);
  };
  let in_job = unsafe {
    let mut result = BOOL(0);
    IsProcessInJob(GetCurrentProcess(), None, &mut result).is_ok() && result.as_bool()
  };
  match spawn(log, program, rest, true) {
    Ok(pid) => report(serde_json::json!({ "pid": pid, "job": if in_job { "escaped" } else { "none" } }), 0),
    Err(error) if in_job && error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
      if kills_on_close() {
        return report(serde_json::json!({
          "error": "Navi 是在一个不许子进程脱离、关掉时又会连带结束全部子进程的作业（Job）里打开的（多半是从某个终端、IDE 或自动化工具里拉起的）。在这里起的服务会跟着它一起被结束，所以没有起。从开始菜单或桌面快捷方式打开 Navi 再试。",
          "code": "job-kill-on-close",
        }), 3);
      }
      match spawn(log, program, rest, false) {
        Ok(pid) => report(serde_json::json!({ "pid": pid, "job": "stayed" }), 0),
        Err(error) => report(serde_json::json!({ "error": format!("拉不起服务：{error}") }), 1),
      }
    }
    Err(error) => report(serde_json::json!({ "error": format!("拉不起服务：{error}") }), 1),
  }
}

/// 起进程：标准输入接 NUL、输出和错误追加进日志，只继承这两个句柄；环境与当前目录照抄本进程的。
fn spawn(log: &OsStr, program: &OsStr, args: &[OsString], breakaway: bool) -> std::io::Result<u32> {
  let output = OpenOptions::new().create(true).append(true).open(log)?;
  let input = File::open("NUL")?;
  let handles = [HANDLE(input.as_raw_handle()), HANDLE(output.as_raw_handle())];
  for handle in handles {
    unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }.map_err(io_error)?;
  }
  let mut command_line: Vec<u16> = command_line(program, args);
  let application: Vec<u16> = program.encode_wide().chain(Some(0)).collect();

  // 属性表：先问要多大，再在自己的缓冲里建。
  let mut size = 0usize;
  let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut size) };
  let mut buffer = vec![0u8; size];
  let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut c_void);
  unsafe { InitializeProcThreadAttributeList(Some(list), 1, None, &mut size) }.map_err(io_error)?;
  let result = (|| {
    unsafe {
      UpdateProcThreadAttribute(
        list,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
        Some(handles.as_ptr() as *const c_void),
        std::mem::size_of_val(&handles),
        None,
        None,
      )
    }
    .map_err(io_error)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[1];
    startup.lpAttributeList = list;
    let mut flags = EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
    if breakaway {
      flags |= CREATE_BREAKAWAY_FROM_JOB;
    }
    let mut info = PROCESS_INFORMATION::default();
    unsafe {
      CreateProcessW(
        PCWSTR(application.as_ptr()),
        Some(PWSTR(command_line.as_mut_ptr())),
        None,
        None,
        true,
        flags,
        None,
        PCWSTR::null(),
        &startup.StartupInfo,
        &mut info,
      )
    }
    .map_err(io_error)?;
    unsafe {
      let _ = CloseHandle(info.hThread);
      let _ = CloseHandle(info.hProcess);
    }
    Ok(info.dwProcessId)
  })();
  unsafe { DeleteProcThreadAttributeList(list) };
  result
}

fn io_error(error: windows::core::Error) -> std::io::Error {
  // HRESULT_FROM_WIN32 的低 16 位就是 Win32 错误码：拒绝访问要原样认出来（见 run）。
  std::io::Error::from_raw_os_error((error.code().0 & 0xFFFF) as i32)
}

/// 按 MSVC 运行时拆命令行的规矩拼（同 Rust 标准库的 make_command_line）：带空白、引号或为空的参数加引号，
/// 引号前的反斜杠翻倍再转义引号，参数末尾的反斜杠在收尾引号前翻倍。
fn command_line(program: &OsStr, args: &[OsString]) -> Vec<u16> {
  let mut line: Vec<u16> = Vec::new();
  for (index, arg) in std::iter::once(program).chain(args.iter().map(OsString::as_os_str)).enumerate() {
    if index > 0 {
      line.push(b' ' as u16);
    }
    let wide: Vec<u16> = arg.encode_wide().collect();
    let quote = wide.is_empty() || wide.iter().any(|&c| c == b' ' as u16 || c == b'\t' as u16 || c == b'"' as u16);
    if !quote {
      line.extend(&wide);
      continue;
    }
    line.push(b'"' as u16);
    let mut backslashes = 0usize;
    for &c in &wide {
      if c == b'\\' as u16 {
        backslashes += 1;
        continue;
      }
      if c == b'"' as u16 {
        line.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
      } else {
        line.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
      }
      backslashes = 0;
      line.push(c);
    }
    line.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    line.push(b'"' as u16);
  }
  line.push(0);
  line
}

/// 本进程所在的 Job 关掉时会不会连带结束里面的进程（传空句柄问的就是自己所在的那个 Job）。问不出来按会。
fn kills_on_close() -> bool {
  let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
  let ok = unsafe {
    QueryInformationJobObject(
      None,
      JobObjectExtendedLimitInformation,
      &mut info as *mut _ as *mut c_void,
      std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
      None,
    )
  };
  ok.is_err() || info.BasicLimitInformation.LimitFlags.contains(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
}

fn report(value: serde_json::Value, code: i32) -> i32 {
  use std::io::Write;
  let mut out = std::io::stdout();
  let _ = writeln!(out, "{value}");
  let _ = out.flush();
  code
}
