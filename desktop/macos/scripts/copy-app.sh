#!/bin/bash
set -euo pipefail

SOURCE="${1:?用法：copy-app.sh <源.app> <新目标.app>}"
DESTINATION="${2:?用法：copy-app.sh <源.app> <新目标.app>}"
[[ -d "$SOURCE/Contents" ]] || { echo "✕ $SOURCE 不是一个 .app" >&2; exit 1; }
if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
  echo "✕ 复制目标已存在，不覆盖：$DESTINATION" >&2
  exit 1
fi

if /bin/cp -cRp "$SOURCE" "$DESTINATION" 2>/dev/null; then
  exit 0
fi

printf '[mac-copy] clone unavailable; retrying with ditto\n' >&2
rm -rf -- "$DESTINATION"
exec /usr/bin/ditto "$SOURCE" "$DESTINATION"
