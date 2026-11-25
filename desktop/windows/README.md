# Navi for Windows

对等于 mac 版（`desktop/macos`）的 Windows 版：装完即用、不依赖仓库检出和系统 node、个人自用默认只听本机。只出 x64、per-user（不要管理员）。已有**自带运行时**和**桌面壳**（Tauri v2，便携版）；安装包与更新、云端发版在后面几步。

## 自带运行时

```bash
npm run bundle:win-runtime                     # → desktop/windows/build/runtime（在 mac 上就能做）
WIN_REMOTE_KEY=… npm run smoke:win-runtime:remote   # 送到测试机 192.168.1.187 上跑冒烟
WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --reclaim   # 只清上次没清完的对端目录和本机暂存
```

`scripts/bundle-runtime.mjs` 组装的目录与仓库同形（布局写在脚本顶部）：

- `node/node.exe`：固定版本的 node（版本与 mac 一致，在 `desktop/shared/runtime-bundle.mjs`；win-x64 zip 的 sha256 写死在脚本里，下载后校验，缓存里的也每次重验）；
- `shared`、`server/dist`、`mcp/dist`、`web/dist`：先跑一遍 `npm run build`（`NAVI_WIN_SKIP_BUILD=1` 跳过）；
- `node_modules`：server 与 mcp 的生产依赖，按 win32-x64 装（`--os=win32 --cpu=x64 --ignore-scripts`，npm 取自那份 node 包），不编译任何东西。node-pty 只留它自带的 `prebuilds/win32-x64`（含 `conpty.node` 和 `conpty/conpty.dll`、`OpenConsole.exe`）。

下载的 node 和装好的依赖缓存在 `build/cache/`（`NAVI_WIN_CACHE` 可换），lockfile、各 workspace 的 package.json、node 版本或 `scripts/win-deps.mjs` 变了才重装。

### 为什么包里一个链接都没有

测试机（Windows 11 家庭版、没开开发者模式）建不出符号链接。npm workspaces 在 `node_modules/@navi/*` 放的是指回各 workspace 的链接；换成 junction 也不行：它得在目标机上现建，读回来是绝对路径，内容清单、安装包、发布这一路都得为它开口子。所以：

- `@navi/server`、`@navi/mcp`、`@navi/web` 没人按包名引用，删掉；
- `@navi/shared` 换成**转发包**（`scripts/win-deps.mjs`）：每个导出子路径一个 `.js`，只有一行 `export * from "../../../shared/src/<名>.ts"`。shared 的导出直接指 `.ts` 源码、靠 node 的类型擦除跑，而 node 不擦 `node_modules` 里的 `.ts`——转发包本身是 `.js`，真正的 `.ts` 仍在外面，照样能跑，模块实例也只有一份。组装时用本机 node 逐个比对「经转发包」和「直接加载源码」的导出名，shared 哪天加了默认导出（`export *` 不带它）会当场红。

组装完还要过几道：没有链接；每个 `.exe`/`.dll`/`.node` 都是 x64 PE、任何地方没有 Mach-O/ELF（`scripts/binary-check.mjs`，只看文件头）；没有只差大小写的路径；包内最长路径不超过 150（留给 `%LOCALAPPDATA%\Navi\runtimes\<sha256>\` 和用户名，整体在 MAX_PATH 以内）。最后封内容清单。

### 落在哪、怎么发布

| 位置 | 是什么 |
|---|---|
| `%LOCALAPPDATA%\Navi\runtimes\<sha256>\` | 发布出来的运行时，服务从这里跑 |
| `%LOCALAPPDATA%\Navi\data\` | 数据根（`NAVI_DATA_DIR`） |
| `%LOCALAPPDATA%\Navi\data\logs\` | 日志 |

（`scripts/layout.mjs`）Windows 上被占用的文件删不掉也改不了名，所以安装目录里那份只是发布源：首次启动先校验，再拷进 `runtimes\.installing-<发布者 pid>-<随机>`（发布中途被杀留下的，下一次发布认出属主已经不在、收掉）、校验暂存的那份、整目录改名成 `<sha256>`（被杀毒/索引短暂占住时退让重试）。目录名就是内容清单的 sha256，换安装包永远发布到另一个目录，不碰正在跑的那份；同名目录已存在就校验后复用、不覆盖，校验不过就拒绝。实现与 mac 共用 `desktop/shared/runtime-store.mjs`：Windows 包的清单是 format 2——不记可执行位（Windows 上读不出来，在 mac 上封的清单要在 Windows 上验得过）、不许任何链接。`current` 指针和 MCP 启动器留给壳那一步。

### 冒烟

`scripts/smoke-runtime.mjs <运行时>` 在 Windows 上跑，被测的一律是包里的 `node.exe`：发布到临时 `LOCALAPPDATA` → 自带 node 的 sqlite 写入重开读回、ConPTY 起 `cmd` 读到输出 → 临时数据根、非 4317 端口起 server，health 报的代码根是发布目录 → 经 API 写入并读回一个项目 → 终端 API（server 自己的 ConPTY 路径）敲一条命令读到输出、结束会话 → 取 web 页面和一份脚本资源 → 停干净。server 的 `USERPROFILE`/`APPDATA` 也指进临时目录，不碰这台机器上已有的 Navi。

停干净不靠父进程号追树（父进程先死了它的后代就追不到）：冒烟在起任何进程之前先把自己收进一个 Job Object（`scripts/process-job.mjs`，KILL_ON_JOB_CLOSE），之后起的探针、server、ConPTY、shell 生来就在容器里。收尾不论成败都走同一段，每步各自兜底：停 server → 结束容器里除冒烟自己外的全部成员，直到内核报只剩自己 → 按随机临时目录的路径再核一遍进程表（命中说明有进程跑出了容器，结束它并判失败）→ 整个目录删得掉。冒烟自己崩了或被杀，句柄随助手一起关掉，容器里剩下的由内核结束；临时目录里有一份属主记录（`desktop/shared/scratch.mjs`），下一次冒烟开头认出属主已经不在、收掉。

`scripts/remote-smoke.mjs` 从开发机把运行时打成 tar.gz、起一个只活这一次的 HTTP 服务，经 `scripts/win-remote` 的通道让测试机拉下来跑上面那个冒烟，冒烟的工作目录也放在下载目录 `%TEMP%\navi-win-runtime-<id>\` 里。不进对端仓库、不用它的 worktree。

这个目录归开发机管，不归对端那条命令管（`scripts/remote-scratch.mjs`）：命令期限一到，win-remote 连对端的收尾代码一起切掉；开发机被 Ctrl-C、被杀，或者断了线，那段收尾也一样走不到。所以 `<id>` 由开发机生成，送命令之前先记进本机账本（`~/.cache/navi/win-remote-smoke/<id>.json`，在仓库之外，worktree 删了它还在）。命令不论怎么结束，都另起一次结算，一条账上的三样责任分开核实，全部核实了才销账：每个终端会话（主命令的、清理请求自己的，会话一建好就记上）都关掉（404 也算）；命令行或可执行文件路径里带这个目录名的进程都结束掉（对端真正干活的是目录里 `run.ps1` 起的那个 powershell，所以它和它起的一切都认得出来；进程表查不出来不算「一个都没有」）；目录删掉并核实不在。按第一下 Ctrl-C 先中止那条命令：rexec 删掉终端会话，对端整棵进程树随之结束，结算完再退。没结清就留账，下一次 `remote-smoke`（或 `--reclaim`）开头替属主已经不在的那几条结算；结算前先把账改名成 `<id>.claim-<自己的 pid>.json` 认领，改名只有一个进程能成功，所以同一条账同一时刻只有一个持有者在写、在销，两个回收者同时跑也不会互相覆盖（认领者自己再被杀，下一个按文件名里的 pid 认出来再认领）。账本写入走临时文件加改名，读到不完整、缺字段的记录一律当身份未知：报出来、原样留着，不据此碰对端；目标机器按记账时解析出的地址记下。本机的打包暂存同样带属主记录，下一次收掉。

## 桌面壳

```bash
npm run build:win                    # → desktop/windows/build/Navi\{Navi.exe, runtime\}（便携版；mac 上交叉编译）
WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --shell     # 送到测试机上跑 shell-check.mjs
node desktop/windows/scripts/make-icon.mjs   # 标改了才要：在 mac 上重出 shell/icons/icon.ico（进仓库）
```

`scripts/build-shell.mjs` 编 `shell/`（Tauri 2、WebView2）再把 `bundle-runtime.mjs` 组装的运行时放到 exe 旁边。Windows 上是普通的 `cargo build`（GitHub 的 windows runner 现成有 MSVC 和 rustup）；mac 上走 cargo-xwin，工具全在 `~/.cache/navi/win-toolchain` 下（装法写在脚本开头），MSVC CRT 和 Windows SDK 由 cargo-xwin 自己下到用户目录，链接用 rust 自带的 rust-lld，Homebrew 的 llvm 只出 clang-cl / llvm-lib / llvm-rc。exe 静态链 vcruntime、只依赖系统自带的 UCRT 和 WebView2（Windows 11 自带）。

### 分工

窗口里该是哪一屏、载哪个地址、什么时候认人，全在 `launcher/`（壳用自带的 node 跑 `controller-main.mjs`，一行一条 JSON 走 stdin/stdout，协议写在 `controller.mjs` 顶部）；Rust 那边只管窗口、托盘、导航、IPC、单实例和起进程。对应关系：

| mac | Windows |
|---|---|
| NaviConfig | `launcher/config.mjs`（一切从 `LOCALAPPDATA` 派生；`NAVI_URL`、`NAVI_DATA_DIR`、`NAVI_WIN_WINDOW_PORT`、`NAVI_WIN_RUNTIME` 是验证用的口子） |
| NaviHealth | `launcher/health.mjs`；导航前的同步认人在 `shell/src/health.rs` |
| ServerLauncher / ServerStartLock | `launcher/launcher.mjs`、`start-lock.mjs`（libuv 的 `UV_FS_O_EXLOCK`，共享模式 0） |
| LaunchFlow / OfflineView / FirstRunView | `launcher/controller.mjs`、`shell/ui/index.html` |
| DeepLink | `launcher/deep-link.mjs`（规则一字不差） |
| LoginService | `launcher/login-item.mjs` |
| RemoteAccessSwitch | `controller.mjs` 的 toggleRemote + `launcher/restart.mjs`（停服务复用 `scripts/platform.mjs`） |

本地那一屏（`http://tauri.localhost/`）和页面（`http://127.0.0.1:<窗口端口>`）是同一个 WebView 里的两份文档：盖一屏就是导航回本地页，所以撤页是真的撤——页面连同它的轮询、SSE 一起没了。本地页拿得到 `shell_screen` / `shell_action`；页面只在载它的时候按窗口端口现加一份能力，只许调 `page_report`（报尺寸、报脚本没载进来）。cookie `navi_instance` 由壳在导航前写上，UA 末尾留 `NaviWin/<版本>`（web 的首启向导据此知道数据那一站已经在壳里走过了）。

### 服务怎么起

同 mac：先认端口上是谁，是自己那份（数据根、代码是发布出来的运行时、`desktop` 标记、在窗口专用端口上听）才载页面；没人就起，被别的 Navi 或别的程序占着就说清楚是谁、怎么停，**不连上去**，对方一停就自动接上。数据根还空着时先问「数据从哪儿来」。窗口专用端口按数据根的真实路径算（算法同 mac，Windows 上先折成小写）。

第一次打开（或换了版本）要先把运行时发布到 `runtimes\<sha256>\`：上万个小文件拷过去再逐个算 sha256，测试机上要好几分钟。校验全是同步调用，放在 worker 线程里跑，窗口照常应答，并且明说「要几分钟」。

服务和壳解绑：关窗只是收进托盘；退出壳、壳被强杀，服务和 agent 都照常跑。进程层是 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`；Job 层 node 做不到（libuv 的 detached 不带 `CREATE_BREAKAWAY_FROM_JOB`），所以真正拉起服务的是 `Navi.exe --spawn-detached`（`shell/src/spawn.rs`）：带 breakaway 起；所在的 Job 不许脱离时，关掉会连带结束子进程的就不起并说清楚，不会的就留在里面起。测试机上实测：从资源管理器、开始菜单打开的程序都在 explorer 给的 Job 里（LimitFlags `0x1800`：允许脱离、不连带结束），服务照常脱离出去；Navi 自己的应用内终端（node-pty ConPTY）里起的进程在 `0x2000` 的 Job 里（连带结束、不许脱离），从那里打开 `Navi.exe` 会被拒并说明原因——这也是 `remote-smoke.mjs --shell` 要经 explorer 跑检查的原因。起服务时还用 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 点名只让它继承日志文件和 NUL：Windows 的子进程默认继承父进程全部可继承句柄，服务要是攥着拉起 Navi.exe 那一方的管道，读管道的人就永远等不到结束（真机上实测卡到超时过）。PATH 每次从注册表现读（系统在前、用户在后），用户刚装的 claude / codex 的 `.cmd` 垫片就找得到；环境变量名按不分大小写折叠后替换。

### 托盘

显示 Navi / 在浏览器中打开 / 日志 / 允许其他设备访问 / 登录时启动 Navi 服务 / 关于 / 退出。「允许其他设备访问」同 mac：先问重启会打断谁（列出来），确认后攥住维护锁、**让服务冻结接活**（`/api/restart-freeze`，server/src/restart-freeze.ts），拿冻结之下的快照比：多出了会打断的任务（确认框开着时别处又起了任务）、变得确认不了、换了一份服务，就放开冻结、松锁把新名单重新摆出来；照旧才凭这份快照只停评估过的那一份（下刀前续一次期、确认冻结还在），冻着的时候不起新回合，停下之前名单不会再变多；确认停下了才把设置落盘再按它起。老版本服务不认这道关口时退回即时再评估，确认框里如实说这一下堵不上；在跑的服务没按设置起时菜单写「（重启服务后生效）」。打开时多提醒一句 Windows 防火墙会问。

### 登录时启动：为什么是 Run 项不是计划任务

写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `Navi`（`"<exe>" --start-server`），不用 schtasks：

- 不要管理员——「登录时」触发的计划任务要提权，per-user 安装要的就是不提权；
- 不进 Job——计划任务的进程跑在任务计划程序的 Job 里，任务被结束（手动结束、默认 72 小时执行时限）时整个 Job 一起收掉；Run 项由 explorer 拉起，没有这层牵连；
- 用户看得见、关得掉——任务管理器「启动应用」页列的就是它，在那里停用记在 `StartupApproved\Run`，读到就按「没开」显示，也不替用户重写（重写会把停用标记清掉）。

只在装在 `%LOCALAPPDATA%\Programs\` 下（安装包的位置）时第一次打开默认勾上；便携版解压目录随时会删，不登记。数据根还空着时 `--start-server` 不起。

### navi:// 与单实例

第二次打开 `Navi.exe`（带不带 `navi://` 链接）都交给已经开着的那一份、自己退出（tauri-plugin-single-instance）。链接规则同 mac：只认 `project` / `task` / 指纹 / 指着同一任务的 `fallback`，指纹对上在窗口里原地换路由，对不上交给浏览器。**scheme 的注册还没做**：要写 `HKCU\Software\Classes\navi`，归安装包那一步（卸载时也要删）。

### 还没做

- 导入旧数据（mac 首启那一屏的「从旧数据导入」）、ComputerPreview：第一版不做，首启只有「全新开始」；
- MCP 的 `current` 指针与启动器、换运行时的接管（handover）、自动更新、安装包和 scheme 注册：在后面「安装包与更新」那一步，服务端 `runtime-compatibility.ts`、`mcp-registry/desktop-runtime.ts` 里写死 `.mac-runtimes` 的几处到时一起改；
- 窗口位置记忆；

### 验证

`scripts/test-windows-shell.mjs`、`test-windows-shell-controller.mjs`（mac 上跑，挂在 `test:accept-scripts`）：配置、认人、链接、登录项、服务环境、启动锁、维护标记；假运行时真发布、真拉起；控制器和壳之间的整套来回。真窗口、Job、注册表、4317 被占要在 Windows 上跑 `scripts/shell-check.mjs`（`remote-smoke.mjs --shell` 送过去）：首启按元素点「全新开始」→ 认人 → 页面经 IPC 表态 → 按元素关窗后壳和服务都在 → 第二次打开带链接时单实例转交、指纹对上在窗口里换到那一页、页面报回的地址和页面上的一致 → 强杀壳后服务还是同一个进程 → 再打开接上、不另起 → `--start-server` → 默认端口 4317 被别的 Navi 占着时说清楚、不碰它；另外验启动锁跨进程互斥、注册表 PATH 找得到并跑得起 claude 和 codex（`.cmd` 垫片经 cmd）、Run 项读写、`--spawn-detached` 在三种 Job 处境下的行为。
