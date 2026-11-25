; Navi 安装包的几处定制。Tauri 的 NSIS 模板（tauri-bundler 的 installer.nsi）在固定的几个点插进来；模板自己已经
; 做了的不重复：按 per-user 写卸载项、开始菜单、navi:// 协议（tauri.conf.json 的 plugins.deep-link，装时按实际安装
; 位置写 HKCU\Software\Classes\navi、卸载时只删指着本安装目录的那一份）、更新模式（/UPDATE）下保留登录项和快捷方式。
;
; 这里补的：
;   · 默认装到 %LOCALAPPDATA%\Programs\Navi。模板给 per-user 的默认是 %LOCALAPPDATA%\Navi —— 那是 Navi 自己的那块地
;     （数据根、运行时仓库、设置都在里面），装进去卸载时就和数据搅在一起；登录项也只认 Programs 下的安装位置。
;   · 动安装目录之前，先等壳拉起的控制器（安装目录里那份 node 跑的 controller-main.mjs）退干净。壳一被关掉它就自己
;     退，但比安装包开始拷文件慢一拍，那一下 node.exe 还占着，覆盖会失败。别的程序还用着安装目录里的文件就不动手，
;     说清是谁；绝不碰外置服务和 agent —— 它们跑在 %LOCALAPPDATA%\Navi\runtimes 下发布出来的那份里，不在这里。
;   · 覆盖安装前先删掉旧的 runtime\：运行时内容清单要和目录一字不差，旧版多出来的文件留着，新版第一次发布就校验不过。
;   · 卸载时勾了「同时删除 Navi 的数据」才删，而且只在没有任何进程还在用那块地时删：先整块改名（有文件被打开就改不了），
;     改成了再删。服务还在跑就不删、说清楚，卸载不停服务。
!define NAVI_INSTALLER_DIR "${__FILEDIR__}"

!define MUI_CUSTOMFUNCTION_GUIINIT NaviGuiInit

; 目录页之前把默认位置换掉（模板此时已经按上一次的安装位置、/D= 定好了 $INSTDIR，那些不动）。
; 这里还没有 PRODUCTNAME（模板在本文件之后才定义），名字只能写死。
Function NaviGuiInit
  ${If} $INSTDIR == "$LOCALAPPDATA\Navi"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Navi"
  ${EndIf}
FunctionEnd

; $0 = 退出码，$R9 = 输出（只有进程号和映像名，ASCII）。
!macro NaviScript mode argument value
  InitPluginsDir
  File "/oname=$PLUGINSDIR\navi-installdir.ps1" "${NAVI_INSTALLER_DIR}\installdir.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\navi-installdir.ps1" -Mode ${mode} ${argument} "${value}"'
  Pop $0
  Pop $R9
!macroend

!macro NaviReleaseInstallDir
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${If} ${FileExists} "$INSTDIR\runtime\node\node.exe"
    !insertmacro NaviScript Release -InstallDir "$INSTDIR"
    ${If} $0 != 0
      IfSilent +2
      MessageBox MB_ICONSTOP "$(naviInstallDirBusy)"
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 静默安装不走 GUI 初始化，在这里补一次。
  ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
  ${EndIf}
  SetOutPath $INSTDIR
  !insertmacro NaviReleaseInstallDir
  RMDir /r "$INSTDIR\runtime"
  ${If} ${FileExists} "$INSTDIR\runtime\*.*"
    IfSilent +2
    MessageBox MB_ICONSTOP "$(naviRuntimeLeftover)"
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NaviReleaseInstallDir
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    !insertmacro NaviScript RemoveData -NaviHome "$LOCALAPPDATA\Navi"
    ${If} $0 == 3
      MessageBox MB_ICONEXCLAMATION "$(naviDataBusy)"
    ${ElseIf} $0 == 4
      MessageBox MB_ICONEXCLAMATION "$(naviDataLeftover)"
    ${EndIf}
  ${EndIf}
!macroend
