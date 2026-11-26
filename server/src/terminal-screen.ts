import type { Terminal } from "@xterm/headless";
import type { ScreenLine, ScreenPresentation, TerminalScreenFrame, XtermScreenBuffer, XtermScreenLine } from "@navi/shared/terminal-screen";
import type { TerminalTheme } from "@navi/shared/terminal-themes";

const SYNCHRONIZED_OUTPUT_MODE = 2026;
const SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1000;

type ScreenCore = {
  _bufferService: { buffer: XtermScreenBuffer; buffers: {
    alt: XtermScreenBuffer;
    normal: XtermScreenBuffer;
    onBufferActivate(listener: () => void): { dispose(): void };
  } };
  coreService: { isCursorHidden: boolean; decPrivateModes: Record<string, boolean> };
  coreMouseService: { activeProtocol: string; activeEncoding: string };
  _oscLinkService: { getLinkData(linkId: number): { uri: string } | undefined };
};

function encode(line: XtermScreenLine): ScreenLine {
  let end = line._data.length;
  while (end > 0 && line._data[end - 3] === 1 << 22 && !line._data[end - 2] && !line._data[end - 1]) end -= 3;
  const bytes = Buffer.from(line._data.buffer, line._data.byteOffset, end * 4);
  const result: ScreenLine = { cells: bytes.toString("base64") };
  if (line.isWrapped) result.wrapped = true;
  for (let index = 0; index < end / 3; index++) {
    const content = line._data[index * 3];
    const flags = line._data[index * 3 + 2];
    if (content & (1 << 21)) (result.combined ??= {})[index] = line._combined[index];
    if (flags & (1 << 28)) {
      const attr = line._extendedAttrs[index];
      if (attr) (result.attributes ??= []).push([index, attr.ext, attr.urlId]);
    }
  }
  return result;
}

type Listener = (frame: TerminalScreenFrame) => void;

export function createTerminalScreen(
  terminal: Terminal,
  palette: () => TerminalTheme,
  colors: () => [index: number, rgb: number][],
) {
  const core = (terminal as unknown as { _core: ScreenCore })._core;
  const listeners = new Set<Listener>();
  let previous: TerminalScreenFrame | undefined;
  let previousBuffer: XtermScreenBuffer | undefined;
  let previousList: XtermScreenBuffer["lines"] | undefined;
  let cachedLines: ScreenLine[] = [];
  const cachedLinks = new Map<number, string>();
  let normalList: XtermScreenBuffer["lines"] | undefined;
  let trim: { dispose(): void } | undefined;
  let discarded = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let syncTimeout: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number | undefined;
  let failed = false;
  let finished = false;
  let geometryChanged = false;

  const watchNormal = () => {
    const lines = core._bufferService.buffers.normal.lines;
    if (lines === normalList) return;
    trim?.dispose();
    normalList = lines;
    trim = lines.onTrim((count) => { discarded += count; });
  };
  watchNormal();
  const activation = core._bufferService.buffers.onBufferActivate(watchNormal);

  const linksFor = (lines: TerminalScreenFrame["lines"]): TerminalScreenFrame["links"] => {
    const urls = new Map<number, string>();
    for (const [, line] of lines) {
      for (const [, , id] of line.attributes ?? []) {
        if (!id || urls.has(id)) continue;
        const uri = core._oscLinkService.getLinkData(id)?.uri;
        if (uri) urls.set(id, uri);
      }
    }
    return [...urls];
  };

  const isSynchronized = () => core.coreService.decPrivateModes.synchronizedOutput;

  function commit(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (isSynchronized()) return;
    clearTimeout(syncTimeout);
    syncTimeout = undefined;
    const buffer = core._bufferService.buffer;
    const alternate = buffer === core._bufferService.buffers.alt;
    const presentation: ScreenPresentation = {
      theme: palette(), colors: colors(), alternate,
      cursorX: buffer.x, cursorY: buffer.y, cursorHidden: core.coreService.isCursorHidden,
      cursorBlink: terminal.options.cursorBlink ?? false, cursorStyle: terminal.options.cursorStyle ?? "block",
      modes: { ...core.coreService.decPrivateModes },
      mouseProtocol: core.coreMouseService.activeProtocol, mouseEncoding: core.coreMouseService.activeEncoding,
    };
    const full = !previous || previousBuffer !== buffer || previousList !== buffer.lines || geometryChanged;
    const drop = full || alternate ? 0 : discarded - previous!.discarded;
    const first = full ? 0 : Math.max(0, Math.min(previous!.base - drop, buffer.ybase));
    const nextLines = cachedLines.slice(drop, drop + first);
    const lines: TerminalScreenFrame["lines"] = [];
    for (let row = first; row < buffer.lines.length; row++) {
      const line = encode(buffer.lines.get(row));
      nextLines.push(line);
      if (full || JSON.stringify(line) !== JSON.stringify(cachedLines[row + drop])) lines.push([row, line]);
    }
    const links = linksFor(lines);
    if (full) cachedLinks.clear();
    for (const id of cachedLinks.keys()) {
      if (!core._oscLinkService.getLinkData(id)) cachedLinks.delete(id);
    }
    for (const [id, uri] of links) cachedLinks.set(id, uri);
    const frame: TerminalScreenFrame = {
      ...presentation, seq: (previous?.seq ?? 0) + 1, cols: terminal.cols, rows: terminal.rows,
      base: buffer.ybase, length: nextLines.length, discarded, drop, full, lines, links,
      exitCode, error: failed || undefined,
    };
    previous = frame;
    cachedLines = nextLines;
    previousBuffer = buffer;
    previousList = buffer.lines;
    geometryChanged = false;
    for (const listener of listeners) listener(frame);
  }

  const syncStart = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (params.includes(SYNCHRONIZED_OUTPUT_MODE) && !isSynchronized()) {
      commit();
      syncTimeout = setTimeout(forceCommit, SYNCHRONIZED_OUTPUT_TIMEOUT_MS);
    }
    return false;
  });

  function forceCommit(): void {
    core.coreService.decPrivateModes.synchronizedOutput = false;
    commit();
  }

  let finalFrame: TerminalScreenFrame | undefined;
  const snapshot = () => {
    if (finalFrame) return finalFrame;
    if (!previous || timer) commit();
    const lines = cachedLines.map((line, row): [number, ScreenLine] => [row, line]);
    return { ...previous!, full: true, drop: 0, lines, links: [...cachedLinks] };
  };

  const schedule = (resized = false) => {
    if (finished) return;
    geometryChanged ||= resized;
    if (isSynchronized()) return;
    clearTimeout(syncTimeout);
    syncTimeout = undefined;
    if (timer === undefined) timer = setTimeout(commit, 16);
  };

  return {
    snapshot,
    get observed() { return listeners.size !== 0; },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    schedule,
    finish(code: number) {
      if (finished) return;
      exitCode = code;
      forceCommit();
      finalFrame = snapshot();
      finished = true;
      trim?.dispose();
      activation.dispose();
      syncStart.dispose();
      previousBuffer = previousList = normalList = undefined;
    },
    fail() {
      failed = true;
      schedule();
    },
  };
}

export type TerminalScreen = ReturnType<typeof createTerminalScreen>;
