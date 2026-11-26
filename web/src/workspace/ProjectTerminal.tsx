import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "@navi/shared";
import { TERMINAL_SCROLLBACK, type TerminalScreenFrame } from "@navi/shared/terminal-screen";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api.ts";
import { TerminalTabStrip } from "./TerminalTabStrip.tsx";
import type { ProjectTerminalTab } from "./terminalTabs.ts";
import type { TerminalDock } from "./useTerminalDock.ts";
import { TerminalAppearanceMenu } from "./TerminalAppearanceMenu.tsx";
import { readTerminalAppearance, terminalThemes, TERMINAL_APPEARANCE_KEY, type TerminalAppearance } from "./terminalAppearance.ts";
import { terminalInputChunks } from "./terminalInput.ts";
import { onTerminalUserInput } from "./terminalUserInput.ts";
import { terminalScreenView } from "./terminalScreenView.ts";

const TERMINAL_HEIGHT_KEY = "navi:terminal-height";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 170;
const MAX_HEIGHT = 560;

function maximumHeight(viewportHeight: number = window.innerHeight): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, viewportHeight - 210));
}

/** 拖拽用:按**当前窗口**能给的高度夹。 */
function clampHeight(value: number, viewportHeight?: number): number {
  return Math.max(MIN_HEIGHT, Math.min(maximumHeight(viewportHeight), Math.round(value)));
}

/** 偏好用:只按绝对上下限夹,**不看窗口** —— 看了就等于「窗口临时矮」把偏好永久改小。 */
function preferredHeight(value: number): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function initialHeight(): number {
  // 没存过时 getItem 给的是 null,Number(null) = 0 —— 0 也是有限数,照单全收
  // 就等于每个新用户第一次开终端都只得到 MIN_HEIGHT 那一条缝,而不是 DEFAULT_HEIGHT。
  const stored = Number(window.localStorage.getItem(TERMINAL_HEIGHT_KEY));
  return Number.isFinite(stored) && stored > 0 ? preferredHeight(stored) : DEFAULT_HEIGHT;
}

function sessionStatus(tab: ProjectTerminalTab, exitCode: number | undefined, wasDetached: boolean) {
  const code = tab.exitCode ?? exitCode ?? 0;
  if (tab.status === "detached") return tab.kind === "command"
    ? `启动脚本已退出（${code}），服务仍在运行 —— 停止/重启在状态栏`
    : `shell 已退出（${code}），它启动的后台进程仍在运行`;
  if (tab.status !== "ended") return null;
  if (tab.kind === "command") {
    if (tab.stop?.kind === "unresolved") return "已停止，但没能确认停净 —— 详情看状态栏的常用命令";
    if (tab.stoppedByUser) return "服务已停止";
    if (wasDetached) return "服务已退出";
  }
  return `进程已退出（${code}）`;
}

function TerminalPane({
  active,
  project,
  tab,
  notify,
  onMeta,
  appearance,
}: {
  active: boolean;
  project: ProjectView;
  tab: ProjectTerminalTab;
  notify: (message: string) => void;
  onMeta: (id: string, patch: Partial<Pick<ProjectTerminalTab, "cwd" | "status" | "sessionId">>) => void;
  appearance: TerminalAppearance;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const measureRef = useRef<(() => void) | null>(null);
  const renderRef = useRef<ReturnType<typeof terminalScreenView> | null>(null);
  const frameReady = useRef(false);
  const lastSeqRef = useRef(0);
  const discardedRef = useRef(0);
  const [exitCode, setExitCode] = useState<number>();
  const [screenError, setScreenError] = useState(false);
  const themeRef = useRef(appearance.theme);
  themeRef.current = appearance.theme;
  // 已经有会话的 tab(attach 来的,或自己建完回填了 sessionId)一挂上就能收发;只有全新的
  // shell tab 要等 create 完才有 id。流 effect 等这个。
  const sessionIdRef = useRef<string | null>(tab.attachSessionId ?? tab.sessionId ?? null);
  const [establishedId, setEstablishedId] = useState<string | null>(tab.attachSessionId ?? tab.sessionId ?? null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const wasDetached = useRef(false);
  useEffect(() => {
    if (tab.status === "detached") wasDetached.current = true;
  }, [tab.status]);

  // 基座:xterm 实例、输入/резize 通道、shell 会话的创建与关闭。日志流不在这里 ——
  // 它跟随 active(见下一个 effect),隐藏 tab 不占长连接。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let inputBuffer = "";
    let inputTimer: number | null = null;
    let inputChain = Promise.resolve();
    let resizeTimer: number | null = null;
    let pendingSize: { cols: number; rows: number; theme: TerminalAppearance["theme"] } | null = null;
    let lastRequested = "";
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: appearance.fontSize,
      lineHeight: 1.25,
      scrollback: TERMINAL_SCROLLBACK,
      theme: terminalThemes[appearance.theme].colors,
    });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    terminal.loadAddon(fit);
    terminal.open(host);
    lastSeqRef.current = 0;
    discardedRef.current = 0;
    frameReady.current = false;
    renderRef.current = terminalScreenView(terminal);

    const showConnectionError = (reason: unknown) => {
      if (!alive) return;
      onMeta(tab.id, { status: "error" });
      const message = reason instanceof Error ? reason.message : String(reason);
      notify(`CLI 连接失败：${message}`);
    };
    const flushInput = () => {
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      inputTimer = null;
      const sessionId = sessionIdRef.current;
      if (!sessionId || !inputBuffer) return;
      const data = inputBuffer;
      inputBuffer = "";
      inputChain = inputChain
        .then(async () => {
          for (const chunk of terminalInputChunks(data)) await api.writeTerminalSession(project.id, sessionId, chunk);
        })
        .catch(showConnectionError);
    };
    const queueInput = (data: string) => {
      if (!frameReady.current) return;
      if (resizeTimer !== null) flushResize();
      inputBuffer += data;
      if (inputTimer === null) inputTimer = window.setTimeout(flushInput, 12);
    };
    const reportFocus = (focused: boolean) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      flushInput();
      inputChain = inputChain.then(() => api.writeTerminalSession(project.id, sessionId, "", focused)).catch(showConnectionError);
    };
    const focus = () => { measure(); reportFocus(true); };
    const blur = () => reportFocus(false);
    const flushResize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = null;
      const sessionId = sessionIdRef.current;
      if (!sessionId || !pendingSize) return;
      const size = pendingSize;
      pendingSize = null;
      const key = JSON.stringify(size);
      if (key === lastRequested) return;
      lastRequested = key;
      flushInput();
      inputChain = inputChain.then(() => api.resizeTerminalSession(project.id, sessionId, size)).catch((error) => {
        if (lastRequested === key) lastRequested = "";
        showConnectionError(error);
      });
    };
    const measure = () => {
      if (!alive || host.offsetParent === null) return;
      const size = fit.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      pendingSize = { ...size, theme: themeRef.current };
      if (resizeTimer === null) resizeTimer = window.setTimeout(flushResize, 80);
    };
    measureRef.current = measure;

    const input = onTerminalUserInput(terminal, queueInput);
    const textarea = terminal.textarea!;
    textarea.addEventListener("focus", focus);
    textarea.addEventListener("blur", blur);
    const observer = new ResizeObserver(measure);
    observer.observe(host);

    // 只有「还没有任何会话」的 tab 才新建。光看 attachSessionId 不够 —— 前端自己建的 shell
    // 把会话 id 回填在 sessionId 上,这种 tab 要是又走一遍创建(挂到别的项目、或基座 effect
    // 因依赖变化重跑),就会平白多起一个 shell(第 1 轮逻辑审查:切项目时 create 了两次)。
    if (!tab.attachSessionId && !tab.sessionId) {
      const initialSize = host.offsetParent === null ? undefined : fit.proposeDimensions();
      void api.createTerminalSession(project.id, { ...(initialSize ?? { cols: terminal.cols, rows: terminal.rows }), theme: themeRef.current })
        .then((session) => {
          if (!alive) {
            // 会话建成前 tab 就没了(关抽屉/StrictMode 重挂):还没人看过一眼,直接收掉,
            // 不留一个空 shell 等下次恢复。
            void api.closeTerminalSession(project.id, session.id).catch(() => undefined);
            return;
          }
          sessionIdRef.current = session.id;
          // sessionId 回填到 tab 上:交互 shell 的 ✕(closeTab)靠它结束会话。
          onMeta(tab.id, { cwd: session.cwd, sessionId: session.id });
          setEstablishedId(session.id);
          flushInput();
          if (document.activeElement === textarea) focus();
          measure();
        })
        .catch(showConnectionError);
    }

    return () => {
      alive = false;
      observer.disconnect();
      if (document.activeElement === textarea) blur();
      textarea.removeEventListener("focus", focus);
      textarea.removeEventListener("blur", blur);
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      renderRef.current = null;
      measureRef.current = null;
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      // 会话是持久的(VSCode 语义):unmount 发生在收起 tab/切项目,这些都不杀
      // shell —— 重开抽屉从会话列表原样恢复。结束会话统一走 closeTab 的 DELETE。
    };
  }, [notify, onMeta, project.id, tab.id, tab.attachSessionId]);

  useEffect(() => {
    if (!active) return;
    const request = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(request);
  }, [active]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = appearance.fontSize;
    if (active) measureRef.current?.();
  }, [appearance, active]);

  useEffect(() => {
    if (!active || !establishedId) return;
    const render = renderRef.current;
    if (!render) return;
    let alive = true;
    let ended = tabRef.current.status === "ended";
    let source: EventSource;
    const connect = () => {
      let initial = true;
      source = new EventSource(api.terminalScreenUrl(project.id, establishedId));
      source.onopen = () => { initial = true; };
      source.onmessage = (message) => {
        if (!alive) return;
        const frame = JSON.parse(message.data) as TerminalScreenFrame;
        if (!frame.full && (initial || frame.seq !== lastSeqRef.current + 1)) {
          source.close();
          connect();
          return;
        }
        render(frame);
        if (initial && lastSeqRef.current && frame.discarded > discardedRef.current) {
          notify("部分终端输出已超出保留范围");
        }
        if (initial && !ended && !tab.attachSessionId && frame.exitCode === undefined) onMeta(tab.id, { status: "ready" });
        initial = false;
        frameReady.current = true;
        lastSeqRef.current = frame.seq;
        discardedRef.current = frame.discarded;
        setScreenError(frame.error === true);
        if (frame.exitCode !== undefined && !ended) {
          ended = true;
          setExitCode(frame.exitCode);
          if (!tab.attachSessionId) onMeta(tab.id, { status: "ended" });
        }
      };
      source.onerror = () => {
        if (!alive || ended || tab.attachSessionId) return;
        onMeta(tab.id, { status: "reconnecting" });
      };
    };
    connect();
    return () => {
      alive = false;
      source.close();
    };
  }, [active, establishedId, project.id, tab.id, tab.attachSessionId, onMeta, notify]);

  const status = screenError ? "终端画面可能不完整" : sessionStatus(tab, exitCode, wasDetached.current);
  return (
    <>
      <div
        ref={hostRef}
        id={`terminal-panel-${tab.id}`}
        className="project-terminal__viewport"
        role="group"
        aria-label={`${tab.label} 终端内容`}
        hidden={!active}
      />
      {active && status && <div className="project-terminal__status">{status}</div>}
    </>
  );
}

export function ProjectTerminal({
  project,
  dock,
  notify,
}: {
  project: ProjectView;
  /** 开着哪几个终端、哪个在前台,统一由 WorkspaceShell 那份账本(useTerminalDock)说了算。 */
  dock: TerminalDock;
  notify: (message: string) => void;
}) {
  const { tabs, activeId, activeTab } = dock;
  const [appearance, setAppearance] = useState(readTerminalAppearance);
  const changeAppearance = (next: TerminalAppearance) => {
    setAppearance(next);
    window.localStorage.setItem(TERMINAL_APPEARANCE_KEY, JSON.stringify(next));
  };
  // height = 用户挑的那个高度(偏好),appliedHeight = 按当前窗口夹过的实际高度。
  // 底部坞横着占一整行,高度不跟着窗口收就会把上面的工作区整个挤没(实测:560 的终端
  // + 620 高的窗口 = 侧栏和主区只剩 34px);但**夹只发生在渲染这一侧** —— 偏好既不在
  // 读取时按窗口夹、也不在挂载/窗口变化时回写,否则「在矮窗口里开一次终端」就等于
  // 把他存的 560 永久改成 410,窗口拉回来也回不去了(第 1 轮审查实锤)。
  const [height, setHeight] = useState(initialHeight);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const appliedHeight = clampHeight(height, viewportHeight);
  // 落盘只由**用户亲手调**触发(拖拽收手、双击复位),不挂 effect 跟着 state 走。
  const rememberHeight = useCallback((value: number) => {
    const next = preferredHeight(value);
    setHeight(next);
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(next));
  }, []);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = appliedHeight;
    document.body.classList.add("terminal-drawer-resizing");
    // 拖的过程中只动 state(跟手),收手时才落盘 —— 每个 pointermove 都写一次
    // localStorage 是同步 IO,没必要。
    let latest = startHeight;
    const move = (next: PointerEvent) => {
      latest = clampHeight(startHeight + startY - next.clientY, viewportHeight);
      setHeight(latest);
    };
    const finish = () => {
      document.body.classList.remove("terminal-drawer-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      rememberHeight(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  return (
    <section className="project-terminal" hidden={!dock.open} style={{ height: appliedHeight, background: terminalThemes[appearance.theme].colors.background }} aria-label={`${project.name} CLI`}>
      <div
        className="project-terminal__resize"
        role="separator"
        aria-label="调整 CLI 高度，双击恢复默认高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maximumHeight(viewportHeight)}
        aria-valuenow={appliedHeight}
        onPointerDown={beginResize}
        onDoubleClick={() => rememberHeight(DEFAULT_HEIGHT)}
      />
      <header className="project-terminal__bar">
        <TerminalTabStrip
          ariaLabel="终端面板中的终端"
          className="project-terminal__tabs"
          dock={dock}
          idPrefix="panel-terminal-tab"
        />
        <code>{activeTab?.cwd ?? project.repoPath}</code>
        <TerminalAppearanceMenu appearance={appearance} onChange={changeAppearance} />
        <button type="button" className="project-terminal__drawer-hide" aria-label="收起终端（shell 与服务继续跑）" onClick={dock.hide} />
      </header>
      {tabs.map((tab) => (
        <TerminalPane
          key={tab.id}
          tab={tab}
          project={project}
          active={dock.open && tab.id === activeId}
          notify={notify}
          onMeta={dock.setMeta}
          appearance={appearance}
        />
      ))}
    </section>
  );
}
