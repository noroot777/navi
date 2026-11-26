import headless from "@xterm/headless";
import { terminalThemes, type TerminalTheme } from "@navi/shared/terminal-themes";
import type { TerminalProcess } from "./terminal-pty.js";

type RGB = [number, number, number];
type ColorRequest = { type: 0; index: number } | { type: 1; index: number; color: RGB } | { type: 2; index?: number };
type ProtocolEvents = {
  onColor(listener: (requests: ColorRequest[]) => void): unknown;
  onRequestSendFocus(listener: () => void): unknown;
};

const ansiNames = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const specialNames = ["foreground", "background", "cursor"] as const;
const colorSteps = [0, 95, 135, 175, 215, 255];

function defaultColor(index: number, theme: TerminalTheme): RGB {
  if (index < 16 || index >= 256) {
    const colors = terminalThemes[theme].colors;
    const hex = colors[index < 16 ? ansiNames[index] : specialNames[index - 256]];
    return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)) as RGB;
  }
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return [gray, gray, gray];
  }
  const cube = index - 16;
  return [colorSteps[Math.floor(cube / 36)], colorSteps[Math.floor(cube / 6) % 6], colorSteps[cube % 6]];
}

export function withTerminalProtocol(
  process: TerminalProcess,
  cols: number,
  rows: number,
  theme: TerminalTheme = "graphite",
): TerminalProcess {
  const terminal = new headless.Terminal({ cols, rows, scrollback: 0, cursorBlink: true, allowProposedApi: true });
  let exited = false;
  let focused = false;
  let palette = theme;
  const overrides = new Map<number, RGB>();
  const reply = (data: string) => {
    if (!exited) {
      try { process.write(data); } catch { /* PTY closed */ }
    }
  };
  const reportFocus = () => reply(focused ? "\x1b[I" : "\x1b[O");
  const events = (terminal as unknown as { _core: { _inputHandler: ProtocolEvents } })._core._inputHandler;
  events.onRequestSendFocus(reportFocus);
  events.onColor((requests) => {
    for (const request of requests) {
      const index = request.index;
      if (request.type === 0) {
        const color = overrides.get(request.index) ?? defaultColor(request.index, palette);
        const parts = color.map((channel) => channel.toString(16).padStart(2, "0").repeat(2));
        const selector = request.index < 256 ? `4;${request.index}` : String(request.index - 246);
        reply(`\x1b]${selector};rgb:${parts.join("/")}\x1b\\`);
      } else if (request.type === 1) {
        overrides.set(request.index, request.color);
      } else if (index === undefined) {
        for (const key of overrides.keys()) if (key < 256) overrides.delete(key);
      } else {
        overrides.delete(index);
      }
    }
  });
  terminal.onData(reply);
  process.onData((data) => { if (!exited) terminal.write(data); });
  process.onExit(() => {
    exited = true;
    terminal.dispose();
  });

  return {
    pid: process.pid,
    ptsName: process.ptsName,
    onData: (listener) => process.onData(listener),
    onExit: (listener) => process.onExit(listener),
    kill: (signal) => process.kill(signal),
    write(data, nextFocus) {
      if (nextFocus !== undefined) terminal.write("", () => {
        if (exited || focused === nextFocus) return;
        focused = nextFocus;
        if (terminal.modes.sendFocusMode) reportFocus();
      });
      if (data) process.write(data);
    },
    resize(nextCols, nextRows, nextTheme) {
      terminal.write("", () => {
        if (exited) return;
        if (palette !== nextTheme && nextTheme !== undefined) {
          palette = nextTheme;
          overrides.clear();
        }
        terminal.resize(nextCols, nextRows);
      });
      process.resize(nextCols, nextRows);
    },
  };
}
