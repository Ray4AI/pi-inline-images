#!/usr/bin/env bash
# 安装 pi-inline-images 到 pi 扩展目录
#   ./install.sh          复制（推荐）
#   ./install.sh --link   软链（开发调试：改源码即生效）
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/pi-inline-images.ts"
DEST_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions"
DEST="$DEST_DIR/pi-inline-images.ts"

mkdir -p "$DEST_DIR"
rm -f "$DEST"

if [[ "${1:-}" == "--link" ]]; then
  ln -s "$SRC" "$DEST"
  echo "已软链: $DEST -> $SRC"
else
  cp "$SRC" "$DEST"
  echo "已安装: $DEST"
fi

echo "重启 pi 或执行 /reload 后生效。"
