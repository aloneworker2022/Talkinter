#!/usr/bin/env bash
# Install Talkinter + hermes gateway as user-level systemd services so both
# run in the background, restart on failure, and start at boot.
# Run as your normal user (NOT root):  bash deploy/install.sh
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "請用一般使用者執行，不要用 root / sudo。" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "⚠ 找不到 $REPO_DIR/.env"
  echo "  請先:  cp .env.example .env  並填入你的設定（AGENT_ADAPTER、AGENT_HTTP_URL、AGENT_HTTP_KEY...）"
  exit 1
fi

echo "→ 安裝 systemd user 服務..."
sed "s|@REPO_DIR@|$REPO_DIR|g" "$REPO_DIR/deploy/talkinter.service" > "$UNIT_DIR/talkinter.service"
cp "$REPO_DIR/deploy/hermes-gateway.service" "$UNIT_DIR/hermes-gateway.service"

echo "→ 停掉手動跑著的 hermes gateway（如果有的話）..."
hermes gateway stop >/dev/null 2>&1 || true

systemctl --user daemon-reload
echo "→ 啟用並啟動 hermes-gateway..."
if ! systemctl --user enable --now hermes-gateway.service; then
  echo "⚠ hermes-gateway 啟動失敗（也許 hermes 不在這台機器上？）— 略過，繼續裝 Talkinter"
fi
echo "→ 啟用並啟動 talkinter..."
systemctl --user enable --now talkinter.service

echo "→ 開機自動啟動（不需登入）..."
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "⚠ 需要 root 權限開啟 linger，請手動跑一次："
  echo "    sudo loginctl enable-linger $USER"
fi

echo
echo "✔ 完成！常用指令："
echo "    systemctl --user status talkinter hermes-gateway   # 看狀態"
echo "    journalctl --user -u talkinter -f                  # 看 Talkinter log"
echo "    journalctl --user -u hermes-gateway -f             # 看 gateway log"
echo "    systemctl --user restart talkinter                 # 改 .env 後重啟"
