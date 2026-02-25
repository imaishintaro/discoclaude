# Discord Claude Code Bot — システム仕様書

> **プロジェクト名:** discord-claude-code-bot
> **バージョン:** 1.0.0
> **最終更新日:** 2026-02-26
> **ドキュメント種別:** システム仕様書

---

## 目次

1. [概要](#1-概要)
2. [システムアーキテクチャ](#2-システムアーキテクチャ)
3. [技術スタック](#3-技術スタック)
4. [ファイル構成](#4-ファイル構成)
5. [AIバックエンド](#5-aiバックエンド)
6. [Discord インターフェース](#6-discord-インターフェース)
7. [ツール一覧](#7-ツール一覧)
8. [セッション管理](#8-セッション管理)
9. [ワークスペース機能](#9-ワークスペース機能)
10. [RAG（長期記憶）](#10-rag長期記憶)
11. [マルチエージェント（ConsultCodingAgent）](#11-マルチエージェントconsultcodingagent)
12. [Cronジョブ管理](#12-cronジョブ管理)
13. [セキュリティ](#13-セキュリティ)
14. [環境変数](#14-環境変数)
15. [ビルド・起動](#15-ビルド起動)

---

## 1. 概要

Discord上でAI（Claude等）と対話し、ファイル操作・コード生成・ウェブ検索・定期タスク実行などを行えるボット。エージェントハンズオン用プロジェクトとして開発。

### 主要機能

- **マルチターン会話** — チャンネルごとにチャット履歴を保持し、文脈を維持した対話が可能
- **ツール実行** — ワークスペース内でのファイル操作・シェルコマンド実行
- **マルチエージェント** — コーディング専門エージェントへの委譲（3フェーズパイプライン）
- **RAG長期記憶** — 会話要約のベクトル検索による文脈注入
- **Cronジョブ** — YAML定義による定期・単発タスクのスケジュール実行
- **ワークスペース分離** — Discordカテゴリ単位での作業ディレクトリ切り替え
- **添付ファイル対応** — 画像のVision API解析、ファイル内容のプロンプト注入

---

## 2. システムアーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                   Discord (ユーザー入力)                      │
│  /claude | !command | プレフィクス/メンション | DM | AUTO     │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────▼──────────────┐
         │     index.ts               │
         │  (イベントハンドラ)         │
         │  • interactionCreate       │
         │  • messageCreate           │
         │  • ready                   │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────────────────┐
         │  ClaudeSessionManager                   │
         │  (claude-session.ts)                    │
         │  • セッション永続化 (.sessions.json)    │
         │  • ワークスペースルーティング            │
         │  • チャット履歴 (ModelMessage[])         │
         │  • RAG検索 (memory/)                    │
         │  • ツール定義・実行                      │
         └─────────────┬──────────────────────────┘
                       │
         ┌─────────────▼────────────────────────┐
         │  Vercel AI SDK  generateText()        │
         │  • Model: OpenRouter or Anthropic     │
         │  • Tools: Bash, Read, Write, etc.     │
         └─────────────┬────────────────────────┘
                       │
         ┌─────────────┴──────────────┬──────────────┐
         │                            │              │
    ┌────▼────────┐   ┌──────────────▼────┐  ┌─────▼─────┐
    │ ツール結果   │   │ CodingAgent       │  │ CronRunner│
    │ • ファイル   │   │ (multi-agent.ts)  │  │ (cron-    │
    │ • コマンド   │   │                   │  │ runner.ts)│
    │ • 検索結果   │   │ Phase 1: 仕様提案 │  │           │
    └─────────────┘   │ Phase 2: 実装     │  │ YAML定義  │
                      │ Phase 3: レビュー │  │ スケジュール│
                      └───────────────────┘  └───────────┘
                              │
                    ┌─────────▼──────────┐
                    │ #agent-chat        │
                    │ (マルチエージェント │
                    │  ログチャンネル)    │
                    └────────────────────┘
```

---

## 3. 技術スタック

| 層 | 技術 |
|---|---|
| フロントエンド | Discord（discord.js v14.18） |
| AIバックエンド | Vercel AI SDK（ai v6.0.97） |
| モデル接続 | OpenRouter経由 or Anthropic直接 |
| 言語 | TypeScript 5.7 → tsc でビルド |
| スケジュール | node-schedule 2.1 |
| 設定 | js-yaml 4.1 / dotenv |
| バリデーション | zod v4.3 |
| 実行環境 | Mac mini ローカル / Node.js |

### 依存パッケージ

```json
{
  "@ai-sdk/anthropic": "^3.0.46",
  "@ai-sdk/openai": "^3.0.30",
  "ai": "^6.0.97",
  "discord.js": "^14.18.0",
  "dotenv": "^16.4.7",
  "js-yaml": "^4.1.1",
  "node-schedule": "^2.1.1",
  "zod": "^4.3.6"
}
```

---

## 4. ファイル構成

```
discord-claude-code-bot/
├── src/
│   ├── index.ts              # エントリポイント（1264行）
│   ├── claude-session.ts     # セッション管理・ツール・RAG（1193行）
│   ├── multi-agent.ts        # コーディングエージェント（835行）
│   ├── cron-runner.ts        # Cronジョブ管理（312行）
│   └── deploy-commands.ts    # スラッシュコマンド登録（117行）
├── workspace/                # ボットの作業ディレクトリ
│   ├── projects/             # 開発プロジェクト
│   ├── memory/               # RAG記憶ファイル
│   │   ├── memory_*.md       # 会話要約
│   │   └── .embeddings.json  # ベクトルキャッシュ
│   └── ...
├── identify.md               # AIの人格設定（システムプロンプト）
├── context.md                # プロジェクトコンテキスト（ツール説明等）
├── .sessions.json            # セッション永続化データ
├── crontab.yaml              # Cronジョブ定義
├── backlog.yaml              # 実行済み単発ジョブの記録
├── package.json
├── tsconfig.json
└── .env                      # 環境変数
```

---

## 5. AIバックエンド

### モデル選択ロジック

```
OPENROUTER_API_KEY が設定されている場合:
  → OpenRouter Chat Completions API を使用
  → openrouter.chat(model) で呼び出し

ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN が設定されている場合:
  → Anthropic API を直接使用

どちらもない場合:
  → 警告を出力し、起動は継続
```

### デフォルトモデル

- メインエージェント: `claude-sonnet-4-20250514`（`MODEL` 環境変数で変更可）
- コーディングエージェント: `CODING_AGENT_MODEL` 環境変数で独立指定可

### モデル切り替え

- `/claude-model` スラッシュコマンドでチャンネルごとに変更
- 選択肢: Sonnet（バランス型）/ Opus（最高性能）/ Haiku（最速・軽量）

### 重要な注意点

- `@ai-sdk/openai` v6 はデフォルトで `/v1/responses` エンドポイントを使用する
- OpenRouter利用時は必ず `.chat()` メソッドを使い Chat Completions API を指定すること
- `stopWhen: stepCountIs(50)` が `maxSteps` の代替（AI SDK v6の仕様）

---

## 6. Discord インターフェース

### 6.1 メッセージ受信方式

ボットは以下のいずれかの方法でメッセージを受信する:

| 方式 | 説明 |
|---|---|
| スラッシュコマンド | `/claude <prompt>` で明示的に送信 |
| メンション | `@ボット名 メッセージ` でメンション |
| プレフィクス | 設定されたプレフィクス（例: `!ai`）で開始するメッセージ |
| AUTO_CHANNELS | 指定チャンネルではすべてのメッセージに自動応答 |
| ダイレクトメッセージ | DMでの直接対話 |
| ダイレクトコマンド | `!コマンド` でAIを介さずシェル実行 |

### 6.2 スラッシュコマンド一覧

| コマンド | 説明 | パラメータ |
|---|---|---|
| `/claude` | Claude Codeにメッセージを送る | `prompt` (必須): 送信テキスト |
| `/claude-clear` | セッションをリセット | なし |
| `/claude-model` | 使用モデルを変更 | `model` (必須): Sonnet/Opus/Haiku |
| `/claude-workspace` | ワークスペース登録 | `name` (必須), `directory` (必須) |
| `/claude-workspaces` | ワークスペース一覧表示 | なし |
| `/claude-help` | ヘルプ表示 | なし |
| `/cron-list` | スケジュールジョブ一覧 | なし |
| `/cron-reload` | crontab.yaml 再読み込み | なし |
| `/cron-id` | チャンネルID表示 | なし |

### 6.3 ダイレクトコマンド (`!command`)

`!` で始まるメッセージはAIを介さず、直接シェルコマンドとして実行される。

- 実行はワークスペースディレクトリ内で行われる
- 禁止コマンドはブロックされる（[セキュリティ](#13-セキュリティ)参照）
- 実行結果はDiscord Embedで返信
- 実行後、AIのchatHistoryにコマンドと結果が通知される

### 6.4 応答表示

- 応答はDiscord Embedで表示される（4000文字制限で自動分割）
- 処理中は進捗Embedがリアルタイム更新される（2秒間隔でレート制限）
- ツール呼び出し・結果・思考過程が進捗として表示される

### 6.5 添付ファイル処理

| ファイル種別 | 処理 |
|---|---|
| 画像 (png, jpg等) | Vision API（OpenRouter経由）でテキスト化してプロンプトに追加 |
| テキストファイル | ワークスペースにダウンロード後、内容をプロンプトに注入 |
| その他 | ワークスペースにダウンロード、パスを通知 |

- サイズ上限: 25MB
- ダウンロード先: `workspace/.discord-attachments/`

---

## 7. ツール一覧

AIエージェントが使用できるツール。すべてワークスペースディレクトリ内のみアクセス可能。

### 7.1 コアツール

| ツール名 | 説明 | 主要パラメータ |
|---|---|---|
| **Bash** | シェルコマンドを実行 | `command`: 実行コマンド |
| **Read** | ファイルを読み込む | `path`: ファイルパス |
| **Write** | ファイルに書き込む（親ディレクトリ自動作成） | `path`, `content` |
| **Edit** | ファイル内の文字列を置換して編集 | `path`, `old_string`, `new_string` |
| **Glob** | ファイルパターン検索 | `pattern`: globパターン |
| **Grep** | テキスト検索（正規表現対応） | `pattern`, `path`(任意) |

### 7.2 拡張ツール

| ツール名 | 説明 | 条件 |
|---|---|---|
| **WebSearch** | SearXNG経由のウェブ検索 | `SEARXNG_URL` 設定時のみ有効 |
| **ConsultCodingAgent** | コーディング専門エージェントに相談 | `AGENT_CHAT_CHANNEL_ID` 設定時のみ有効 |

### 7.3 ツール実行制約

- **タイムアウト**: 30秒
- **パス制約**: ワークスペースディレクトリ外へのアクセスは `checkPath()` でブロック
- **Bash制限**: 禁止パターンに一致するコマンドは実行拒否
- **環境変数**: `HOME` をワークスペースディレクトリに制限

---

## 8. セッション管理

### 8.1 データ構造

```typescript
// チャット履歴（AIモデルとの会話を保持）
chatHistory: Map<string, ModelMessage[]>

// 会話履歴（人間可読形式、RAG用）
conversationHistory: Map<string, ConversationTurn[]>

// チャンネルごとのモデル設定
channelModels: Map<string, string>
```

### 8.2 永続化

- 保存先: `.sessions.json`
- 保存タイミング: 会話ごと / 設定変更ごと
- 保存内容:
  - `channelModels` — チャンネルごとのモデル設定
  - `workspaces` — ワークスペース設定
  - `channelCategoryCache` — チャンネル→カテゴリのキャッシュ
  - `conversationHistory` — 会話ログ（RAG用）
  - `chatHistory` — AIモデルとのチャット履歴（チャンネルあたり最大40メッセージ）

### 8.3 コンテキストオーバーフロー処理

1. チャット履歴が80メッセージを超えた場合 → メモリに保存し、20メッセージにトリム
2. APIがコンテキスト長エラーを返した場合 → メモリに保存し、履歴をクリアして通知

---

## 9. ワークスペース機能

### 9.1 概要

Discordのカテゴリとローカルディレクトリを紐付け、チャンネルごとに作業ディレクトリを自動切り替えする。

### 9.2 データ構造

```typescript
type WorkspaceConfig = {
  name: string;        // ワークスペース名
  directory: string;   // ローカルディレクトリの絶対パス
  categoryId: string;  // DiscordカテゴリID
};
```

### 9.3 ルーティングロジック

```
1. チャンネルのカテゴリIDを取得（キャッシュあり）
2. カテゴリIDに紐づくワークスペースを検索
3. 見つかった場合 → そのワークスペースのディレクトリを使用
4. 見つからない場合 → デフォルトのWORK_DIRを使用
```

### 9.4 登録方法

`/claude-workspace name:<名前> directory:<絶対パス>` で登録すると:
- Discordサーバーにカテゴリを自動作成
- カテゴリ内にデフォルトチャンネルを作成
- ワークスペース設定を永続化

---

## 10. RAG（長期記憶）

### 10.1 概要

会話内容をAIで要約し、ファイルに保存。将来の会話時にベクトル検索またはキーワード検索で関連コンテキストを注入する。

### 10.2 記憶の保存フロー

```
会話がしきい値を超える or /claude-clear 実行
  ↓
AIが会話を要約
  ↓
workspace/memory/memory_<timestamp>.md に保存
  ↓
Embedding APIでベクトル化
  ↓
workspace/memory/.embeddings.json にキャッシュ
```

### 10.3 記憶の検索フロー

```
ユーザーがプロンプトを送信
  ↓
EMBEDDING_API_KEY が設定されている場合:
  → プロンプトをベクトル化
  → .embeddings.json とコサイン類似度を計算
  → しきい値 0.5 以上の結果を取得

EMBEDDING_API_KEY が未設定の場合:
  → キーワード検索にフォールバック
  ↓
関連する記憶をシステムプロンプトに注入
```

### 10.4 自動管理

- **メモリウォッチャー**: `memory/` ディレクトリを監視し、ファイル変更時にエンベディングを自動更新
- **自動トリム**: チャット履歴が80メッセージを超えたら自動保存 + トリム

### 10.5 設定

| 環境変数 | 説明 | デフォルト |
|---|---|---|
| `EMBEDDING_API_KEY` | Embedding APIキー | なし（キーワード検索にフォールバック） |
| `EMBEDDING_BASE_URL` | Embedding APIエンドポイント | OpenAI互換API |
| `EMBEDDING_MODEL` | 使用するEmbeddingモデル | `text-embedding-3-small` |

---

## 11. マルチエージェント（ConsultCodingAgent）

### 11.1 概要

メインエージェント（クロウ）がコーディングタスクを受けた際、専門のコーディングエージェントに委譲する仕組み。処理は `#agent-chat` チャンネルにリアルタイムで投稿される。

### 11.2 3フェーズパイプライン

#### Phase 1: 仕様提案（ツールなし）

- コーディングエージェントが以下を提案:
  - 機能一覧
  - 技術選定
  - ファイル構成
  - 実装方針
- `#agent-chat` に紫色のEmbedで投稿
- ユーザーチャンネルには「コーダーと仕様を相談中...」と表示
- **フィードバックモード時はスキップ**

#### Phase 2: 実装（ツールあり・自動継続ループ）

- 仕様に基づいてファイル作成・編集・コマンド実行を行う
- **自動継続メカニズム:**
  - 最大5ラウンド
  - `toolChoice: "required"` で最終ラウンドまでツール使用を強制
  - ステップ45で `"auto"` に切り替え（残り5ステップ）
  - 完了検知: テキストパターン（「完了」「最終報告」等）
  - 終了条件: ツール未使用 or 完了テキスト検出 or 最大ラウンド到達
- 進捗: ユーザーチャンネルに10秒ごと、`#agent-chat` に2秒ごとに更新

#### Phase 3: 内部レビュー（最大3ラウンド）

- 実装結果をJSON形式でレビュー:

```json
{
  "approved": true/false,
  "score": 1-10,
  "issues": ["..."],
  "suggestions": ["..."],
  "summary": "..."
}
```

- スコア7以上 → 承認
- スコア7未満 → フィードバック付きでPhase 2を再実行
- 最大3回のレビューループ
- レビュー結果は `#agent-chat` に青色のEmbedで投稿

### 11.3 Embed配色

| 色 | 用途 |
|---|---|
| `#607d8b`（青灰色）| クロウ→コーダーへの依頼 |
| `#9b59b6`（紫）| コーダーの仕様提案 |
| `#f59e0b`（黄色）| ツール実行中の進捗 |
| `#2ecc71`（緑）| コーダーの最終回答 |
| `#3498db`（青）| レビュー結果 |
| `#e67e22`（オレンジ）| クロウからの修正依頼 |

### 11.4 フィードバックモード

クロウがコーディングエージェントの結果に問題を発見した場合、`feedback` パラメータ付きで再呼び出しする。

```
ConsultCodingAgent({
  task: "元の依頼内容",
  feedback: "エラー処理が不足。try-catchを追加して"
})
```

- Phase 1（仕様提案）をスキップし、修正モードで直接実装に入る

---

## 12. Cronジョブ管理

### 12.1 概要

`crontab.yaml` に定義されたジョブを `node-schedule` でスケジュール実行する。実行時はClaudeSessionManagerの `sendPrompt()` を呼び出し、結果をDiscordチャンネルに投稿する。

### 12.2 ジョブ種別

| 種別 | 説明 | 実行後の扱い |
|---|---|---|
| `repeat` | 繰り返し実行 | そのまま維持 |
| `once` | 単発実行 | `backlog.yaml` にアーカイブ |

### 12.3 設定ファイル形式（crontab.yaml）

```yaml
jobs:
  - id: daily-report          # 省略時は自動生成
    type: repeat
    cron: "0 9 * * 1-5"       # 平日9:00
    channel_id: "123456789"
    prompt: "日次レポートを作成して"
    enabled: true

  - id: onetime-task
    type: once
    cron: "0 15 1 3 *"        # 3月1日 15:00に1回だけ
    channel_id: "123456789"
    prompt: "月次集計を実行して"
    enabled: true
```

### 12.4 Cron式フォーマット

```
"分 時 日 月 曜日"
 │  │  │  │  └── 曜日 (0-7, 0と7は日曜)
 │  │  │  └───── 月 (1-12)
 │  │  └──────── 日 (1-31)
 │  └─────────── 時 (0-23)
 └────────────── 分 (0-59)
```

### 12.5 ファイル監視

- `crontab.yaml` を5秒間隔で監視
- ファイル変更を検出すると自動で再読み込み
- `/cron-reload` コマンドで手動再読み込みも可能

---

## 13. セキュリティ

### 13.1 禁止コマンド

以下のパターンに一致するコマンドは Bash ツールおよびダイレクトコマンド (`!command`) で実行をブロックされる。

| パターン | 説明 |
|---|---|
| `\bsudo\b` | 権限昇格 |
| `\bsu\b` | ユーザー切り替え |
| `\bchmod\b` | パーミッション変更 |
| `\bchown\b` | オーナー変更 |
| `\brm\s+(-[^\s]*)?-rf?\s+\/` | ルートへの再帰削除 |
| `\brm\s+(-[^\s]*)?-rf?\s+~` | ホームディレクトリ削除 |
| `\bshutdown\b` | シャットダウン |
| `\breboot\b` | 再起動 |
| `\bmkfs\b` | フォーマット |
| `\bdd\b\s` | ディスク書き込み |
| `>\s*\/(?!dev\/null)` | ルート直下へのリダイレクト |
| `\bcurl\b.*\|\s*\bbash\b` | curl パイプ実行 |
| `\bwget\b.*\|\s*\bbash\b` | wget パイプ実行 |

### 13.2 パス制約

- すべてのツール（Bash以外）は `checkPath()` で実行前にパスを検証
- ワークスペースディレクトリ外へのアクセスはブロック
- `../` を使ったディレクトリトラバーサルを防止
- `HOME` 環境変数をワークスペースディレクトリに制限

### 13.3 ユーザー制限

- `ALLOWED_USER_IDS` 環境変数でボットを使用できるユーザーを制限可能
- 未設定の場合は全ユーザーがアクセス可能

### 13.4 レート制限

- Discord Embed更新: 最小2秒間隔
- Bash実行: 30秒タイムアウト

---

## 14. 環境変数

### 必須

| 変数名 | 説明 |
|---|---|
| `DISCORD_TOKEN` | Discordボットトークン |
| `DISCORD_CLIENT_ID` | Discordアプリケーション クライアントID（コマンド登録時に必要） |

### AIバックエンド（いずれか1つ）

| 変数名 | 説明 |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter APIキー（推奨） |
| `ANTHROPIC_API_KEY` | Anthropic APIキー |
| `ANTHROPIC_AUTH_TOKEN` | Anthropic認証トークン（Proプラン用） |

### オプション

| 変数名 | 説明 | デフォルト |
|---|---|---|
| `MODEL` | デフォルトAIモデル | `claude-sonnet-4-20250514` |
| `CODING_AGENT_MODEL` | コーディングエージェント用モデル | `MODEL` と同じ |
| `WORK_DIR` | デフォルトワークスペースディレクトリ | カレントディレクトリ |
| `ALLOWED_USER_IDS` | 許可ユーザーID（カンマ区切り） | 全ユーザー許可 |
| `AUTO_CHANNELS` | 自動応答チャンネルID（カンマ区切り） | なし |
| `AGENT_CHAT_CHANNEL_ID` | マルチエージェントログチャンネル | なし（ConsultCodingAgent無効） |
| `EMBEDDING_API_KEY` | Embedding APIキー | なし（キーワード検索にフォールバック） |
| `EMBEDDING_BASE_URL` | Embedding APIエンドポイント | OpenAI互換 |
| `EMBEDDING_MODEL` | Embeddingモデル | `text-embedding-3-small` |
| `SEARXNG_URL` | SearXNG検索エンドポイント | なし（WebSearch無効） |
| `SYSTEM_PROMPT` | カスタムシステムプロンプト | identify.md + context.md |

---

## 15. ビルド・起動

### ビルド

```bash
cd discord-claude-code-bot
npm run build    # tsc でTypeScriptをコンパイル → dist/
```

### 起動

```bash
npm start        # dist/index.js を実行
npm run dev      # ビルド + 起動
```

### スラッシュコマンド登録（初回のみ）

```bash
npm run deploy-commands
```

### 前提条件

1. `.env` ファイルに必須環境変数を設定
2. Discord Developer Portalでボットを作成し、以下のIntentsを有効化:
   - Guilds
   - GuildMessages
   - MessageContent
   - DirectMessages
3. ボットをDiscordサーバーに招待
