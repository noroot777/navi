import type { ITheme, Terminal } from "@xterm/xterm";
import type { TerminalScreenFrame, XtermScreenBuffer } from "@navi/shared/terminal-screen";
import { terminalThemes } from "@navi/shared/terminal-themes";

type ScreenCore = {
  _bufferService: { buffers: {
    active: XtermScreenBuffer;
    activateAltBuffer(): void;
    activateNormalBuffer(): void;
  }; isUserScrolling: boolean };
  coreService: { decPrivateModes: Record<string, boolean>; isCursorHidden: boolean; isCursorInitialized: boolean };
  coreMouseService: { activeProtocol: string; activeEncoding: string };
  _oscLinkService: { getLinkData(id: number): { uri: string } | undefined };
  _viewport: { queueSync(): void };
  _selectionService: { refresh(): void };
  _onCursorMove: { fire(): void };
};

const colorNames = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const specialNames = ["foreground", "background", "cursor"] as const;

function screenTheme(frame: TerminalScreenFrame): ITheme {
  const theme: ITheme = { ...terminalThemes[frame.theme].colors };
  for (const [index, rgb] of frame.colors) {
    const color = `#${rgb.toString(16).padStart(6, "0")}`;
    if (index < 16) theme[colorNames[index]] = color;
    else if (index >= 256) theme[specialNames[index - 256]] = color;
    else (theme.extendedAnsi ??= [])[index - 16] = color;
  }
  return theme;
}

export function terminalScreenView(terminal: Terminal) {
  const core = (terminal as unknown as { _core: ScreenCore })._core;
  const links = new Map<number, { uri: string }>();
  core._oscLinkService.getLinkData = (id) => links.get(id);
  let palette: string | undefined;
  let discarded = 0;

  return (frame: TerminalScreenFrame) => {
    const old = core._bufferService.buffers.active;
    const previousTop = old.ydisp;
    const wasAtBottom = previousTop === old.ybase;
    const resized = terminal.cols !== frame.cols || terminal.rows !== frame.rows;
    const switched = (terminal.buffer.active.type === "alternate") !== frame.alternate;
    if (resized) terminal.resize(frame.cols, frame.rows);
    const buffers = core._bufferService.buffers;
    if (frame.alternate) buffers.activateAltBuffer();
    else buffers.activateNormalBuffer();
    const buffer = buffers.active;
    if (frame.full) {
      links.clear();
      buffer.lines.length = 0;
    } else {
      if (frame.drop) buffer.lines.trimStart(Math.min(frame.drop, buffer.lines.length));
      if (buffer.lines.length > frame.length) buffer.lines.length = frame.length;
    }
    for (const [id, uri] of frame.links) links.set(id, { uri });
    const blank = buffer.getNullCell();
    const visibleIds = new Set<number>();
    for (const [row, encoded] of frame.lines) {
      const line = buffer.getBlankLine(blank, encoded.wrapped);
      const bytes = Uint8Array.from(atob(encoded.cells), (value) => value.charCodeAt(0));
      line._data.set(new Uint32Array(bytes.buffer));
      if (encoded.combined) line._combined = encoded.combined;
      for (const [column, flags, id] of encoded.attributes ?? []) {
        const attr = blank.extended.clone();
        attr.ext = flags;
        attr.urlId = id;
        line._extendedAttrs[column] = attr;
      }
      if (row === buffer.lines.length) buffer.lines.push(line);
      else buffer.lines.set(row, line);
    }
    if (links.size && (frame.full || frame.drop)) {
      for (let row = 0; row < frame.length; row++) {
        for (const attr of Object.values(buffer.lines.get(row)._extendedAttrs)) if (attr?.urlId) visibleIds.add(attr.urlId);
      }
      for (const id of links.keys()) if (!visibleIds.has(id)) links.delete(id);
    }
    buffer.x = frame.cursorX;
    buffer.y = frame.cursorY;
    buffer.ybase = frame.base;
    buffer.ydisp = switched || wasAtBottom ? frame.base
      : Math.max(0, Math.min(frame.base, previousTop - (frame.discarded - discarded)));
    core._bufferService.isUserScrolling = buffer.ydisp < frame.base;
    core.coreService.isCursorHidden = frame.cursorHidden;
    core.coreService.isCursorInitialized = true;
    Object.assign(core.coreService.decPrivateModes, frame.modes, { synchronizedOutput: false });
    if (core.coreMouseService.activeProtocol !== frame.mouseProtocol) core.coreMouseService.activeProtocol = frame.mouseProtocol;
    if (core.coreMouseService.activeEncoding !== frame.mouseEncoding) core.coreMouseService.activeEncoding = frame.mouseEncoding;
    terminal.options.cursorStyle = frame.cursorStyle;
    terminal.options.cursorBlink = frame.cursorBlink;
    const nextPalette = JSON.stringify([frame.theme, frame.colors]);
    if (palette !== nextPalette) {
      palette = nextPalette;
      terminal.options.theme = screenTheme(frame);
      const host = terminal.element?.parentElement;
      if (host) host.style.backgroundColor = terminal.options.theme.background ?? "";
    }
    discarded = frame.discarded;
    if (switched || resized) terminal.clearSelection();
    core._onCursorMove.fire();
    core._selectionService.refresh();
    core._viewport.queueSync();
    terminal.refresh(0, terminal.rows - 1);
  };
}
