import type { TerminalTheme } from "./terminal-themes.ts";

export const TERMINAL_SCROLLBACK = 5000;

export type ScreenLine = {
  cells: string;
  wrapped?: true;
  combined?: Record<number, string>;
  attributes?: [column: number, flags: number, linkId: number][];
};

export type ScreenPresentation = {
  theme: TerminalTheme;
  colors: [index: number, rgb: number][];
  alternate: boolean;
  cursorX: number;
  cursorY: number;
  cursorHidden: boolean;
  cursorBlink: boolean;
  cursorStyle: "block" | "bar" | "underline";
  modes: Record<string, boolean>;
  mouseProtocol: string;
  mouseEncoding: string;
};

export type TerminalScreenFrame = ScreenPresentation & {
  seq: number;
  cols: number;
  rows: number;
  base: number;
  length: number;
  discarded: number;
  drop: number;
  full: boolean;
  lines: [row: number, line: ScreenLine][];
  links: [id: number, uri: string][];
  exitCode?: number;
  error?: true;
};

export type ScreenCellAttributes = { ext: number; urlId: number };
export type XtermScreenLine = {
  _data: Uint32Array;
  _combined: Record<number, string>;
  _extendedAttrs: Record<number, ScreenCellAttributes | undefined>;
  isWrapped: boolean;
};

export type XtermScreenBuffer = {
  x: number;
  y: number;
  ybase: number;
  ydisp: number;
  lines: {
    length: number;
    get(index: number): XtermScreenLine;
    set(index: number, line: XtermScreenLine): void;
    push(line: XtermScreenLine): void;
    trimStart(count: number): void;
    onTrim(listener: (count: number) => void): { dispose(): void };
  };
  getBlankLine(attr: unknown, wrapped?: boolean): XtermScreenLine;
  getNullCell(): {
    fg: number;
    bg: number;
    extended: ScreenCellAttributes & { clone(): ScreenCellAttributes };
  };
};
