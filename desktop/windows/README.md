# Navi for Windows

对等于 mac 版（`desktop/macos`）的 Windows 版：装完即用、不依赖仓库检出和系统 node、个人自用默认只听本机。只出 x64、per-user（不要管理员）。这一节目前只有**自带运行时**；壳（Tauri v2）、安装包与更新、云端发版在后面几步。

## 自带运行时

```bash
npm run bundle:win-runtime                     # → desktop/windows/build/runtime（在 mac 上就能做）
WIN_REMOTE_KEY=… npm run smoke:win-runtime:remote   # 送到测试机 192.168.1.187 上跑冒烟
WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --reclaim   # 只清上次没清完的对端目录
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

这个目录归开发机管，不归对端那条命令管（`scripts/remote-scratch.mjs`）：命令期限一到，win-remote 连对端的收尾代码一起切掉；开发机被 Ctrl-C、被杀，或者断了线，那段收尾也一样走不到。所以 `<id>` 由开发机生成，送命令之前先记进本机账本（`~/.cache/navi/win-remote-smoke/<id>.json`，在仓库之外，worktree 删了它还在）。命令不论怎么结束，都另起一次结算，一条账上的三样责任分开核实，全部核实了才销账：每个终端会话（主命令的、清理请求自己的，会话一建好就记上）都关掉（404 也算）；命令行或可执行文件路径里带这个目录名的进程都结束掉（对端真正干活的是目录里 `run.ps1` 起的那个 powershell，所以它和它起的一切都认得出来；进程表查不出来不算「一个都没有」）；目录删掉并核实不在。按第一下 Ctrl-C 先中止那条命令：rexec 删掉终端会话，对端整棵进程树随之结束，结算完再退。没结清就留账，下一次 `remote-smoke`（或 `--reclaim`）开头替属主已经不在的那几条结算。账本写入走临时文件加改名，读到不完整、缺字段的记录一律当身份未知：报出来、原样留着，不据此碰对端；目标机器按记账时解析出的地址记下。本机的打包暂存同样带属主记录，下一次收掉。
