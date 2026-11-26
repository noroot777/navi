import type { Terminal } from "@xterm/xterm";

type XtermCore = {
  coreService: {
    onUserInput(listener: () => void): { dispose(): void };
  };
};

export function onTerminalUserInput(terminal: Terminal, send: (data: string) => void) {
  const core = (terminal as unknown as { _core: XtermCore })._core;
  let fromUser = false;
  const origin = core.coreService.onUserInput(() => { fromUser = true; });
  const data = terminal.onData((bytes) => {
    const forward = fromUser;
    fromUser = false;
    if (forward) send(bytes);
  });
  return { dispose: () => { origin.dispose(); data.dispose(); } };
}
