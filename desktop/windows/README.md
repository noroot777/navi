# Navi for Windows

对等于 mac 版（`desktop/macos`）的 Windows 版：装完即用、不依赖仓库检出和系统 node、个人自用默认只听本机。只出 x64、per-user（不要管理员）。由三层组成：**自带运行时**（node + server/web/mcp）、**桌面壳**（Tauri v2、WebView2）、**安装包与自更新**（NSIS、Tauri updater，云端发版）。

```bash
npm run build:win                    # → desktop/windows/build/{Navi-<版本>-x64-setup.exe, Navi\}（mac 上交叉编译）
npm run release:win -- 0.1.0         # 发一版：交给 GitHub Actions 构建、冒烟、签名、发布（见「发版」）
```

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
npm run build:win                    # → desktop/windows/build/Navi\{Navi.exe, runtime\}（便携版）+ 安装包；mac 上交叉编译
WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --shell     # 送到测试机上跑 shell-check.mjs
node desktop/windows/scripts/make-icon.mjs   # 标改了才要：在 mac 上重出 shell/icons/icon.ico（进仓库）
```

`scripts/build-shell.mjs` 编 `shell/`（Tauri 2、WebView2）再把 `bundle-runtime.mjs` 组装的运行时放到 exe 旁边。Windows 上是普通的 `cargo build`（GitHub 的 windows runner 现成有 MSVC 和 rustup）；mac 上走 cargo-xwin，工具全在 `~/.cache/navi/win-toolchain` 下（装法写在脚本开头），MSVC CRT 和 Windows SDK 由 cargo-xwin 自己下到用户目录，链接用 rust 自带的 rust-lld，Homebrew 的 llvm 只出 clang-cl / llvm-lib / llvm-rc。exe 静态链 vcruntime、只依赖系统自带的 UCRT 和 WebView2（Windows 11 自带）。

### 分工

窗口里该是哪一屏、载哪个地址、什么时候认人，全在 `launcher/`（壳用自带的 node 跑 `controller-main.mjs`，一行一条 JSON 走 stdin/stdout，协议写在 `controller.mjs` 顶部）；Rust 那边只管窗口、托盘、对话框、导航、IPC、单实例、起进程，以及更新的查、下、验签（`shell/src/update.rs`）。对应关系：

| mac | Windows |
|---|---|
| NaviConfig | `launcher/config.mjs`（一切从 `LOCALAPPDATA` 派生；`NAVI_URL`、`NAVI_DATA_DIR`、`NAVI_WIN_WINDOW_PORT`、`NAVI_WIN_RUNTIME` 是验证用的口子） |
| NaviHealth | `launcher/health.mjs`；导航前的同步认人在 `shell/src/health.rs` |
| ServerLauncher / ServerStartLock | `launcher/launcher.mjs`、`start-lock.mjs`（libuv 的 `UV_FS_O_EXLOCK`，共享模式 0） |
| LaunchFlow / OfflineView / FirstRunView | `launcher/controller.mjs`、`shell/ui/index.html` |
| DeepLink | `launcher/deep-link.mjs`（规则一字不差） |
| LoginService | `launcher/login-item.mjs` |
| RemoteAccessSwitch | `controller.mjs` 的 toggleRemote + `launcher/restart.mjs`（停服务复用 `scripts/platform.mjs`） |
| Updater（Sparkle） | `launcher/updates.mjs`（什么时候查、问不问）+ `shell/src/update.rs`（tauri-plugin-updater） |
| UpdateGate 的换服务 | `launcher/handover.mjs`、`launcher/db-backup.mjs` |

本地那一屏（`http://tauri.localhost/`）和页面（`http://127.0.0.1:<窗口端口>`）是同一个 WebView 里的两份文档：盖一屏就是导航回本地页，所以撤页是真的撤——页面连同它的轮询、SSE 一起没了。本地页拿得到 `shell_screen` / `shell_action`；页面只在载它的时候按窗口端口现加一份能力，只许调 `page_report`（报尺寸、报脚本没载进来）。cookie `navi_instance` 由壳在导航前写上，UA 末尾留 `NaviWin/<版本>`（web 的首启向导据此知道数据那一站已经在壳里走过了）。

### 服务怎么起

同 mac：先认端口上是谁，是自己那份（数据根、代码是发布出来的运行时、`desktop` 标记、在窗口专用端口上听）才载页面；没人就起，被别的 Navi 或别的程序占着就说清楚是谁、怎么停，**不连上去**，对方一停就自动接上。数据根还空着时先问「数据从哪儿来」。窗口专用端口按数据根的真实路径算（算法同 mac，Windows 上先折成小写）。

第一次打开（或换了版本）要先把运行时发布到 `runtimes\<sha256>\`：上万个小文件拷过去再逐个算 sha256，测试机上要好几分钟。校验全是同步调用，放在 worker 线程里跑，窗口照常应答，并且明说「要几分钟」。

服务和壳解绑：关窗只是收进托盘；退出壳、壳被强杀，服务和 agent 都照常跑。进程层是 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`；Job 层 node 做不到（libuv 的 detached 不带 `CREATE_BREAKAWAY_FROM_JOB`），所以真正拉起服务的是 `Navi.exe --spawn-detached`（`shell/src/spawn.rs`）：带 breakaway 起；所在的 Job 不许脱离时，关掉会连带结束子进程的就不起并说清楚，不会的就留在里面起。测试机上实测：从资源管理器、开始菜单打开的程序都在 explorer 给的 Job 里（LimitFlags `0x1800`：允许脱离、不连带结束），服务照常脱离出去；Navi 自己的应用内终端（node-pty ConPTY）里起的进程在 `0x2000` 的 Job 里（连带结束、不许脱离），从那里打开 `Navi.exe` 会被拒并说明原因——这也是 `remote-smoke.mjs --shell` 要经 explorer 跑检查的原因。起服务时还用 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 点名只让它继承日志文件和 NUL：Windows 的子进程默认继承父进程全部可继承句柄，服务要是攥着拉起 Navi.exe 那一方的管道，读管道的人就永远等不到结束（真机上实测卡到超时过）。PATH 每次从注册表现读（系统在前、用户在后），用户刚装的 claude / codex 的 `.cmd` 垫片就找得到；环境变量名按不分大小写折叠后替换。

### 托盘

显示 Navi / 在浏览器中打开 / 日志 / 允许其他设备访问 / 登录时启动 Navi 服务 / 检查更新… / 切换到新版服务…（只在装了新版、服务还在旧运行时上时出现）/ 关于 / 退出。「允许其他设备访问」同 mac：先问重启会打断谁（列出来），确认后攥住维护锁、**让服务冻结接活**（`/api/restart-freeze`，server/src/restart-freeze.ts），拿冻结之下的快照比：多出了会打断的任务（确认框开着时别处又起了任务）、变得确认不了、换了一份服务，就放开冻结、松锁把新名单重新摆出来；照旧才凭这份快照只停评估过的那一份（下刀前续一次期、确认冻结还在，并拿续期带回的此刻名单再比一次：已经在跑的 agent 中途拉起 MCP 这种服务端冻不住，多了就不停），冻着的时候不起新回合、新终端、新 agent；名单里也算随服务一起关掉的终端、聊天、AI 协助、预览试跑。最后一次续期核对到真正停下之间，已在跑的 agent 新发起的 Navi MCP 调用不再靠核对：Windows 停服务是整树结束、没有排空，处理中被截断的调用由 MCP 带请求号重试到新服务上，服务端按请求号回放答复、认回执行到一半的交卷那一笔、认不出的如实答「不确定」（server/src/request-receipts.ts），不丢也不做两遍；确认停下了才把设置落盘再按它起。老版本服务不认这道关口时退回即时再评估，确认框里如实说这一下堵不上；在跑的服务没按设置起时菜单写「（重启服务后生效）」。打开时多提醒一句 Windows 防火墙会问。

### 登录时启动：为什么是 Run 项不是计划任务

写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `Navi`（`"<exe>" --start-server`），不用 schtasks：

- 不要管理员——「登录时」触发的计划任务要提权，per-user 安装要的就是不提权；
- 不进 Job——计划任务的进程跑在任务计划程序的 Job 里，任务被结束（手动结束、默认 72 小时执行时限）时整个 Job 一起收掉；Run 项由 explorer 拉起，没有这层牵连；
- 用户看得见、关得掉——任务管理器「启动应用」页列的就是它，在那里停用记在 `StartupApproved\Run`，读到就按「没开」显示，也不替用户重写（重写会把停用标记清掉）。

只在装在 `%LOCALAPPDATA%\Programs\` 下（安装包的位置）时第一次打开默认勾上；便携版解压目录随时会删，不登记。数据根还空着时 `--start-server` 不起。

### navi:// 与单实例

第二次打开 `Navi.exe`（带不带 `navi://` 链接）都交给已经开着的那一份、自己退出（tauri-plugin-single-instance）。链接规则同 mac：只认 `project` / `task` / 指纹 / 指着同一任务的 `fallback`，指纹对上在窗口里原地换路由，对不上交给浏览器。`navi://` 由安装包登记（见「安装包」）。

### 验证

`scripts/test-windows-shell.mjs`、`test-windows-shell-controller.mjs`（mac 上跑，挂在 `test:accept-scripts`）：配置、认人、链接、登录项、服务环境、启动锁、维护标记；假运行时真发布、真拉起；控制器和壳之间的整套来回。真窗口、Job、注册表、4317 被占要在 Windows 上跑 `scripts/shell-check.mjs`（`remote-smoke.mjs --shell` 送过去）：首启按元素点「全新开始」→ 认人 → 页面经 IPC 表态 → 按元素关窗后壳和服务都在 → 第二次打开带链接时单实例转交、指纹对上在窗口里换到那一页、页面报回的地址和页面上的一致 → 强杀壳后服务还是同一个进程 → 再打开接上、不另起 → `--start-server` → 默认端口 4317 被别的 Navi 占着时说清楚、不碰它；另外验启动锁跨进程互斥、注册表 PATH 找得到并跑得起 claude 和 codex（`.cmd` 垫片经 cmd）、Run 项读写、`--spawn-detached` 在三种 Job 处境下的行为。

## 安装包

`build-shell.mjs` 走 `cargo tauri build --bundles nsis`，Tauri 的 NSIS 模板加 `installer/` 里的定制（`hooks.nsh`、中文文案 `SimpChinese.nsh`、动目录前跑的 `installdir.ps1`），出 `Navi-<版本>-x64-setup.exe`：

- **per-user、不要管理员**，默认装到 `%LOCALAPPDATA%\Programs\Navi`（模板给 per-user 的默认是 `%LOCALAPPDATA%\Navi`，那是数据根、运行时仓库所在的那块地，装进去卸载时就和数据搅在一起；登录项也只认 Programs 下的位置）。开始菜单一个快捷方式，「应用和功能」里一条卸载项（`HKCU\…\Uninstall\Navi`）。
- **`navi://`**：tauri-plugin-deep-link 的安装段按实际安装位置写 `HKCU\Software\Classes\navi`（`"<安装目录>\Navi.exe" "%1"`）；覆盖安装、更新都重写成当前位置；卸载时只删指着本安装目录的那一份（别处装的一份不被误删）。
- **覆盖安装 / 更新不停服务**：安装目录里只有壳和运行时发布源，服务和 agent 跑在 `%LOCALAPPDATA%\Navi\runtimes\<sha256>\` 发布出来的那份里，安装包不碰它们。动目录前等壳和它的控制器（安装目录里那份 node）退干净：壳 15 秒不退就结束它；控制器从来不杀——壳一没它就收尾、做完自己退，它可能正在做一趟撤不回的换服务、是唯一会把新版服务起起来的那一个，安装包看不出来，也没有哪种「没看到」能证明它没在做。等它最多 4 分钟，还在就这次不装不卸、列出是谁（`installdir.ps1` 退出码 6）。别的程序还占着安装目录里的文件就不装、说出是谁（进程号和映像名）。旧版的 `runtime\` 先整个删掉：内容清单要和目录一字不差，旧版多出的文件留着，新版第一次发布就校验不过。
- **卸载不停服务、不悄悄删数据**：卸载页有一个默认不勾的「同时删除任务、设置和运行时（%LOCALAPPDATA%\Navi）」。勾了也只在没有进程还用着那块地时删：先整块改名（有文件开着就改不了），改成了再删；服务还在跑就不删、说清楚。静默卸载（`/S`）永远不删数据。登录项（Run 项）随卸载删掉，更新模式（`/UPDATE`）保留。
- 安装包没有 Authenticode 签名，首次打开时 Windows 可能显示 SmartScreen 拦截页。若出现，可查看「更多信息」确认程序，再选择「仍要运行」。更新使用 updater 的签名（下一节）。
- **Defender 的行为检测**：真机演练时，装在 `%TEMP%` 下的一版演练 exe 首启把自己写进 Run 项（登录项）后约一分钟，被判成 `Behavior:Win32/Persistence.A!ml`（机器学习的「持久化」行为检测）：exe、开始菜单和桌面快捷方式被删、进程被结束。之前五版同样的演练 exe 没被判，换了哈希的这一版连判三次，所以是概率性的。正式安装在 `%LOCALAPPDATA%\Programs\` 下、可疑程度低一些，但同样是「没签名的程序第一次打开就登记开机自启」，没法排除。能根治的是 Authenticode 签名；不签的话，可选的是把「第一次打开默认勾上登录项」改成用户自己勾（见「还没做」）。

`smoke-installer.mjs`（云端构建在 windows runner 上跑；本机 `npm run smoke:win-installer -- <安装包>`）：机器上已经装着 Navi 就拒跑；静默装 → 核对卸载项、`navi` 协议、开始菜单 → 用装进去的那份运行时跑一遍运行时冒烟 → `uninstall.exe /S` → 核对都收掉了、数据根里的标记文件还在。

## 自更新

Tauri updater（`tauri-plugin-updater`，`shell/src/update.rs`）。托盘「检查更新…」，另外起来 1 分钟后查一次、之后每 6 小时一次（`launcher/updates.mjs`）。两个公开仓库，都在 `release.json`：

- **安装包**在 [noroot777/navi](https://github.com/noroot777/navi) 的 Release `navi-win-v<版本>` 上，`Navi-<版本>-x64-setup.exe`。新用户下载安装的、更新用的是同一个文件。
- **更新清单**是素材库 [noroot777/materials](https://github.com/noroot777/materials) 的 `navi/win/latest.json`（Tauri 的静态 JSON：版本、说明、日期、`windows-x86_64` 的地址和签名），壳里编的是它在 raw.githubusercontent 上的地址。

**只靠 updater 签名**（minisign，ed25519）：公钥在 `release.json` 的 `publicKey`，编进壳；私钥只在 GitHub Secret 里。签名的可信注释里带着版本号（`--app-version`，壳开了 `requireSignedVersion`），拿旧版的合法签名配新清单也装不上。公钥随第一版发出去后**永远不能换**：已装的壳只认它。

查到新版就问：「现在更新」「跳过这一版」「以后再说」，关掉对话框按「以后再说」算；跳过的版本记在 `settings.json` 的 `skippedVersion`，自动检查不再问它，手动检查照样摆出来。点了更新，窗口盖上下载进度，下完验签，壳把安装包以 `/P /UPDATE` 交给系统、自己退出，安装包装完重开 Navi。验签不过、下不下来就不装、说清楚，现在这一版照常用。查一次最多 30 秒，下载最多 15 分钟、300 MB。壳收到字节就报一次心跳（至多一秒一次，有总长度才带百分比，没有就报收到多少），一分半没收到一个字节、或者壳那边过了期限没回话，控制器就叫壳收掉那一趟；下载那一屏的「取消」走同一条路。取消由壳裁决（`updateCancel` → `updateCancelResult`，按请求号认人，和「下完去装」抢同一把锁）：它说收掉了，页面才回来；它说已经在装（或者壳先报了「进了安装」），那一屏就改成「正在安装」、不再有取消按钮。整趟只有一个最终期限，哪个阶段都消耗不掉：到点还在下就叫壳收掉，再过 30 秒的余量不管停在哪儿都收场；壳认过的结局说「没装上」，壳没答、或者一直停在「正在安装」说「结果不明」（安装程序可能还在跑；壳在它结束前不会开始第二次安装）。请求号带着这一代控制器的标识，控制器退出时壳收掉还在下的那一趟。下更新、换到新版服务、按新设置重启服务三件事互斥（都要占窗口那一屏、都要动服务），一件在做，另外两件说明是谁占着、不开始。

### 装之前那道闸：换到新版服务

**换的只是壳**：安装包覆盖安装目录的那几十秒里，服务和 agent 照常跑（见「安装包」）。新壳起来认出端口上是自己那份、跑的却是旧运行时，就在 `launcher/handover.mjs` 里每 5 秒问一次旧服务「现在能不能无损交接」（`/api/restart-impact?protocol=&schema=&shutdown=1`，带着新运行时 `.handover.json` 里的协议和 schema）：

- `runtimeHandover.blocked`：新版接不住的回合（排队中、团队回合、协议或 schema 不兼容……），判据与 mac 同一份（`server/src/runtime-handover.ts`）；
- `shutdown.resources`：旧服务一停就跟着没的东西——应用内终端、项目服务、预览试跑。Windows 上它们是服务的子进程，停服务就断，所以**在跑的终端命令、开着的预览都算阻挡**，等它们结束。

有一样不空就留在旧服务上，菜单出现「切换到新版服务…」，日志写明在等谁；答复不足以下结论（旧服务太旧、没核对目标）也按等待算。都空了才切：攥住维护锁 → 向点名的旧实例申请 60 秒接管许可（`POST /api/runtime-handover`，带 `holdResources`：服务端封口之后再看一次终端这些，有就不发许可）→ 给库留底 → 兑现许可（`{ commit }`：核验许可和下线在旧服务里是同一步，兑现了它就自己退出，不再到期、也撤不回——不会解封接了新活、再被照旧答复停掉，也不会留一个「封着等人来停」的状态）→ 等它退干净（没退就停掉那一份，agent 的进程树保住）→ 松锁，窗口重连时用新运行时起服务，新服务按 pid 认回 detached 的 agent。旧服务交出去以后，起新版是控制器的事（`launcher/handover-duty.mjs`）：兑现许可、强制切换的停服务都撤不回，所以**发出去之前**就记下「得有人接着起新版」，答复丢了、超时了也不当成没执行。兑没兑现只认旧服务自己的答复，不靠这边计时、探活去猜：兑现是幂等的，许可一旦到期（许可答复里带着最晚兑现时刻 `expiresAt`）或归还就再也兑现不了，所以没收到答复就接着兑现——它答「兑现了」才等它退、没退才停；答「兑现不了」、或者归还许可成功，就是没兑现、以后也不会；它的进程没了就当下线了。过了最晚兑现时刻还问不到答案（它卡住了、一直 503）就不切、绝不去停它，责任留着，等它再答话时再问一次。看到端口上是另一份服务、或者问到它没兑现，才算结清。这时从托盘退出、壳崩了（控制器的 stdin 断了），控制器先把这一趟做完，还欠着就一直起新版（整趟最多一分半，每一次起都只给剩下的时间）；还起不来就在 `%LOCALAPPDATA%\Navi` 下留一张纸条，下次打开 Navi、服务有了结局时照实说给用户（这次起来了没有），用户看过才删。中途哪一步不成都不停旧服务，撤销许可回去接着等；连着 4 次拿不到许可就不再自动试，菜单改成「重试切换到新版服务…」。

不想等时从菜单「切换到新版服务…」：把会被打断的列出来，「现在切换」/「继续等」，关掉对话框按「继续等」。用户点的是那一刻的那一份服务、那一张名单：先重新发布、校验一遍新版运行时，再在维护锁下认一遍是不是同一份服务，然后带着他确认过的那张（`accept`）去拿许可——旧服务先封口（新请求、新终端都进不来），封口之后再看一遍会打断谁，多了他没见过的就不发许可、当场解封，这边按现在的名单再问他一次；都在他确认过的里面，打断的也只有这几项：别的能接管的任务照样先停到输出检查点（正文、水位落盘），之后再核一遍名单，变了同样不发；这才发许可，之后跟自动切换一样留底、兑现、它自己退出，封口一直保持到那时。只在这边查一遍名单再去停不行：查完到停下之间旧服务照样能接新终端、新任务。对着「确认不了」点的，按一项都没确认过算：封口之后有会被打断的，就列出来再问。新版运行时没发布好（发布、校验失败，或者包里没有接管协议）不是「会打断谁」的问题，不给「现在切换」：旧服务一停新版起不来，所以只说明原因，旧服务照常。

### 更新前的库备份

server 一起来就做不可逆的迁移，所以停旧服务之前用 SQLite 在线备份留一份底：`<数据根>\backups\<UTC 时间>-win-<旧运行时 id 前 12 位>.db`（`launcher/db-backup.mjs`，`node:sqlite` 的 `backup`，写完改名，半截的不会冒充备份），只留最近 5 份。第一版没有 mac 那套恢复点与自动回退；新版起不来时回到旧版：

```powershell
# 1. 托盘「退出 Navi」，停掉服务（数据根里库的单例锁记着 pid）
cd $env:LOCALAPPDATA\Navi\data
Stop-Process -Id (Get-Content navi.db.navi.lock | ConvertFrom-Json).pid
# 2. 从 noroot777/navi 的 Releases 下回旧版安装包（tag navi-win-v<版本>），装上（降级要先卸载；卸载时别勾删数据）
# 3. 把底放回去（先挪开现在这份，别直接覆盖）
mkdir rolled-back; Move-Item navi.db, navi.db-wal, navi.db-shm rolled-back\ -ErrorAction SilentlyContinue
Copy-Item backups\<那一份>.db navi.db
# 4. 打开旧版；它下次查更新时会再问，点「跳过这一版」
```

## 发版

```bash
npm run release:win -- 0.1.0
```

同 mac（`scripts/cloud-release.mjs`，通用部分在 `desktop/shared/`）：工作区干净、在 `main` 上，先核对版本、工作流和远端是否领先（不自动合并、不强推）；只改 `shell/tauri.conf.json` 的 `version`、单独提交版本号、正常 push，再把完整源码 SHA 和版本交给 GitHub Actions 的 **Release Windows**（`.github/workflows/release-win.yml`）。输出任务地址后就可以关电脑。重复执行不重复提交；同一源码和版本的任务在跑就返回它，失败了就重跑它。

### 一次性配置

1. 把 `release-win.yml` 合进 GitHub 的 `main`、启用 Actions。
2. `noroot777/navi → Settings → Secrets and variables → Actions` 加两项 Repository secrets：

| 名称 | 内容与权限 |
|---|---|
| `WIN_RELEASE_TOKEN` | fine-grained PAT，只选 `navi`、`materials`，Contents: Read and write；传安装包、提交更新清单共用。可以和 `MAC_RELEASE_TOKEN` 是同一张。 |
| `WIN_UPDATER_PRIVATE_KEY` | updater 私钥文件的全文（`cargo tauri signer generate` 出的那一行 base64，空密码）。 |

3. 本地要有 `navi` Actions 读写权限的凭证（查找顺序同 mac：`GH_TOKEN` / `GITHUB_TOKEN` → `gh auth token` → git 的 github.com 凭证）。
4. 先在 Actions 里 **Release Windows → Run workflow** 选 main、填版本和完整 SHA、关掉 `publish` 做一次云端构建演练。

`release.json` 里那把公钥对应的私钥在开发机的 `~/.config/navi/win-updater.key`（权限 600，仓库之外）。交接：

```bash
gh secret set WIN_UPDATER_PRIVATE_KEY -R noroot777/navi < ~/.config/navi/win-updater.key
# 再把这个文件存进密码管理器做离线备份，然后删掉本机这份
```

私钥不进仓库、不进日志：云端只在发布那一步写成 `RUNNER_TEMP` 下 0600 的临时文件，成败都删，不进产物、缓存和子进程环境（`cloud-workflow.mjs` 的 `withSigningKey`）。丢了私钥就再也发不出已装用户认的更新，只能让他们手动装新公钥的版本。

### 云端与恢复

两段分开：**build**（windows-latest）从指定 SHA 检出（只接受 main 上的、版本与源码一致的）、`npm ci`、装钉死版本的 tauri-cli、`build-shell.mjs`、核对安装包（大小、sha256、PE 头、里面的运行时 id）、`smoke-installer.mjs` 真装真卸一遍，然后把原包存成产物 `win-release-<run id>`（留一天）。这一段**没有任何发布凭证**，`publish=false` 跑完就停。**publish** 段只在 `publish=true` 时跑：取回原包（不重新构建）→ 签名 → 用 `release.json` 的公钥验过 → 核对两个仓库都写得了、清单分支没有保护规则 → 草稿 Release → 传包 → 下回核对 → 公开、核对 tag → 从公开地址下回核对 → 带原文件 SHA 提交 `latest.json`（冲突就拒绝覆盖）。

版本只能往前；同一版只能是同一个提交、同一个包（清单记着 sha256），重跑只补没做完的步骤，不重签不重传。包公开后不撤回。原产物过期且 Release 已存在时停下，改发新版本。缓存只有 npm 内容缓存、cargo 注册表和 tauri-cli，不含产物和凭证。

### 本机备用

```bash
node desktop/windows/scripts/release.mjs --installer <安装包> --version <v> --commit <完整 sha> --key-file <私钥> [--notes '…']
```

与云端 publish 段是同一个脚本。

### 本地演练

`scripts/drill-build.mjs` 在 mac 上交叉编一旧一新两版（0.0.1 → 0.0.2）、用一把临时密钥签、本地出更新清单；`remote-smoke.mjs --install` 把它们送到测试机，经 explorer 跑 `scripts/install-check.mjs`：

```bash
WIN_REMOTE_KEY=… node desktop/windows/scripts/drill-build.mjs          # → desktop/windows/build/drill/payload
WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --install desktop/windows/build/drill/payload
```

演练里的登录项先设成「用户选过、不开」，不写 Run 项（上面 Defender 那条就是在演练里撞上的）；登录项第一次打开默认登记、更新后保留，在撞上之前的一轮真机演练里验过。不碰日常那一份：演练版把 `LOCALAPPDATA`、`USERPROFILE`、`APPDATA`、`NAVI_URL`（14977 端口）编进 exe（`NAVI_WIN_REHEARSAL_ENV`；只交给控制器和壳自己取值用，不写进壳的进程环境——经 ShellExecute 打开的浏览器、安装包继承的是壳的环境，写进去浏览器就在演练目录里建一份新配置、一直占着目录），数据根、运行时仓库、安装目录都落在 `%TEMP%\navi-win-runtime-<id>\` 下；更新源是对端 127.0.0.1:14981 上的临时 HTTP。临时私钥在开发机的临时目录里，编完就删。

`install-check.mjs` 依次验：静默装 0.0.1 → 卸载项、`navi` 协议、开始菜单都指着安装目录 → 打开、按元素点「全新开始」、服务起来（登录项按设置不登记） → 建项目、开终端跑一条一直输出的命令 → 等到「Navi 0.0.2 可以更新了」点「现在更新」→ 旧壳退出、新壳起来，协议还在、登录项没被替用户打开 → 服务**还是同一个进程、还在旧运行时上**，日志写着在等那个终端，终端还在出新输出 → 关掉终端 → 服务换到新运行时、留了一份库的底、项目还在 → `navi://` 链接：窗口开着时原地换路由；指纹对不上交给默认浏览器、浏览器真的请求了 fallback 地址（浏览器本来开着时，那里会多一个标签页）；窗口没开时先起壳再载那一页 → 静默卸载，数据根还在。链接一律经 ShellExecute 打开（`Start-Process`，同用户在别的程序里点链接）：`explorer.exe <链接>` 在真机上根本不调协议处理程序。对话框（TaskDialog）的按钮在 UIA 里不支持 Invoke，演练按文字找到对话框里那个 Win32 按钮窗口发 `BM_CLICK`。收尾不论成败：结束演练的进程（含演练另起的浏览器）、只删指进演练目录的注册表项、删快捷方式，最后核对对端 4317 上原来那份 Navi 还是原来的进程。

## 还没做

- 导入旧数据（mac 首启那一屏的「从旧数据导入」）、ComputerPreview：第一版不做，首启只有「全新开始」；
- 新版起不来时的自动回退（mac 的恢复点、`.mac-runtime-paused.json`）：第一版只留库的底，回退靠手动（见「更新前的库备份」）；
- 不再用的旧运行时目录不自动回收；
- 固定下载页（mac 的 `navi-mac-latest`）：下载先指 Releases 列表；
- Authenticode 签名（也是上面 Defender 误判的根治办法）；登录项现在仍是装好后第一次打开默认勾上（② 定的），要不要改成用户自己勾待定；
- 窗口位置记忆。
