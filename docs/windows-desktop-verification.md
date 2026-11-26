# Windows 桌面真机验证

2026-11-26，在 Windows 11 家庭版的已解锁交互桌面上操作。安装包由 macOS 交叉构建，经 win-remote 传到 Windows，并在两端核对 SHA-256。窗口和安装向导通过 PowerShell 5.1 的 UI Automation 操作，原生菜单和按钮按可见名称和控件句柄操作。截图使用 System.Drawing 抓屏。

桌面版沿用每用户默认安装路径，以覆盖开始菜单和登录项。测试实例使用单独的数据根、服务端口 `14971` 和窗口端口 `14972`。原 Navi 使用 `4317`、PID `10808` 和 `D:\ai_workspace\ash\data`。

## 首启找不到启动器依赖

**已修复。** 从原包安装后，在开始菜单打开 Navi。窗口显示「Navi 的启动器退出了」和 `ERR_MODULE_NOT_FOUND`，点「重试」仍会加载同一份缺文件的运行时。[安装器](windows-desktop-verification/installer-complete.jpg) · [启动失败](windows-desktop-verification/missing-runtime-module.jpg)

`launcher/restart.mjs` 引用了 `scripts/restart-freeze.mjs`，Windows 打包清单没有收录该文件。运行时的哈希只验证已打进去的文件，旧构建可以顺利封包。修复将模块加入包内，并在封清单前从组装目录运行真实控制器入口，提前拦下缺失的直接和间接导入。先用仍缺文件的运行时确认构建检查报出同一错误，再补齐模块完成交叉构建和真机重装。[打包脚本](../desktop/windows/scripts/bundle-runtime.mjs)

## 桌面流程

| 场景 | 操作与结果 | 截图 |
| --- | --- | --- |
| 安装 | 启动 NSIS 向导，接受 `%LOCALAPPDATA%\Programs\Navi`，完成每用户安装。系统登记了开始菜单快捷方式、卸载项和 `navi://`。 | [欢迎页](windows-desktop-verification/installer-launch.jpg) · [默认目录](windows-desktop-verification/installer-directory.jpg) |
| SmartScreen | 两份无 Authenticode 签名的安装包均写入 `Zone.Identifier`、`ZoneId=3` 后经 Explorer 启动。这台机器两次都直接显示安装向导，SmartScreen 拦截页未出现。属于本机系统行为，本次没有覆盖拦截后的按钮。 | [带 Internet 区域标记的安装包启动结果](windows-desktop-verification/installer-launch.jpg) |
| 开始菜单 | 搜索 `Navi`，最佳匹配为新安装的应用。经该开始菜单快捷方式启动，进入首启。 | [开始菜单搜索结果](windows-desktop-verification/start-menu.jpg) |
| 窗口和 WebView2 | 修复包的「全新开始」页面正常显示。运行时准备完成后，窗口加载 `http://127.0.0.1:14972/`，能操作设置向导和工作区。两个健康检查返回同一个测试进程。 | [首启](windows-desktop-verification/first-run.jpg) · [准备运行时](windows-desktop-verification/runtime-publishing.jpg) · [WebView2 向导](windows-desktop-verification/webview.jpg) |
| 托盘 | 从通知区展开隐藏图标，打开 Navi 的上下文菜单。点击「退出 Navi」后，壳进程退出，测试服务继续用原 PID 提供服务。 | [通知区图标](windows-desktop-verification/tray-icon.jpg) · [托盘菜单](windows-desktop-verification/tray-autostart-on.jpg) |
| 浏览器链接 | 在独立 Edge 配置中点击 `navi://open?project=…&instance=…`，在浏览器确认「打开」。壳已退出时重新打开窗口并选中目标项目，壳已打开时在原窗口切到另一个目标项目。冷启动复用了正在运行的测试服务。 | [测试页](windows-desktop-verification/browser-links.jpg) · [浏览器确认](windows-desktop-verification/browser-confirm.jpg) · [冷启动目标](windows-desktop-verification/browser-cold-route.jpg) · [原窗口跳转](windows-desktop-verification/browser-warm-route.jpg) |
| 允许其他设备访问 | 从托盘打开并确认重启。主端口从 `127.0.0.1` 切到通配监听，窗口端口仍只听回环。Mac 上的健康检查返回 200，未带凭证访问项目接口返回 401。取消勾选后，两端口恢复只听回环，Mac 无法再连接。这台机器没有弹出防火墙提示，测试前后均未发现匹配测试运行时的防火墙规则。 | [打开确认](windows-desktop-verification/remote-confirm.jpg) · [重启中](windows-desktop-verification/remote-restart.jpg) · [开启](windows-desktop-verification/remote-public.jpg) · [关闭](windows-desktop-verification/remote-private-again.jpg) |
| 登录时启动 | 在托盘取消再勾选，核对 `HKCU\…\Run\Navi` 删除后恢复。退出壳、停止已识别的测试服务，再由 Explorer 执行登记的 `Navi.exe --start-server`。新服务同时响应两个端口，未出现 Navi 窗口。为维持旧 Navi 和远程通道，未注销 Windows 会话。 | [关闭登录启动](windows-desktop-verification/tray-autostart-off.jpg) · [开启登录启动](windows-desktop-verification/tray-autostart-on.jpg) |
| 卸载 | 保持「同时删除」未勾选并执行卸载。应用文件、协议和启动项被移除，测试数据库与后台服务在卸载后仍在，随后由测试清理步骤移除。 | [卸载确认](windows-desktop-verification/uninstall-confirm.jpg) · [卸载完成](windows-desktop-verification/uninstall-complete.jpg) |

## 卸载选项的括号换行

**已修复。** 在这台高缩放的 Windows 机器打开卸载确认页，删除数据选项的最后一个右括号独占一行。缩短文案并保留删除范围与位置。重新打包、安装和打开卸载页后，选项显示在一行，仍默认不勾选。[修复前](windows-desktop-verification/uninstall-wrap.jpg) · [修复后](windows-desktop-verification/uninstall-confirm.jpg)

## 新项目在旧窗口里打不开

**待处理的跨客户端 Bug。** 保持工作区窗口打开并让它先读完空项目列表。用另一个客户端调用 `POST /api/projects` 建项目，再在 Edge 点击指向它的 `navi://` 链接。桌面日志记录了收到链接、发送路由和 WebView2 回报目标 URL，工作区仍显示「还没有可用项目」。退出壳再从浏览器打开，初次读取项目列表后能显示目标项目，随后原窗口也能在已知项目之间切换。[旧窗口](windows-desktop-verification/stale-project-list.jpg) · [重新打开后的目标项目](windows-desktop-verification/browser-cold-route.jpg)

项目 API 在创建后没有发布 `project.updated`。工作区依靠该事件和重连来刷新既有项目列表。修复涉及共享的项目创建和同步链路，需要一起确认创建入口和权限过滤。[项目 API](../server/src/project-routes.ts#L106) · [Web 项目列表](../web/src/workspace/useProjects.ts#L48)

此次从点击「全新开始」到 WebView2 加载 Web 应用约 8 分钟。首启期间能操作托盘。发布过程需要复制并校验约一万项运行时文件，耗时记录仅代表这台测试机。[首启进度](windows-desktop-verification/runtime-publishing.jpg)

## 清理结果

测试安装、数据根、运行时、WebView2 和 Edge 测试配置已删除。测试进程和终端会话已关闭，测试端口已释放。核对开始菜单、卸载登记、协议和登录项均已移除。旧 Navi 的 `4317/api/health` 返回正常，PID `10808`、实例标识 `8D25-98C1` 和原数据根均与开工时一致。
