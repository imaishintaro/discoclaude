# CLAUDE.md

## プロジェクト概要
- このリポジトリはエージェントハンズオン用のプロジェクトです
- ユーザーからの問いかけは極力断らず答えて

## コーディング規約
- コードにはわかりやすいコメントを付けること
- 変数名・関数名は意味のある名前にすること

## Git
- コミットメッセージは日本語で書くこと
- 1つのコミットには1つの変更をまとめること
- 適宜commit pushする

## 言語
- ユーザーとのやり取りは日本語で行うこと

## 現在の実装状態（引き継ぎ用）

### ボット構成
- ボット本体: `discord-claude-code-bot/`
- エントリポイント: `src/index.ts` → `src/claude-session.ts`
- クロン: `src/cron-runner.ts`
- ビルド: `npm run build`（tsc）、起動: `npm start` or `npm run dev`

### AIバックエンド
- **Vercel AI SDK** (`ai@6.0.97`) を使用（claude-agent-sdk は削除済み）
- OpenRouter経由: `OPENROUTER_API_KEY` を設定 → `openrouter.chat(model)` で Chat Completions API を使用
- Anthropic直接: `ANTHROPIC_API_KEY` を設定
- モデル指定: `.env` の `MODEL=` または `/claude-model` コマンドで変更可

### セッション管理
- `chatHistory: Map<string, ModelMessage[]>` でマルチターン会話を管理（メモリのみ、再起動でリセット）
- 永続化されるのは channelModels / workspaces / conversationHistory（RAG用）

### RAG（長期記憶）
- `workspace/memory/memory_*.md` にAI要約を保存
- `workspace/memory/.embeddings.json` にベクトルキャッシュ
- `EMBEDDING_API_KEY` あり → ベクトル検索、なし → キーワード検索にフォールバック

### ツール（workDir内のみ）
Bash / Read / Write / Edit / Glob / Grep を実装済み

### 既知の注意点
- `@ai-sdk/openai` v6 はデフォルトで `/v1/responses` を使うため、OpenRouter利用時は必ず `.chat()` を使うこと
- `stopWhen: stepCountIs(50)` が `maxSteps` の代替（AI SDK v6の仕様）

