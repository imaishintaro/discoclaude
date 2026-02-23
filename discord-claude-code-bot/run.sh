#!/bin/bash

# Discord Claude Code Bot 起動スクリプト（tmux対応）
# tmuxセッション内で起動するため、SSH切断してもボットは動き続ける
#
# 使い方:
#   ./run.sh          — tmuxセッション「discobot」でボットを起動
#   ./run.sh stop     — ボットを停止（tmuxセッションを終了）
#   ./run.sh restart  — ボットを再起動
#   ./run.sh status   — セッションの状態を確認
#   ./run.sh attach   — tmuxセッションにアタッチ（ログ確認用）

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_NAME="discobot"

# --- stop: セッション終了 ---
if [ "$1" = "stop" ]; then
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "$SESSION_NAME"
    echo "✅ $SESSION_NAME セッションを停止しました"
  else
    echo "セッション $SESSION_NAME は起動していません"
  fi
  exit 0
fi

# --- status: 状態確認 ---
if [ "$1" = "status" ]; then
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "✅ $SESSION_NAME は起動中です"
    tmux ls
  else
    echo "❌ $SESSION_NAME は停止しています"
  fi
  exit 0
fi

# --- attach: セッションにアタッチ ---
if [ "$1" = "attach" ]; then
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux attach -t "$SESSION_NAME"
  else
    echo "セッション $SESSION_NAME は起動していません"
  fi
  exit 0
fi

# --- restart: 再起動 ---
if [ "$1" = "restart" ]; then
  echo "再起動中..."
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "$SESSION_NAME"
    echo "旧セッションを停止しました"
  fi
  # 少し待ってから再起動（ポート解放待ち）
  sleep 1
  exec "$0"
fi

# --- 通常起動 ---
# 既にセッションが存在する場合は警告
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "⚠️  セッション $SESSION_NAME は既に起動中です"
  echo "  ログ確認: ./run.sh attach"
  echo "  再起動:   ./run.sh restart"
  echo "  停止:     ./run.sh stop"
  exit 1
fi

# .envの存在チェック
if [ ! -f "$BOT_DIR/.env" ]; then
  echo "エラー: .env ファイルが見つかりません"
  echo "  cp .env.example .env でファイルを作成し、DISCORD_TOKENを設定してください"
  exit 1
fi

# node_modulesのチェック
if [ ! -d "$BOT_DIR/node_modules" ]; then
  echo "依存パッケージをインストールしています..."
  (cd "$BOT_DIR" && npm install)
fi

# ビルド
echo "ビルド中..."
(cd "$BOT_DIR" && npm run build)
if [ $? -ne 0 ]; then
  echo "エラー: ビルドに失敗しました"
  exit 1
fi

# tmuxセッションでボットを起動
tmux new-session -d -s "$SESSION_NAME" -c "$BOT_DIR" "npm start"

echo "======================================"
echo "  Discord Claude Code Bot"
echo "  tmuxセッション: $SESSION_NAME"
echo "======================================"
echo ""
echo "  ログ確認: ./run.sh attach  (Ctrl+B → D で戻る)"
echo "  再起動:   ./run.sh restart"
echo "  停止:     ./run.sh stop"
echo "  状態確認: ./run.sh status"
