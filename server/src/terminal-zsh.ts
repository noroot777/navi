import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const startup = `if (( \${+NAVI_ZSH_DOTDIR} )); then
  export ZDOTDIR="$NAVI_ZSH_DOTDIR"
else
  unset ZDOTDIR
fi
unset NAVI_ZSH_DOTDIR
if [[ -r "\${ZDOTDIR-$HOME}/.zshenv" ]]; then
  source "\${ZDOTDIR-$HOME}/.zshenv"
fi

_navi_vi_backspace() {
  if [[ $LBUFFER == *$'\\n' ]]; then
    zle .backward-delete-char
  else
    zle .vi-backward-delete-char
  fi
}

_navi_install_vi_backspace() {
  emulate -L zsh
  precmd_functions=("\${(@)precmd_functions:#_navi_install_vi_backspace}")
  local key binding
  for key in '^?' '^H'; do
    binding=$(bindkey -M viins "$key")
    if [[ $binding == "\\\"$key\\\" vi-backward-delete-char" ]]; then
      zle -N _navi_vi_backspace
      bindkey -M viins "$key" _navi_vi_backspace
    fi
  done
}
precmd_functions+=(_navi_install_vi_backspace)
`;

let startupDirectory: string | undefined;

export function zshStartupEnvironment(dotdir: string | undefined): Record<string, string> {
  if (!startupDirectory) {
    const directory = mkdtempSync(join(tmpdir(), "navi-zsh-"));
    const remove = () => { rmSync(directory, { recursive: true, force: true }); };
    try {
      writeFileSync(join(directory, ".zshenv"), startup, { mode: 0o600 });
    } catch (error) {
      remove();
      throw error;
    }
    startupDirectory = directory;
    process.once("exit", remove);
  }
  return {
    ZDOTDIR: startupDirectory,
    ...(dotdir === undefined ? {} : { NAVI_ZSH_DOTDIR: dotdir }),
  };
}
