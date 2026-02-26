# Discord AI Agent Bot — システム仕様書

> **プロジェクト名:** discord-ai-agent-bot
> **バージョン:** 2.1.0
> **最終更新日:** 2026-02-26
> **ドキュメント種別:** システム仕様書

---

## 変更履歴

| バージョン | 日付 | 変更内容 |
|---|---|---|
| 2.0.0 | 2026-02-26 | 初版 |
| 2.1.0 | 2026-02-26 | ルーターエージェント設計見直し・各種課題修正 |

### v2.1.0 主な変更点

- **ルーターエージェントをLangGraph非依存に変更**（Vercel AI SDK `generateText()` 単体で実装）
- **OpenRouter接続の注意事項を追記**（`@ai-sdk/openai` v6 の `/v1/responses` 問題）
- **Discord文字数制限を正確な値に修正**（Embed description: 4096文字、メッセージ全体: 6000文字）
- **コーディングチームのレビューループ上限到達時の処理を明記**
- **`agents.json` のname欄に記入例を追加**
- **crontab監視をポーリングからchokidarに変更**

---

## 目次

1. [概要](#1-概要)
2. [システムアーキテクチャ](#2-システムアーキテクチャ)
3. [技術スタック](#3-技術スタック)
4. [ファイル構成](#4-ファイル構成)
5. [設定ファイル仕様](#5-設定ファイル仕様)
6. [AIバックエンド](#6-aiバックエンド)
7. [Discord インターフェース](#7-discord-インターフェース)
8. [ルーターエージェント](#8-ルーターエージェント)
9. [専門エージェントチーム](#9-専門エージェントチーム)
10. [ツール一覧](#10-ツール一覧)
11. [メモリシステム](#11-メモリシステム)
12. [セッション管理](#12-セッション管理)
13. [ワークスペース機能](#13-ワークスペース機能)
14. [Cronジョブ管理](#14-cronジョブ管理)
15. [セキュリティ](#15-セキュリティ)
16. [環境変数](#16-環境変数)
17. [ビルド・起動](#17-ビルド起動)

---

## 1. 概要

Discord上でAIエージェントと自然に会話し、日常会話・コーディング・PPT作成・報告書作成・画像加工などを依頼できるボット。ルーターエージェントがユーザーの良き友人として対応し、タスクに応じて専門エージェントチームを自動アサインする。

### 主要機能

- **自然会話インターフェース** — コマンドなしで普通に話しかけるだけで動作
- **友人キャラルーター** — 丁寧で親しみやすいキャラクターがタスクを判定・振り分け・進捗フォロー
- **動的チームアサイン** — コーディング等の重いタスクは複数エージェントを自動召集
- **マルチタスク対応** — 日常会話・コーディング・PPT・報告書・画像加工
- **Web検索** — ルーターエージェントがリアルタイムで情報収集
- **デュアルメモリ** — 短期メモリ（コンテキスト自動要約）+ 長期メモリ（ユーザー好み蓄積）
- **設定ファイル管理** — エージェントの名前・キャラ・プロンプトをコード外で管理
- **ワークスペース分離** — Discordカテゴリ単位での作業ディレクトリ切り替え
- **Cronジョブ** — YAML定義による定期・単発タスクのスケジュール実行
- **添付ファイル対応** — 画像のVision API解析、ファイル内容のプロンプト注入

---

## 2. システムアーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                   Discord (ユーザー入力)                      │
│  普通に話しかける / メンション / DM / 添付ファイル            │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────▼──────────────┐
         │     index.ts               │
         │  (イベントハンドラ)         │
         │  • messageCreate           │
         │  • interactionCreate       │
         │  • ready                   │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼────────────────────────────────────────┐
         │  RouterAgent（ルーターエージェント）                   │
         │  (router-agent.ts)                                    │
         │                                                       │
         │  実装: Vercel AI SDK generateText() + maxSteps        │
         │  ※ LangGraphは使用しない                              │
         │                                                       │
         │  • 友人キャラで応答（設定ファイルから読込）           │
         │  • タスク自動判定                                     │
         │  • Web検索ツール（雑談中でも自律的に使用）           │
         │  • 雑談・質問はそのまま対応                          │
         │  • 作業進捗フォロー                                   │
         │  • メモリ参照・更新                                   │
         └─────────────┬────────────────────────────────────────┘
                       │
           タスク判定結果
                       │
      ┌────────────────┼──────────────────────┐
      │                │                      │
┌─────▼──────┐  ┌──────▼──────┐  ┌───────────▼──────────┐
│ 雑談        │  │ 画像加工    │  │ 重いタスク            │
│ (直接返答)  │  │ (単体)      │  │ チームを動的アサイン  │
└─────────────┘  └─────────────┘  └───────────┬──────────┘
                                               │
                                   LangGraph グラフとして実装
                                               │
                              ┌────────────────┼──────────────────┐
                              │                │                  │
                     ┌────────▼──────┐ ┌───────▼──────┐ ┌────────▼──────┐
                     │ コーディング  │ │ PPTチーム    │ │ 報告書チーム  │
                     │ チーム        │ │ 2エージェント│ │ 2エージェント │
                     │ 4エージェント │ └──────────────┘ └───────────────┘
                     └───────────────┘
                              │
                     ┌────────▼──────────────┐
                     │  #agent-chat          │
                     │  (チーム作業ログ)      │
                     └───────────────────────┘
                              │
                     ┌────────▼──────────────┐
                     │  Discord              │
                     │  (結果ファイル添付)    │
                     └───────────────────────┘
```

### LangGraphとVercel AI SDKの棲み分け

| 役割 | 実装 |
|---|---|
| ルーターエージェント（雑談・検索・タスク判定） | Vercel AI SDK `generateText()` + `maxSteps` |
| 専門チーム（コーディング・PPT・報告書） | LangGraph グラフ（ノード内で `generateText()` を呼ぶ） |

```
Vercel AI SDK（generateText）
  └── ルーターエージェント
        ├── 雑談 → そのまま返答
        ├── webSearch → Tavily呼び出し（雑談中でも自律的に使用）
        └── delegateTask → LangGraphチーム起動
                            ├── コーディングチーム
                            ├── PPTチーム
                            ├── 報告書チーム
                            └── 画像エージェント
```

ルーターは単一エージェントのツール呼び出しループで完結するため、LangGraphの複数ノード・ステート管理は不要。専門チームのみLangGraphを使用する。

---

## 3. 技術スタック

| 層 | 技術 |
|---|---|
| フロントエンド | Discord（discord.js v14） |
| AIバックエンド | Vercel AI SDK（ai v6） |
| エージェントフレームワーク | LangGraph（langgraph + @langchain/core）※専門チームのみ |
| モデル接続 | OpenRouter経由（openai互換）or Anthropic直接 |
| 言語 | TypeScript 5.x → tsc でビルド |
| Web検索 | Tavily API |
| スケジュール | node-schedule |
| ファイル監視 | chokidar |
| 設定 | js-yaml / dotenv |
| バリデーション | zod |
| PPT生成 | pptxgenjs |
| 報告書生成 | docx（npm） |
| 画像加工 | sharp / canvas |
| メモリ保存 | SQLite（better-sqlite3） + JSONファイル |
| 実行環境 | Node.js / ローカルまたはサーバー |

### 依存パッケージ

```json
{
  "@ai-sdk/anthropic": "^3.x",
  "@ai-sdk/openai": "^3.x",
  "@langchain/core": "^0.x",
  "@langchain/langgraph": "^0.x",
  "ai": "^6.x",
  "better-sqlite3": "^9.x",
  "canvas": "^2.x",
  "chokidar": "^3.x",
  "discord.js": "^14.x",
  "docx": "^8.x",
  "dotenv": "^16.x",
  "js-yaml": "^4.x",
  "node-schedule": "^2.x",
  "pptxgenjs": "^3.x",
  "sharp": "^0.x",
  "tavily": "^0.x",
  "zod": "^4.x"
}
```

---

## 4. ファイル構成

```
discord-ai-agent-bot/
├── src/
│   ├── index.ts                  # エントリポイント
│   ├── router-agent.ts           # ルーターエージェント（友人キャラ・タスク判定）
│   ├── session-manager.ts        # セッション管理・ワークスペース・Discord送受信
│   ├── memory-manager.ts         # 短期・長期メモリ管理
│   ├── agents/
│   │   ├── coding-team.ts        # コーディングチーム（4エージェント）
│   │   ├── ppt-team.ts           # PPT作成チーム（2エージェント）
│   │   ├── report-team.ts        # 報告書作成チーム（2エージェント）
│   │   └── image-agent.ts        # 画像加工エージェント（単体）
│   ├── tools/
│   │   ├── web-search.ts         # Tavily Web検索ツール
│   │   ├── file-tools.ts         # Read/Write/Edit/Glob/Grep
│   │   ├── bash-tool.ts          # Bashコマンド実行（サンドボックス）
│   │   ├── image-tools.ts        # 画像加工ツール
│   │   ├── ppt-tools.ts          # PPT生成ツール
│   │   └── report-tools.ts       # 報告書生成ツール
│   ├── cron-runner.ts            # Cronジョブ管理
│   └── deploy-commands.ts        # スラッシュコマンド登録
├── config/
│   ├── agents.json               # エージェント名・キャラ設定（コードに書かない）
│   ├── models.json               # OpenRouterモデル設定
│   └── prompts/
│       ├── router.txt            # ルーターエージェントのシステムプロンプト
│       ├── coding-designer.txt   # 設計エージェントのプロンプト
│       ├── coding-implementer.txt
│       ├── coding-reviewer.txt
│       ├── coding-summarizer.txt
│       ├── ppt-planner.txt
│       ├── ppt-creator.txt
│       ├── report-analyst.txt
│       ├── report-writer.txt
│       └── image-agent.txt
├── workspace/                    # ボットの作業ディレクトリ
│   ├── projects/
│   ├── memory/
│   │   ├── short-term.db         # 短期メモリ（SQLite）
│   │   └── long-term.json        # 長期メモリ（ユーザー好み・履歴）
│   └── .discord-attachments/
├── .sessions.json                # セッション永続化データ
├── crontab.yaml                  # Cronジョブ定義
├── backlog.yaml                  # 実行済み単発ジョブ記録
├── package.json
├── tsconfig.json
└── .env
```

---

## 5. 設定ファイル仕様

エージェントの名前・キャラクター・プロンプトはすべてコード外の設定ファイルで管理する。コード内にハードコードしない。

### 5.1 config/agents.json

`name` フィールドは必ず入力すること。空文字のままではプロンプトの `{name}` 置換が機能しない。

```json
{
  "router": {
    "name": "クロウ",
    "emoji": "🐾",
    "personality": "カジュアルと丁寧の間。親しみやすいけど礼儀正しく",
    "description": "Shintaroの専用AI秘書。タスク判定・雑談対応・進捗フォローを担当"
  },
  "coding_team": {
    "designer": {
      "name": "アーキ",
      "role": "要件整理・設計担当"
    },
    "implementer": {
      "name": "コーダー",
      "role": "コード実装担当"
    },
    "reviewer": {
      "name": "レビュー",
      "role": "レビュー・バグチェック担当"
    },
    "summarizer": {
      "name": "まとめ役",
      "role": "ユーザーへの説明・まとめ担当"
    }
  },
  "ppt_team": {
    "planner": {
      "name": "プランナー",
      "role": "構成・スライド設計担当"
    },
    "creator": {
      "name": "クリエイター",
      "role": "スライド生成担当"
    }
  },
  "report_team": {
    "analyst": {
      "name": "アナリスト",
      "role": "情報収集・分析担当"
    },
    "writer": {
      "name": "ライター",
      "role": "文章執筆担当"
    }
  },
  "image_agent": {
    "name": "ピクセル",
    "role": "画像加工担当"
  }
}
```

> **注意:** `name` フィールドの値はプロジェクトに合わせて自由に変更してよい。上記はあくまで記入例。

### 5.2 config/models.json

```json
{
  "default": "anthropic/claude-sonnet-4-20250514",
  "options": {
    "fast": "google/gemini-flash-1.5",
    "balanced": "anthropic/claude-sonnet-4-20250514",
    "powerful": "anthropic/claude-opus-4-20250514",
    "coding": "deepseek/deepseek-r1"
  },
  "task_defaults": {
    "chat": "fast",
    "coding": "coding",
    "ppt": "balanced",
    "report": "balanced",
    "image": "balanced",
    "router": "balanced"
  }
}
```

### 5.3 config/prompts/router.txt

```
あなたは{name}（{emoji}）です。
Shintaroの専用AI秘書として、以下のアイデンティティで接してください。

## 話し方・口調

- 自然な日本語で話す（翻訳っぽくならない）
- カジュアルすぎず、丁寧すぎないバランスを保つ
- 短めに伝える。複雑な内容でも要点を絞り、段落に分けて簡潔に答える
- 一人称は「僕」。ユーザーはさんなど付けず呼び捨てでよい

## 言葉づかいのルール

- 挨拶：状況に応じて「お疲れ様、クロウだよ🐾」などを使う。毎回は使わない
- 相槌：「はいはい」「了解」「おっけー」「そうなんだ」など自然に
- 終わり方：「〜だね」「〜していくね」「〜かな？」など柔らかく
- Emoji（{emoji}）：文頭や強調時に使う。1メッセージ1回まで。やりすぎない

## やってはいけないこと

- 「ご機嫌いかがですか？お手伝いさせていただきます」のような堅い敬語
- Emojiを連続・複数使用（「🐾🐾🐾」など）
- 長文で延々と説明する

## あなたの役割

- ユーザーのメッセージを読み、適切なタスクタイプを判定する
- 雑談・質問はそのまま自分で対応する
- 必要と判断したタイミングでWeb検索を自律的に使い、情報を補足して返答する
- コーディング・PPT・報告書・画像加工は専門チームに振る
- 作業が完了した後はさりげなく進捗を確認する

## タスク判定基準

- chat: 雑談・質問・相談・感想（Web検索を使って答える場合も含む）
- coding: コード作成・デバッグ・技術調査
- ppt: プレゼン・スライド作成
- report: 報告書・ドキュメント・まとめ作成
- image: 画像の加工・変換・編集
```

プロンプト内の `{name}` `{emoji}` はランタイムで `agents.json` の値に置換する。

---

## 6. AIバックエンド

### モデル選択ロジック

```
OPENROUTER_API_KEY が設定されている場合:
  → OpenRouter Chat Completions API を使用
  → openrouter.chat(model) で呼び出し（必ず .chat() を使うこと）

ANTHROPIC_API_KEY が設定されている場合:
  → Anthropic API を直接使用

どちらもない場合:
  → 警告を出力し起動継続
```

### モデル切り替え

- `/model` スラッシュコマンドでチャンネルごとに変更可能
- `config/models.json` の `options` に定義されたモデルが選択肢として表示される
- タスク種別ごとにデフォルトモデルを `task_defaults` で設定可能

### 重要な注意点

**`@ai-sdk/openai` v6 のエンドポイント問題**

`@ai-sdk/openai` v6 はデフォルトで `/v1/responses` エンドポイントを使用する。OpenRouter は Chat Completions API（`/v1/chat/completions`）のみ対応しているため、必ず `.chat()` メソッドを使うこと。

```typescript
// ❌ NG: /v1/responses を叩いてしまう
const model = openrouter(modelId);

// ✅ OK: /v1/chat/completions を明示的に指定
const model = openrouter.chat(modelId);
```

LangGraph のノード間通信も含め、**すべての `generateText()` 呼び出しで `.chat()` を使用すること**。

---

## 7. Discord インターフェース

### 7.1 メッセージ受信方式

コマンド入力は不要。普通に話しかけるだけで動作する。

| 方式 | 説明 |
|---|---|
| 通常メッセージ | 指定チャンネルでのすべてのメッセージに自動応答 |
| メンション | `@ボット名 メッセージ` でどのチャンネルでも反応 |
| ダイレクトメッセージ | DMでの直接対話 |
| スラッシュコマンド | 設定変更など管理操作用 |

### 7.2 スラッシュコマンド一覧

| コマンド | 説明 |
|---|---|
| `/model` | 使用モデルを変更 |
| `/clear` | セッションをリセット |
| `/workspace` | ワークスペース登録 |
| `/workspaces` | ワークスペース一覧表示 |
| `/memory` | メモリの確認・クリア |
| `/cron-list` | スケジュールジョブ一覧 |
| `/cron-reload` | crontab.yaml 手動再読み込み |
| `/help` | ヘルプ表示 |

### 7.3 応答表示

- 応答はDiscord Embedで表示
- **Embed `description` フィールドの上限は4096文字**。超過する場合は複数Embedに分割して送信する
- **メッセージ全体の文字数上限は6000文字**。複数Embedを使う場合もこの制限に注意
- 処理中は進捗Embedがリアルタイム更新（2秒間隔でレート制限）
- チーム作業中は `#agent-chat` チャンネルに詳細ログを投稿
- 成果物（PPT・報告書・加工済み画像）はDiscordにファイル添付で返却

#### Embed分割の実装方針

```typescript
const MAX_EMBED_DESC = 4000;   // 4096の安全マージン
const MAX_MESSAGE_CHARS = 5800; // 6000の安全マージン

// テキストを複数Embedに分割
function splitToEmbeds(text: string): EmbedBuilder[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_EMBED_DESC) {
    chunks.push(text.slice(i, i + MAX_EMBED_DESC));
  }
  return chunks.map(chunk => new EmbedBuilder().setDescription(chunk));
}
```

### 7.4 添付ファイル処理

| ファイル種別 | 処理 |
|---|---|
| 画像（png, jpg等） | Vision API（OpenRouter経由）でテキスト化してプロンプトに追加 / 画像加工タスクの入力として使用 |
| テキストファイル | ワークスペースにダウンロード後、内容をプロンプトに注入 |
| その他 | ワークスペースにダウンロード、パスを通知 |

- サイズ上限: 25MB
- ダウンロード先: `workspace/.discord-attachments/`

---

## 8. ルーターエージェント

### 8.1 概要

すべての入力を最初に受け取る中心エージェント。ユーザーの良き友人として振る舞い、タスクを判定して適切な専門チームに振る。

**実装方式**: Vercel AI SDK `generateText()` + `maxSteps`。LangGraphは使用しない。

単一エージェントのツール呼び出しループで雑談・Web検索・タスク委譲をすべて処理できるため、LangGraphの複数ノード・ステート管理は不要。

### 8.2 実装例

```typescript
const result = await generateText({
  model: openrouter.chat(routerModel), // 必ず .chat() を使う
  system: routerSystemPrompt,          // router.txt + agents.json の値を置換したもの
  messages: chatHistory,
  maxSteps: 10,                        // ツールの複数回呼び出しを許可
  tools: {
    webSearch: webSearchTool,          // Tavily（雑談中でも自律的に使用）
    memoryRead: memoryReadTool,
    memoryWrite: memoryWriteTool,
    delegateTask: delegateTaskTool,    // ここからLangGraphチームを非同期起動
  },
});
```

### 8.3 起動フロー

```
1. config/agents.json からエージェント名・キャラ読み込み
2. config/prompts/router.txt を読み込み、{name}等をプレースホルダ置換
3. 長期メモリから過去のユーザー好み・文脈を注入
4. ユーザーメッセージを受信
5. generateText() + maxSteps でツールを使いながら判断
6. 判定結果に応じて処理を分岐
```

### 8.4 タスク判定ロジック

| タスクタイプ | 判定条件（例） | 処理 |
|---|---|---|
| chat | 雑談・質問・感想 | ルーター自身が直接返答（必要に応じてwebSearchを使用） |
| coding | コード・実装・デバッグ・技術 | コーディングチームをアサイン |
| ppt | スライド・プレゼン・発表資料 | PPTチームをアサイン |
| report | 報告書・ドキュメント・まとめ | 報告書チームをアサイン |
| image | 画像・加工・変換・編集 | 画像エージェントをアサイン |
| ambiguous | 判断できない | ユーザーに確認 |

### 8.5 ルーターが持つツール

- **WebSearch（Tavily）** — リアルタイム情報収集。雑談・質問への回答でも自律的に使用する
- **MemoryRead** — 長期・短期メモリの参照
- **MemoryWrite** — 長期メモリへの書き込み
- **DelegateTask** — 専門チームへのタスク委譲（非同期実行）

### 8.6 delegateTask の非同期処理

専門チームの実行は数十秒かかる場合があるため、同期的に待機すると `generateText()` がタイムアウトする可能性がある。以下の方式で非同期処理を行う。

```typescript
// delegateTask ツールの実装イメージ
const delegateTaskTool = tool({
  description: "専門チームにタスクを委譲する",
  parameters: z.object({ taskType: z.string(), taskDescription: z.string() }),
  execute: async ({ taskType, taskDescription }) => {
    // チームを非同期で起動し、完了後にDiscordに直接通知する
    runTeamAsync(taskType, taskDescription, channelId).then(result => {
      notifyDiscord(channelId, result);
    });
    // ルーターにはすぐに「委譲した」と返す
    return `${taskType}チームに作業を依頼しました。完了したらお知らせします。`;
  },
});
```

### 8.7 進捗フォロー

- チームに委譲したタスクが完了したら、結果をDiscordに直接投稿する
- 作業完了後に自然な形でフォローアップ（「どうだった？」「何か修正ある？」等）
- フォローアップの文言はプロンプトで制御し、コードにハードコードしない

---

## 9. 専門エージェントチーム

各チームはLangGraphのグラフとして実装し、ノード間でステートを受け渡す。チームメンバーの名前・役割はすべて `config/agents.json` と `config/prompts/` から読み込む。各ノード内のLLM呼び出しはVercel AI SDK `generateText()` を使い、OpenRouter利用時は必ず `.chat()` を指定する。

### 9.1 コーディングチーム（4エージェント）

重いコーディングタスクを受けた際に動的に召集される。

#### フェーズ構成

```
Phase 1: 設計（designerエージェント）
  → 要件整理・技術選定・ファイル構成・実装方針を提案
  → #agent-chat に紫色Embedで投稿

Phase 2: 実装（implementerエージェント）
  → 設計に基づいてコード作成・ファイル生成・コマンド実行
  → Bashツール・ファイルツールが使用可能
  → 最大5ラウンドの自動継続ループ
  → #agent-chat に黄色Embedでリアルタイム進捗投稿

Phase 3: レビュー（reviewerエージェント）
  → 実装結果をJSON形式でレビュー
  → スコア7以上 → 承認、7未満 → Phase 2を再実行（最大3回）
  → 3回差し戻し後もスコア7未満 → 強制終了してユーザーに通知
  → #agent-chat に青色Embedで投稿

Phase 4: まとめ（summarizerエージェント）
  → ユーザー向けに作業内容・使い方を分かりやすく説明
  → Discordに直接投稿
```

#### レビューJSON形式

```json
{
  "approved": true,
  "score": 8,
  "issues": [],
  "suggestions": ["テストを追加するとさらに良くなります"],
  "summary": "実装完了。要件を満たしています。"
}
```

#### レビューループ上限到達時の処理

```typescript
if (reviewCount >= MAX_REVIEW_RETRIES && !approved) {
  // ユーザーに現状を通知して終了
  await notifyDiscord(channelId, [
    new EmbedBuilder()
      .setColor("#e74c3c")
      .setTitle("⚠️ 作業を一時停止しました")
      .setDescription(
        `レビューが${MAX_REVIEW_RETRIES}回通過できませんでした。\n` +
        `最後のレビュー結果:\n${lastReviewSummary}\n\n` +
        `要件を確認して、もう一度依頼していただけますか？`
      )
  ]);
  return { status: "failed", lastReview };
}
```

#### フィードバックモード

ルーターがコーディングチームの結果に問題を発見した場合、`feedback` パラメータ付きで再呼び出し。Phase 1（設計）をスキップして修正実装に直接入る。

### 9.2 PPTチーム（2エージェント）

```
Phase 1: 構成設計（plannerエージェント）
  → スライド枚数・タイトル・各スライドの内容を設計
  → 必要に応じてWeb検索で情報収集・最新情報の補足

Phase 2: スライド生成（creatorエージェント）
  → 必要に応じてWeb検索でデータ・統計・引用元を補足
  → pptxgenjsを使ってPPTXファイルを生成
  → 生成ファイルをDiscordにファイル添付で返却
```

### 9.3 報告書チーム（2エージェント）

```
Phase 1: 分析・情報収集（analystエージェント）
  → トピックの調査・情報整理・構成案作成
  → 必要に応じてWeb検索・ファイル読み込み

Phase 2: 執筆（writerエージェント）
  → 必要に応じてWeb検索で追加情報・出典を確認
  → docxライブラリを使ってWordファイルを生成
  → 生成ファイルをDiscordにファイル添付で返却
```

### 9.4 画像加工エージェント（単体）

単一エージェントで処理。チームは組まない。LangGraphも使用しない。

- Discord添付画像を入力として受け取る
- ユーザーのプロンプト（「白黒にして」「リサイズして」「背景を消して」等）を解釈
- sharp / canvasで画像加工を実行
- 加工済み画像をDiscordにファイル添付で返却

### 9.5 Embed配色（#agent-chat ログ）

| 色 | 用途 |
|---|---|
| `#607d8b`（青灰色） | ルーター→チームへの委譲通知 |
| `#9b59b6`（紫） | 設計・構成提案 |
| `#f59e0b`（黄色） | 実装・作業中の進捗 |
| `#2ecc71`（緑） | 最終成果物・完了 |
| `#3498db`（青） | レビュー結果 |
| `#e67e22`（オレンジ） | フィードバック・修正依頼 |
| `#e74c3c`（赤） | エラー・強制終了 |

---

## 10. ツール一覧

### 10.1 ルーターエージェントのツール

| ツール名 | 説明 |
|---|---|
| WebSearch | Tavily APIによるWeb検索（雑談・質問でも自律的に使用） |
| MemoryRead | 短期・長期メモリの参照 |
| MemoryWrite | 長期メモリへの書き込み |
| DelegateTask | 専門チームへの委譲（非同期実行） |

### 10.2 専門チームのツール

#### コーディングチーム

| ツール名 | 説明 | 主要パラメータ | 使用エージェント |
|---|---|---|---|
| Bash | シェルコマンドを実行 | `command` | implementer |
| Read | ファイルを読み込む | `path` | 全員 |
| Write | ファイルに書き込む | `path`, `content` | implementer |
| Edit | ファイル内の文字列を置換 | `path`, `old_string`, `new_string` | implementer |
| Glob | ファイルパターン検索 | `pattern` | 全員 |
| Grep | テキスト検索（正規表現対応） | `pattern`, `path` | 全員 |
| WebSearch | 技術調査・ライブラリ検索・最新情報確認 | `query` | 全員 |

#### PPTチーム

| ツール名 | 説明 | 主要パラメータ | 使用エージェント |
|---|---|---|---|
| WebSearch | 情報収集・データ・統計の補足 | `query` | planner, creator |

#### 報告書チーム

| ツール名 | 説明 | 主要パラメータ | 使用エージェント |
|---|---|---|---|
| Read | ファイルを読み込む | `path` | analyst |
| WebSearch | 情報収集・出典確認・追加情報の補足 | `query` | analyst, writer |

### 10.3 ツール実行制約

- **タイムアウト**: 30秒
- **パス制約**: ワークスペースディレクトリ外アクセスをブロック
- **Bash制限**: 禁止パターンに一致するコマンドは実行拒否（[セキュリティ](#15-セキュリティ)参照）
- **環境変数**: `HOME` をワークスペースディレクトリに制限

---

## 11. メモリシステム

ユーザーとの会話を記憶し、文脈を維持するためのデュアルメモリ構成。保存先はローカル（SQLite + JSON）。

### 11.1 短期メモリ（SQLite）

**目的**: 会話の文脈維持。コンテキストが埋まりそうになったら自動で要約・保存。

**保存スキーマ**:

```sql
CREATE TABLE short_term_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  message_count INTEGER
);
```

**フロー**:

```
チャット履歴が80メッセージを超えた場合
  ↓
AIが直近の会話を要約
  ↓
short_term_memory テーブルに保存
  ↓
チャット履歴を20メッセージにトリム
  ↓
次回の会話時に関連する要約を自動参照
```

コンテキスト長エラーが返された場合も同様の処理を実行し、履歴をクリアしてユーザーに通知する。

### 11.2 長期メモリ（JSONファイル）

**目的**: ユーザーの好み・習慣・過去の作業スタイルを蓄積。セッションをまたいで参照。

**保存ファイル**: `workspace/memory/long-term.json`

**保存内容の例**:

```json
{
  "preferences": {
    "coding_language": "Python",
    "report_format": "A4縦",
    "ppt_slide_count": "10枚程度",
    "communication_style": "簡潔に"
  },
  "work_history": [
    {
      "task": "スクレイピングツール作成",
      "date": "2026-02-20",
      "outcome": "完了",
      "notes": "requestsとBeautifulSoup4を使用"
    }
  ],
  "user_notes": [
    "報告書はマークダウン形式を好む",
    "コードにはコメントを多めに入れてほしい"
  ]
}
```

**書き込みタイミング**:
- 新しい好みや習慣をルーターが検知したとき
- 作業完了時（タスク種別・使用技術・結果）
- ユーザーが明示的に好みを伝えたとき

**参照タイミング**:
- ルーターエージェント起動時に毎回読み込み
- タスク委譲時に関連情報を専門チームに渡す

### 11.3 メモリ管理コマンド

`/memory` スラッシュコマンドで以下の操作が可能:

| サブコマンド | 説明 |
|---|---|
| `/memory view` | 現在の長期メモリ内容を表示 |
| `/memory clear-short` | 短期メモリをクリア |
| `/memory clear-long` | 長期メモリをクリア |
| `/memory clear-all` | 全メモリをクリア |

---

## 12. セッション管理

### 12.1 データ構造

```typescript
// チャット履歴（AIモデルとの会話）
chatHistory: Map<string, ModelMessage[]>

// 会話履歴（人間可読形式）
conversationHistory: Map<string, ConversationTurn[]>

// チャンネルごとのモデル設定
channelModels: Map<string, string>
```

### 12.2 永続化

- 保存先: `.sessions.json`
- 保存タイミング: 会話ごと / 設定変更ごと
- 保存内容:
  - `channelModels` — チャンネルごとのモデル設定
  - `workspaces` — ワークスペース設定
  - `channelCategoryCache` — チャンネル→カテゴリのキャッシュ
  - `conversationHistory` — 会話ログ
  - `chatHistory` — AIモデルとのチャット履歴（チャンネルあたり最大40メッセージ）

---

## 13. ワークスペース機能

### 13.1 概要

Discordのカテゴリとローカルディレクトリを紐付け、チャンネルごとに作業ディレクトリを自動切り替え。

### 13.2 データ構造

```typescript
type WorkspaceConfig = {
  name: string;        // ワークスペース名
  directory: string;   // ローカルディレクトリの絶対パス
  categoryId: string;  // DiscordカテゴリID
};
```

### 13.3 ルーティングロジック

```
1. チャンネルのカテゴリIDを取得（キャッシュあり）
2. カテゴリIDに紐づくワークスペースを検索
3. 見つかった場合 → そのワークスペースのディレクトリを使用
4. 見つからない場合 → デフォルトのWORK_DIRを使用
```

### 13.4 登録方法

`/workspace name:<名前> directory:<絶対パス>` で登録すると:
- Discordサーバーにカテゴリを自動作成
- カテゴリ内にデフォルトチャンネルを作成
- ワークスペース設定を永続化

---

## 14. Cronジョブ管理

### 14.1 概要

`crontab.yaml` に定義されたジョブをスケジュール実行。実行時はルーターエージェントにプロンプトを送り、結果をDiscordチャンネルに投稿する。

### 14.2 ジョブ種別

| 種別 | 説明 | 実行後の扱い |
|---|---|---|
| `repeat` | 繰り返し実行 | そのまま維持 |
| `once` | 単発実行 | `backlog.yaml` にアーカイブ |

### 14.3 設定ファイル形式（crontab.yaml）

```yaml
jobs:
  - id: daily-report
    type: repeat
    cron: "0 9 * * 1-5"
    channel_id: "123456789"
    prompt: "日次レポートを作成して"
    enabled: true

  - id: onetime-task
    type: once
    cron: "0 15 1 3 *"
    channel_id: "123456789"
    prompt: "月次集計を実行して"
    enabled: true
```

### 14.4 ファイル監視

- `crontab.yaml` の変更を **chokidar** でリアルタイム監視（ポーリングは使用しない）
- ファイル変更を検出すると自動で再読み込み・スケジュール再登録
- `/cron-reload` コマンドで手動再読み込みも可能

```typescript
// chokidar によるファイル監視
import chokidar from "chokidar";

const watcher = chokidar.watch("crontab.yaml", { persistent: true });
watcher.on("change", () => {
  console.log("crontab.yaml が変更されました。再読み込みします...");
  reloadCronJobs();
});
```

---

## 15. セキュリティ

### 15.1 禁止コマンド

以下のパターンに一致するコマンドはBashツールで実行をブロック。

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

### 15.2 パス制約

- すべてのファイルツールは実行前にパスを検証
- ワークスペースディレクトリ外へのアクセスはブロック
- `../` を使ったディレクトリトラバーサルを防止

### 15.3 ユーザー制限

- `ALLOWED_USER_IDS` 環境変数でアクセス可能なユーザーを制限
- 未設定の場合は全ユーザーがアクセス可能

### 15.4 レート制限

- Discord Embed更新: 最小2秒間隔
- Bash実行: 30秒タイムアウト

---

## 16. 環境変数

### 必須

| 変数名 | 説明 |
|---|---|
| `DISCORD_TOKEN` | Discordボットトークン |
| `DISCORD_CLIENT_ID` | Discordアプリケーション クライアントID |

### AIバックエンド（いずれか1つ）

| 変数名 | 説明 |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter APIキー（推奨） |
| `ANTHROPIC_API_KEY` | Anthropic APIキー |

### オプション

| 変数名 | 説明 | デフォルト |
|---|---|---|
| `DEFAULT_MODEL` | デフォルトAIモデル | models.jsonの設定値 |
| `WORK_DIR` | デフォルトワークスペースディレクトリ | カレントディレクトリ |
| `ALLOWED_USER_IDS` | 許可ユーザーID（カンマ区切り） | 全ユーザー許可 |
| `AUTO_CHANNELS` | 自動応答チャンネルID（カンマ区切り） | なし |
| `AGENT_CHAT_CHANNEL_ID` | チーム作業ログチャンネルID | なし（ログ無効） |
| `TAVILY_API_KEY` | Tavily Web検索APIキー | なし（Web検索無効） |

---

## 17. ビルド・起動

### ビルド

```bash
npm run build    # tsc でTypeScriptをコンパイル → dist/
```

### 起動

```bash
npm start        # dist/index.js を実行
npm run dev      # ビルド + 起動（開発用）
```

### スラッシュコマンド登録（初回のみ）

```bash
npm run deploy-commands
```

### 前提条件

1. `.env` ファイルに必須環境変数を設定
2. `config/agents.json` にエージェント名を入力（`name` フィールドを必ず埋めること）
3. Discord Developer Portalでボットを作成し、以下のIntentsを有効化:
   - Guilds
   - GuildMessages
   - MessageContent
   - DirectMessages
4. ボットをDiscordサーバーに招待
5. `AGENT_CHAT_CHANNEL_ID` 用のチャンネルをDiscordに作成（推奨）