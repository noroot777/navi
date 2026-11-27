import { terminalTheme, type TerminalTheme } from "@navi/shared/terminal-themes";

export { terminalThemes } from "@navi/shared/terminal-themes";
export type { TerminalTheme } from "@navi/shared/terminal-themes";

export const TERMINAL_APPEARANCE_KEY = "navi:terminal-appearance";
export type TerminalAppearance = { theme: TerminalTheme; fontSize: number };

export function readTerminalAppearance(): TerminalAppearance {
  try {
    const stored = JSON.parse(localStorage.getItem(TERMINAL_APPEARANCE_KEY) ?? "null");
    return {
      theme: terminalTheme(stored?.theme) ?? "graphite",
      fontSize: [12, 14, 16].includes(stored?.fontSize) ? stored.fontSize : 14,
    };
  } catch {
    return { theme: "graphite", fontSize: 14 };
  }
}
