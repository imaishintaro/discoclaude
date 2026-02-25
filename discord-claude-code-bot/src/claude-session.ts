import { generateText, tool, zodSchema, stepCountIs, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "fs";
import { dirname, join, resolve } from "path";
import type { CodingAgentService } from "./multi-agent";

const exec = promisify(execCb);

// ボット本体のルートディレクトリ（identify.md / context.md の置き場所）
// dist/ の一つ上がプロジェクトルート
const BOT_ROOT = join(__dirname, "..");

/**
 * 進捗イベントの型定義
 * ストリーム中のツール実行状況やタスク進捗をDiscordに通知するために使う
 */
export type ProgressEvent = {
  type: "tool_progress";
  toolName: string;
  elapsedSeconds: number;
} | {
  type: "tool_summary";
  summary: string;
} | {
  type: "task_started";
  description: string;
} | {
  type: "task_completed";
  summary: string;
  status: "completed" | "failed" | "stopped";
} | {
  // Claudeのテキスト出力（考え中の内容）
  type: "assistant_text";
  text: string;
} | {
  // ツール呼び出し（名前と入力パラメータ）
  type: "tool_call";
  toolName: string;
  input: Record<string, unknown>;
} | {
  // ツール実行結果
  type: "tool_result";
  toolName: string;
  output: string;
  isError: boolean;
};

/**
 * 進捗コールバック関数の型
 */
export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * ワークスペース設定
 * Discordカテゴリとローカルディレクトリのマッピング
 */
export type WorkspaceConfig = {
  name: string;
  directory: string;
  categoryId: string;
};

/** 永続化するセッションデータの型 */
type PersistedData = {
  channelModels: Record<string, string>;
  workspaces: Record<string, WorkspaceConfig>;
  channelCategoryCache: Record<string, string | null>;
  // 会話履歴（タイムスタンプはISO文字列で保存）
  conversationHistory: Record<string, Array<{
    timestamp: string;
    userPrompt: string;
    assistantResponse: string;
  }>>;
  // チャット履歴（AI SDKのModelMessage[]をそのままJSON化して保存）
  chatHistory?: Record<string, ModelMessage[]>;
};

/**
 * チャンネルごとのClaude Codeセッションを管理するクラス
 * チャット履歴を保持し、会話の継続を可能にする
 * ワークスペース単位でのルーティングもサポート
 */
/** 会話の1ターン */
type ConversationTurn = {
  timestamp: Date;
  userPrompt: string;
  assistantResponse: string;
};

export class ClaudeSessionManager {
  // チャンネルID → チャット履歴のマップ（Vercel AI SDK用 ModelMessage[]）
  private chatHistory: Map<string, ModelMessage[]> = new Map();
  // チャンネルID → モデル名のマップ（チャンネルごとのモデル設定）
  private channelModels: Map<string, string> = new Map();
  // ワークスペース一覧（カテゴリID → ワークスペース設定）
  private workspaces: Map<string, WorkspaceConfig> = new Map();
  // チャンネルID → カテゴリID のキャッシュ（ルーティング高速化）
  private channelCategoryCache: Map<string, string | null> = new Map();
  // チャンネルID → 会話履歴（メモリ保存用）
  private conversationHistory: Map<string, ConversationTurn[]> = new Map();
  private defaultWorkDir: string;
  private defaultModel: string;
  // セッションデータの保存先ファイルパス
  private persistPath: string;
  // memory/ ディレクトリの変更を監視するウォッチャー
  private memoryWatcher: FSWatcher | null = null;
  // コーディングエージェント（マルチエージェント機能）
  private codingAgent: CodingAgentService | null = null;

  constructor(workDir: string, defaultModel: string) {
    this.defaultWorkDir = workDir;
    this.defaultModel = defaultModel;
    this.persistPath = join(workDir, ".sessions.json");
    this.load();
  }

  // ========================================
  // メモリ管理（RAG）
  // ========================================

  /** メモリファイルの保存ディレクトリ */
  private get memoryDir(): string {
    return join(this.defaultWorkDir, "memory");
  }

  /**
   * AIを使って会話テキストを要約する。
   * OpenRouter利用時はOpenRouter API、それ以外はAnthropic Messages APIを使用。
   * 失敗した場合は null を返す（呼び出し元が生データにフォールバック）。
   */
  private async summarizeWithAI(conversationText: string): Promise<string | null> {
    // summary_rule.md があればその内容を要約ルールとして使用する
    const summaryRulePath = join(BOT_ROOT, "summary_rule.md");
    const summaryRule = existsSync(summaryRulePath)
      ? readFileSync(summaryRulePath, "utf-8").trim()
      : null;

    const prompt = summaryRule
      ? `以下のルールに従って、会話履歴を要約してください。\n\n${summaryRule}\n\n---\n\n以下が会話履歴です:\n\n${conversationText}`
      : `以下の会話履歴を日本語で要約してください。\n重要な情報・決定事項・未解決の課題を保持しつつ簡潔にまとめてください。\n\n${conversationText}`;

    try {
      if (process.env.OPENROUTER_API_KEY) {
        // OpenRouter経由（.envのMODELをそのまま使用）
        const model = this.defaultModel;
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1024,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "(読み取れず)");
          console.error(`[メモリ] OpenRouter要約API失敗: HTTP ${res.status} — ${body}`);
          return null;
        }
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content || null;
      } else {
        // Anthropic Messages API（CLIセッショントークンまたはAPIキー）
        const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
        if (!token) {
          console.error("[メモリ] 要約失敗: APIキーが見つかりません");
          return null;
        }
        // Anthropic直接の場合はプレフィックス（anthropic/等）を除去
        const model = this.defaultModel.replace(/^[^/]+\//, "");
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": token,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "(読み取れず)");
          console.error(`[メモリ] Anthropic要約API失敗: HTTP ${res.status} — ${body}`);
          return null;
        }
        const data = await res.json() as any;
        return data.content?.[0]?.text || null;
      }
    } catch (err) {
      console.error("[メモリ] 要約中に例外:", err);
      return null;
    }
  }

  async saveMemory(channelId: string): Promise<string | null> {
    const history = this.conversationHistory.get(channelId);
    if (!history || history.length === 0) return null;

    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const filename = `memory_${now.getFullYear()}_${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.md`;
    const filePath = join(this.memoryDir, filename);

    // 会話テキストを構築
    const conversationText = history.map((t) =>
      `[${t.timestamp.toLocaleString("ja-JP")}]\nユーザー: ${t.userPrompt}\nアシスタント: ${t.assistantResponse}`
    ).join("\n\n---\n\n");

    // AI要約を生成
    console.log(`[メモリ] AI要約を生成中... (${history.length}ターン)`);
    const summary = await this.summarizeWithAI(conversationText);
    if (summary) {
      console.log("[メモリ] AI要約: 成功");
    } else {
      console.warn("[メモリ] AI要約: 失敗（生データで保存）");
    }

    // 要約成功時は要約のみ保存。失敗時のみ生の会話履歴をフォールバックとして保存。
    const lines = summary
      ? [
          `# 会話メモリ ${now.toLocaleString("ja-JP")}`,
          "",
          summary,
        ]
      : [
          `# 会話メモリ ${now.toLocaleString("ja-JP")}`,
          "",
          ...history.flatMap((turn) => [
            `### ${turn.timestamp.toLocaleString("ja-JP")}`,
            "",
            `**ユーザー**: ${turn.userPrompt}`,
            "",
            `**アシスタント**: ${turn.assistantResponse}`,
            "",
          ]),
        ];

    const fileContent = lines.join("\n");
    writeFileSync(filePath, fileContent, "utf-8");
    console.log(`[メモリ] 保存: ${filename} (${history.length}ターン, AI要約: ${summary ? "あり" : "なし"})`);

    // エンベディングを即時生成（非同期で実行、完了を待たない）
    void this.updateEmbeddingForFile(filename, fileContent);

    return filename;
  }

  // ========================================
  // ベクトル検索（RAG）
  // ========================================

  /** エンベディングキャッシュの保存先 */
  private get embeddingsPath(): string {
    return join(this.memoryDir, ".embeddings.json");
  }

  /** エンベディングキャッシュを読み込む */
  private loadEmbeddingsCache(): Record<string, { hash: string; vector: number[] }> {
    if (!existsSync(this.embeddingsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.embeddingsPath, "utf-8"));
    } catch {
      return {};
    }
  }

  /** エンベディングキャッシュを保存する */
  private saveEmbeddingsCache(cache: Record<string, { hash: string; vector: number[] }>): void {
    try {
      writeFileSync(this.embeddingsPath, JSON.stringify(cache), "utf-8");
    } catch {
      // キャッシュ保存失敗は無視（次回再計算するだけ）
    }
  }

  /** テキストのMD5ハッシュを計算する（キャッシュ無効化用） */
  private hashContent(content: string): string {
    return createHash("md5").update(content).digest("hex");
  }

  /**
   * テキストをベクトルに変換する（OpenAI互換 Embedding API）
   * EMBEDDING_API_KEY が未設定の場合は null を返す
   */
  private async embedText(text: string): Promise<number[] | null> {
    const apiKey = process.env.EMBEDDING_API_KEY;
    if (!apiKey) return null;

    const baseUrl = (process.env.EMBEDDING_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

    try {
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: text, model }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[RAG] Embedding API失敗: HTTP ${res.status} — ${body}`);
        return null;
      }
      const data = await res.json() as any;
      return data.data?.[0]?.embedding || null;
    } catch (err) {
      console.error("[RAG] Embedding API例外:", err);
      return null;
    }
  }

  /** コサイン類似度を計算する（-1〜1、高いほど類似） */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * ユーザーのクエリに関連するメモリファイルを検索して返す。
   * EMBEDDING_API_KEY が設定されていればベクトル検索、未設定ならキーワード検索にフォールバック。
   */
  private async searchMemories(query: string): Promise<string> {
    if (!existsSync(this.memoryDir)) return "";

    // memory_*.md のみ対象（CLAUDE.md 等は除外）
    const files = readdirSync(this.memoryDir)
      .filter((f) => /^memory_.*\.md$/.test(f))
      .sort()
      .reverse(); // 新しい順

    if (files.length === 0) return "";

    // ── ベクトル検索 ─────────────────────────────────────────
    const queryVector = await this.embedText(query.slice(0, 1000));

    if (queryVector) {
      const cache = this.loadEmbeddingsCache();
      let cacheUpdated = false;

      // 各メモリファイルのエンベディングを計算/キャッシュ更新
      for (const file of files) {
        const filePath = join(this.memoryDir, file);
        const content = readFileSync(filePath, "utf-8");
        const hash = this.hashContent(content);

        if (!cache[file] || cache[file].hash !== hash) {
          const vector = await this.embedText(content.slice(0, 4000));
          if (vector) {
            cache[file] = { hash, vector };
            cacheUpdated = true;
          }
        }
      }

      if (cacheUpdated) this.saveEmbeddingsCache(cache);

      // コサイン類似度でランキング（上位3件、閾値0.5以上）
      const MIN_SIMILARITY = 0.5;
      const scored = files
        .filter((f) => cache[f]?.vector)
        .map((file) => ({
          file,
          content: readFileSync(join(this.memoryDir, file), "utf-8"),
          similarity: this.cosineSimilarity(queryVector, cache[file].vector),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 3)
        .filter((f) => f.similarity >= MIN_SIMILARITY);

      if (scored.length === 0) return "";

      console.log(`[RAG] ベクトル検索: ${scored.length}件 (類似度: ${scored.map((f) => f.similarity.toFixed(2)).join(", ")})`);

      return [
        "<past_memories>",
        "以下は過去の会話から検索された関連メモリです:",
        ...scored.map((f) => `\n### ${f.file}\n${f.content}`),
        "</past_memories>",
      ].join("\n");
    }

    // ── キーワード検索（フォールバック） ──────────────────────
    const keywords = query
      .toLowerCase()
      .split(/[\s、。！？,.!?\n]+/)
      .filter((w) => w.length >= 2);

    if (keywords.length === 0) return "";

    const scored = files.map((file) => {
      const content = readFileSync(join(this.memoryDir, file), "utf-8");
      const lower = content.toLowerCase();
      const score = keywords.filter((k) => lower.includes(k)).length;
      return { file, content, score };
    });

    const relevant = scored
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (relevant.length === 0) return "";

    console.log(`[RAG] キーワード検索: ${relevant.length}件 (${relevant.map((f) => f.file).join(", ")})`);

    return [
      "<past_memories>",
      "以下は過去の会話から検索された関連メモリです:",
      ...relevant.map((f) => `\n### ${f.file}\n${f.content}`),
      "</past_memories>",
    ].join("\n");
  }

  /**
   * 指定したメモリファイルのエンベディングを計算してキャッシュに保存する。
   * EMBEDDING_API_KEY が未設定の場合は何もしない。
   * ハッシュが変わっていない場合は再計算をスキップする。
   */
  private async updateEmbeddingForFile(filename: string, content: string): Promise<void> {
    if (!process.env.EMBEDDING_API_KEY) return;

    const cache = this.loadEmbeddingsCache();
    const hash = this.hashContent(content);

    // ハッシュが一致していれば変更なし → スキップ
    if (cache[filename]?.hash === hash) return;

    const vector = await this.embedText(content.slice(0, 4000));
    if (!vector) return;

    cache[filename] = { hash, vector };
    this.saveEmbeddingsCache(cache);
    console.log(`[RAG] エンベディング更新: ${filename}`);
  }

  /**
   * memory/ ディレクトリを監視し、memory_*.md ファイルが変更されたら
   * エンベディングを自動更新する。
   * EMBEDDING_API_KEY が未設定の場合は起動しない。
   * 既に起動済みの場合は何もしない。
   */
  /**
   * コーディングエージェントを設定する（マルチエージェント機能の有効化）
   */
  setCodingAgent(agent: CodingAgentService): void {
    this.codingAgent = agent;
  }

  startMemoryWatcher(): void {
    if (!process.env.EMBEDDING_API_KEY) return;
    if (this.memoryWatcher) return;

    // ディレクトリが存在しない場合は作成してから監視
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }

    // ファイルごとのデバウンスタイマー（連続変更イベントをまとめる）
    const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

    this.memoryWatcher = watch(this.memoryDir, (_, filename) => {
      if (!filename || !/^memory_.*\.md$/.test(filename)) return;

      // 500ms デバウンス
      const existing = debounceMap.get(filename);
      if (existing) clearTimeout(existing);

      debounceMap.set(filename, setTimeout(async () => {
        debounceMap.delete(filename);

        const filePath = join(this.memoryDir, filename);
        if (!existsSync(filePath)) return; // 削除された場合は無視

        try {
          const content = readFileSync(filePath, "utf-8");
          await this.updateEmbeddingForFile(filename, content);
        } catch (err) {
          console.error(`[RAG] ファイル監視エラー (${filename}):`, err);
        }
      }, 500));
    });

    console.log(`[RAG] メモリディレクトリを監視中: ${this.memoryDir}`);
  }

  /**
   * セッションデータをファイルから読み込む
   * chatHistory も永続化対象（再起動後も会話を継続可能）
   */
  private load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const data: PersistedData = JSON.parse(raw);
      this.channelModels = new Map(Object.entries(data.channelModels || {}));
      this.workspaces = new Map(Object.entries(data.workspaces || {}));
      this.channelCategoryCache = new Map(Object.entries(data.channelCategoryCache || {}));
      // 会話履歴を復元（タイムスタンプをDateに変換）
      for (const [channelId, turns] of Object.entries(data.conversationHistory || {})) {
        this.conversationHistory.set(
          channelId,
          turns.map((t) => ({ ...t, timestamp: new Date(t.timestamp) }))
        );
      }
      // チャット履歴を復元（AI SDK ModelMessage[]）
      if (data.chatHistory) {
        for (const [channelId, messages] of Object.entries(data.chatHistory)) {
          if (messages && messages.length > 0) {
            this.chatHistory.set(channelId, messages);
          }
        }
        console.log(`セッションデータを読み込みました（チャット${this.chatHistory.size}ch, 履歴${this.conversationHistory.size}ch）`);
      } else {
        console.log(`セッションデータを読み込みました（履歴${this.conversationHistory.size}チャンネル）`);
      }
    } catch {
      console.error("セッションデータの読み込みに失敗しました（新規作成します）");
    }
  }

  /**
   * セッションデータをファイルに保存する
   * chatHistory も永続化し、再起動後も会話を継続可能にする
   */
  private save(): void {
    try {
      // chatHistory は直近40メッセージのみ保存（ファイルサイズ抑制）
      const MAX_PERSISTED_MESSAGES = 40;
      const chatHistoryToSave: Record<string, ModelMessage[]> = {};
      for (const [channelId, messages] of this.chatHistory.entries()) {
        if (messages.length > 0) {
          chatHistoryToSave[channelId] = messages.slice(-MAX_PERSISTED_MESSAGES);
        }
      }

      const data: PersistedData = {
        channelModels: Object.fromEntries(this.channelModels),
        workspaces: Object.fromEntries(this.workspaces),
        channelCategoryCache: Object.fromEntries(this.channelCategoryCache),
        // 会話履歴（タイムスタンプをISO文字列に変換して保存）
        conversationHistory: Object.fromEntries(
          Array.from(this.conversationHistory.entries()).map(([k, v]) => [
            k,
            v.map((t) => ({ ...t, timestamp: t.timestamp.toISOString() })),
          ])
        ),
        chatHistory: chatHistoryToSave,
      };
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      console.error("セッションデータの保存に失敗しました");
    }
  }

  /**
   * 追加システムプロンプトを取得する
   * system.md（性格・口調）と context.md（プロジェクト情報）を結合して返す
   * どちらも任意。なければ環境変数 SYSTEM_PROMPT にフォールバック
   */
  private getExtraSystemPrompt(): string {
    const parts: string[] = [];

    // ボットのルートから読み込む（WORKDIRのworkspaceフォルダとは別）
    const files: { path: string; label: string }[] = [
      { path: join(BOT_ROOT, "identify.md"), label: "性格・口調" },
      { path: join(BOT_ROOT, "context.md"), label: "プロジェクト情報" },
    ];

    for (const { path, label } of files) {
      if (existsSync(path)) {
        try {
          const content = readFileSync(path, "utf-8").trim();
          if (content) {
            parts.push(content);
            console.log(`[システムプロンプト] ${label}: ${path}`);
          }
        } catch {
          console.error(`${path} の読み込みに失敗しました`);
        }
      }
    }

    if (parts.length > 0) return parts.join("\n\n---\n\n");

    return process.env.SYSTEM_PROMPT || "";
  }

  // ========================================
  // モデル選択
  // ========================================

  /**
   * チャンネルに対応するAIモデルを構築する。
   * OPENROUTER_API_KEY が設定されていれば OpenRouter 経由（どのモデルでも使用可）、
   * そうでなければ Anthropic 直接（ANTHROPIC_API_KEY が必要）。
   */
  private buildModel(channelId: string) {
    const rawModel = this.channelModels.get(channelId) || this.defaultModel;
    if (process.env.OPENROUTER_API_KEY) {
      // OpenRouter経由: Chat Completions API を使用（Responses APIは未サポート）
      // openrouter(model) はデフォルトで Responses API (/v1/responses) を叩くため、
      // openrouter.chat(model) で明示的に /v1/chat/completions を使う
      const openrouter = createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      });
      return openrouter.chat(rawModel);
    } else {
      // Anthropic直接: プレフィックス（anthropic/ 等）を除去してモデルIDを渡す
      const modelId = rawModel.replace(/^[^/]+\//, "");
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "",
      });
      return anthropic(modelId);
    }
  }

  // ========================================
  // ツール定義（workDir 内のみアクセス可）
  // ========================================

  /**
   * Vercel AI SDK 用のツール一覧を構築する。
   * すべてのファイルアクセスは workDir 内に制限される。
   * onProgress が渡された場合、ConsultCodingAgent でユーザーへの進捗通知を行う。
   */
  private buildTools(workDir: string, channelId: string, onProgress?: ProgressCallback) {
    // パスが workDir 内であることを確認し、絶対パスを返す
    const checkPath = (p: string): string => {
      const abs = resolve(workDir, p);
      const workDirWithSep = workDir.endsWith("/") ? workDir : workDir + "/";
      if (abs !== workDir && !abs.startsWith(workDirWithSep)) {
        throw new Error(`アクセス拒否: ワークスペース外のパスです (${p})`);
      }
      return abs;
    };

    return {
      Bash: tool({
        description: "ワークスペースディレクトリでbashコマンドを実行する（ワークスペース外へのアクセスは禁止）",
        inputSchema: zodSchema(z.object({
          command: z.string().describe("実行するbashコマンド"),
        })),
        execute: async (input: { command: string }) => {
          // 危険なコマンドをブロック
          const blockedPatterns = [
            /\bsudo\b/,             // 権限昇格
            /\bsu\b/,               // ユーザー切り替え
            /\bchmod\b/,            // パーミッション変更
            /\bchown\b/,            // オーナー変更
            /\brm\s+(-[^\s]*)?-rf?\s+\//, // rm -rf / 等ルートへの削除
            /\brm\s+(-[^\s]*)?-rf?\s+~/, // rm -rf ~ ホームディレクトリ削除
            /\bshutdown\b/,         // シャットダウン
            /\breboot\b/,           // 再起動
            /\bmkfs\b/,             // フォーマット
            /\bdd\b\s/,             // ディスク書き込み
            />\s*\/(?!dev\/null)/,  // ルート直下への書き込みリダイレクト
            /\bcurl\b.*\|\s*\bbash\b/, // curl | bash パイプ実行
            /\bwget\b.*\|\s*\bbash\b/, // wget | bash パイプ実行
          ];
          for (const pattern of blockedPatterns) {
            if (pattern.test(input.command)) {
              return `Error: セキュリティ上の理由でこのコマンドは実行できません: ${input.command}`;
            }
          }

          // ワークスペース外へのcdを防ぐため、コマンドをラップ
          // cdを使ってもワークスペース外に出られないようにする
          const wrappedCommand = `cd "${workDir}" && (${input.command}) 2>&1`;
          try {
            const result = await exec(wrappedCommand, {
              cwd: workDir,
              timeout: 30000,
              env: { ...process.env, HOME: workDir }, // HOMEをワークスペースに限定
            });
            const stdout = String(result.stdout || "");
            return stdout.slice(0, 10000) || "(出力なし)";
          } catch (err: any) {
            const stdout = err.stdout ? String(err.stdout) : "";
            const stderr = err.stderr ? String(err.stderr) : "";
            const parts = [err.message, stdout && `STDOUT: ${stdout}`, stderr && `STDERR: ${stderr}`]
              .filter(Boolean).join("\n");
            return parts.slice(0, 5000);
          }
        },
      }),

      Read: tool({
        description: "ワークスペース内のファイルを読み込む",
        inputSchema: zodSchema(z.object({
          file_path: z.string().describe("読み込むファイルのパス"),
        })),
        execute: async (input: { file_path: string }) => {
          try {
            const abs = checkPath(input.file_path);
            return readFileSync(abs, "utf-8").slice(0, 50000);
          } catch (err: any) {
            return `Error: ${err.message}`;
          }
        },
      }),

      Write: tool({
        description: "ワークスペース内のファイルに内容を書き込む",
        inputSchema: zodSchema(z.object({
          file_path: z.string().describe("書き込むファイルのパス"),
          content: z.string().describe("書き込む内容"),
        })),
        execute: async (input: { file_path: string; content: string }) => {
          try {
            const abs = checkPath(input.file_path);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, input.content, "utf-8");
            return `${input.file_path} に ${input.content.length} 文字を書き込みました`;
          } catch (err: any) {
            return `Error: ${err.message}`;
          }
        },
      }),

      Edit: tool({
        description: "ファイル内の文字列を置換して編集する",
        inputSchema: zodSchema(z.object({
          file_path: z.string().describe("編集するファイルのパス"),
          old_string: z.string().describe("置換前の文字列"),
          new_string: z.string().describe("置換後の文字列"),
        })),
        execute: async (input: { file_path: string; old_string: string; new_string: string }) => {
          try {
            const abs = checkPath(input.file_path);
            const content = readFileSync(abs, "utf-8");
            if (!content.includes(input.old_string)) {
              return `Error: 指定した文字列が ${input.file_path} 内に見つかりませんでした`;
            }
            writeFileSync(abs, content.replace(input.old_string, input.new_string), "utf-8");
            return `${input.file_path} を編集しました`;
          } catch (err: any) {
            return `Error: ${err.message}`;
          }
        },
      }),

      Glob: tool({
        description: "ワークスペース内でファイルをパターン検索する",
        inputSchema: zodSchema(z.object({
          pattern: z.string().describe("検索パターン（例: *.ts, src/**/*.js）"),
          path: z.string().optional().describe("検索するディレクトリ（省略時はワークスペースルート）"),
        })),
        execute: async (input: { pattern: string; path?: string }) => {
          try {
            const searchDir = input.path ? checkPath(input.path) : workDir;
            // glob パターンのファイル名部分を抽出して find コマンドに渡す
            const namePattern = input.pattern.replace(/.*\//, "") || input.pattern;
            const result = await exec(
              `find ${JSON.stringify(searchDir)} -name ${JSON.stringify(namePattern)} -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -100`,
              { timeout: 10000 }
            );
            return String(result.stdout).trim() || "ファイルが見つかりませんでした";
          } catch (err: any) {
            return `Error: ${err.message}`;
          }
        },
      }),

      Grep: tool({
        description: "ワークスペース内でテキストを検索する",
        inputSchema: zodSchema(z.object({
          pattern: z.string().describe("検索パターン（正規表現可）"),
          path: z.string().optional().describe("検索するファイルまたはディレクトリ（省略時はワークスペースルート）"),
        })),
        execute: async (input: { pattern: string; path?: string }) => {
          try {
            const target = input.path ? checkPath(input.path) : workDir;
            const result = await exec(
              `grep -rn ${JSON.stringify(input.pattern)} ${JSON.stringify(target)} --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -100`,
              { cwd: workDir, timeout: 10000 }
            );
            return String(result.stdout).trim() || "マッチしませんでした";
          } catch (err: any) {
            // grep はマッチなしでも exit code 1 を返す
            if (err.code === 1) return "マッチしませんでした";
            return `Error: ${err.message}`;
          }
        },
      }),

      WebSearch: tool({
        description: "ウェブ検索を実行して最新情報を取得する（SearXNG経由）。技術的な質問、最新ニュース、ドキュメント検索などに使用する",
        inputSchema: zodSchema(z.object({
          query: z.string().describe("検索クエリ"),
          num_results: z.number().optional().describe("取得する結果数（デフォルト: 5、最大: 20）"),
        })),
        execute: async (input: { query: string; num_results?: number }) => {
          const searxngUrl = process.env.SEARXNG_URL || "http://localhost:8080";
          const numResults = Math.min(input.num_results || 5, 20);

          try {
            const params = new URLSearchParams({
              q: input.query,
              format: "json",
            });
            const res = await fetch(`${searxngUrl}/search?${params}`, {
              signal: AbortSignal.timeout(15000),
            });

            if (!res.ok) {
              return `Error: SearXNG API エラー (HTTP ${res.status})`;
            }

            const data = await res.json() as any;
            const results = (data.results || []).slice(0, numResults);

            if (results.length === 0) {
              return `「${input.query}」に対する検索結果が見つかりませんでした`;
            }

            // 検索結果を整形して返す
            const formatted = results.map((r: any, i: number) => {
              const lines = [`[${i + 1}] ${r.title || "(タイトルなし)"}`];
              lines.push(`    URL: ${r.url}`);
              if (r.content) {
                lines.push(`    ${r.content.slice(0, 200)}`);
              }
              return lines.join("\n");
            }).join("\n\n");

            return `「${input.query}」の検索結果（${results.length}件）:\n\n${formatted}`;
          } catch (err: any) {
            if (err.name === "TimeoutError") {
              return "Error: 検索がタイムアウトしました（15秒超過）";
            }
            return `Error: ウェブ検索に失敗しました: ${err.message}`;
          }
        },
      }),

      // コーディングエージェントへの相談ツール（マルチエージェント）
      ...(this.codingAgent ? {
        ConsultCodingAgent: tool({
          description: [
            "コーディング専門のAIエージェントに相談する。プログラムの作成・修正・デバッグが必要な場合に使用する。",
            "コーディングエージェントはワークスペース内でファイルの作成・編集・コマンド実行が可能。",
            "仕様提案→実装→内部レビューの3フェーズで自動実行される。",
            "結果を確認し、問題があればfeedback付きで再呼び出しすること。",
            "feedback指定時は仕様提案をスキップして修正を直接実行する。",
          ].join(""),
          inputSchema: zodSchema(z.object({
            task: z.string().describe("コーディングエージェントへの依頼内容（何を作るか、要件、制約など）"),
            feedback: z.string().optional().describe("前回の結果に対する修正依頼（例: 「エラー処理を追加して」「XをYに変更して」）。指定すると仕様提案をスキップして修正モードで実行される"),
          })),
          execute: async (input: { task: string; feedback?: string }) => {
            if (!this.codingAgent) return "Error: コーディングエージェントが設定されていません";

            // ユーザーに「コーディングエージェントに相談中」と通知
            if (onProgress) {
              onProgress({ type: "tool_progress", toolName: "ConsultCodingAgent", elapsedSeconds: 0 });
            }

            // コーディングエージェントの進捗をユーザーチャンネルに中継するコールバック
            const progressCb = onProgress ? (msg: string) => {
              onProgress({ type: "tool_summary", summary: msg });
            } : undefined;

            // feedback が指定されていればフィードバックモードで実行
            const consultOptions = input.feedback ? { feedback: input.feedback } : undefined;

            return await this.codingAgent.consult(input.task, workDir, channelId, progressCb, consultOptions);
          },
        }),
      } : {}),
    };
  }

  // ========================================
  // ワークスペース管理
  // ========================================

  /**
   * ワークスペースを登録する
   */
  addWorkspace(config: WorkspaceConfig): void {
    this.workspaces.set(config.categoryId, config);
    this.save();
  }

  /**
   * ワークスペースを削除する
   */
  removeWorkspace(categoryId: string): boolean {
    const result = this.workspaces.delete(categoryId);
    this.save();
    return result;
  }

  /**
   * 全ワークスペースを取得する
   */
  getWorkspaces(): WorkspaceConfig[] {
    return Array.from(this.workspaces.values());
  }

  /**
   * カテゴリIDからワークスペースを取得する
   */
  getWorkspaceByCategoryId(categoryId: string): WorkspaceConfig | undefined {
    return this.workspaces.get(categoryId);
  }

  /**
   * チャンネルの親カテゴリIDを設定する（Discordから取得した情報をキャッシュ）
   */
  setChannelCategory(channelId: string, categoryId: string | null): void {
    this.channelCategoryCache.set(channelId, categoryId);
    this.save();
  }

  /**
   * チャンネルに対応する作業ディレクトリを解決する
   * 1. チャンネルの親カテゴリにワークスペースが紐付いていればそのディレクトリ
   * 2. なければデフォルトの作業ディレクトリ
   */
  resolveWorkDir(channelId: string): string {
    const categoryId = this.channelCategoryCache.get(channelId);
    if (categoryId) {
      const workspace = this.workspaces.get(categoryId);
      if (workspace) {
        return workspace.directory;
      }
    }
    return this.defaultWorkDir;
  }

  /**
   * チャンネルに対応するワークスペース名を取得する（表示用）
   */
  resolveWorkspaceName(channelId: string): string | null {
    const categoryId = this.channelCategoryCache.get(channelId);
    if (categoryId) {
      const workspace = this.workspaces.get(categoryId);
      if (workspace) {
        return workspace.name;
      }
    }
    return null;
  }

  // ========================================
  // セッション管理
  // ========================================

  /**
   * Vercel AI SDK を使ってプロンプトを送信し、結果を返す。
   * チャット履歴を保持して会話を継続する。
   * onProgress コールバックでリアルタイム進捗を通知する。
   */
  async sendPrompt(
    channelId: string,
    prompt: string,
    onProgress?: ProgressCallback
  ): Promise<{ result: string; costUsd: number }> {
    // チャンネルに対応する作業ディレクトリを解決
    const workDir = this.resolveWorkDir(channelId);

    // システムプロンプト構築
    const extraPrompt = this.getExtraSystemPrompt();
    const workspaceBoundary =
      `\n\n<workspace_restriction>\n` +
      `You MUST only access files and directories inside: ${workDir}\n` +
      `NEVER access paths outside this directory using ../ or absolute paths pointing elsewhere.\n` +
      `</workspace_restriction>`;
    const responseConstraint =
      "<reply_constraint>\n" +
      "このDiscordボットは1メッセージにつき1回しか返信できません。\n" +
      "「確認するね」「調べるね」などの確認後の結果も、必ず同じ返信の中に含めてください。\n" +
      "宣言だけして終わるのではなく、宣言＋結果を1つの返信にまとめること。\n" +
      "</reply_constraint>";

    const system = [
      "<system_instructions>",
      ...(extraPrompt ? [extraPrompt] : []),
      workspaceBoundary,
      responseConstraint,
      "</system_instructions>",
    ].join("\n");

    // RAG: 過去のメモリから関連情報を検索
    const ragContext = await this.searchMemories(prompt);

    // チャット履歴取得（メモリのみ、再起動でリセット）
    const messages: ModelMessage[] = [...(this.chatHistory.get(channelId) || [])];

    // ユーザーメッセージ（RAGコンテキストを先頭に付加）
    const userContent = ragContext ? `${ragContext}\n\n${prompt}` : prompt;
    messages.push({ role: "user", content: userContent });

    // コンテキストサイズをコンソールに出力
    const ragChars = ragContext ? ragContext.length : 0;
    console.log(
      `[Context] プロンプト: ${prompt.length.toLocaleString()}文字` +
      (ragChars > 0 ? ` (RAG: ${ragChars.toLocaleString()}文字含む)` : "") +
      (messages.length > 1 ? ` | 継続中 (${messages.length - 1}メッセージ)` : " | 新規会話")
    );

    let resultText = "";

    try {
      const result = await generateText({
        model: this.buildModel(channelId),
        system,
        messages,
        tools: this.buildTools(workDir, channelId, onProgress),
        // maxSteps: 50 は AI SDK v6 では stopWhen で指定する
        stopWhen: stepCountIs(50),
        onStepFinish: ({ text, toolCalls, toolResults }) => {
          if (!onProgress) return;

          // アシスタントのテキスト出力
          if (text) {
            onProgress({ type: "assistant_text", text });
          }

          // ツール呼び出し（名前と入力パラメータ）
          if (toolCalls) {
            for (const tc of toolCalls) {
              if (!tc) continue;
              onProgress({
                type: "tool_call",
                toolName: tc.toolName,
                input: ((tc as any).input ?? (tc as any).args ?? {}) as Record<string, unknown>,
              });
            }
          }

          // ツール実行結果
          if (toolResults) {
            for (const tr of toolResults) {
              if (!tr) continue;
              const rawOutput = (tr as any).output;
              const output = typeof rawOutput === "string"
                ? rawOutput
                : JSON.stringify(rawOutput ?? "");
              onProgress({
                type: "tool_result",
                toolName: tr.toolName,
                output: output.slice(0, 500),
                isError: false,
              });
            }
          }
        },
      });

      resultText = result.text || "";

      // チャット履歴を更新（ツール呼び出しを含む全メッセージ）
      const updatedHistory = [...messages, ...result.response.messages];
      this.chatHistory.set(channelId, updatedHistory);

      // RAG用 conversationHistory を更新
      const history = this.conversationHistory.get(channelId) || [];
      history.push({
        timestamp: new Date(),
        userPrompt: prompt,
        assistantResponse: resultText,
      });
      this.conversationHistory.set(channelId, history);

      // コンテキスト長上限チェック（80メッセージ超でメモリ保存してトリム）
      if (updatedHistory.length > 80) {
        console.log(`[コンテキスト] メッセージ数が上限超過 (${updatedHistory.length})。メモリを保存してトリムします...`);
        const savedFile = await this.saveMemory(channelId);
        if (savedFile) {
          console.log(`[コンテキスト] 保存完了: ${savedFile}`);
        }
        // 直近20件に削減
        this.chatHistory.set(channelId, updatedHistory.slice(-20));
        this.conversationHistory.set(
          channelId,
          (this.conversationHistory.get(channelId) || []).slice(-10)
        );
      }

    } catch (err: any) {
      console.error("[sendPrompt] エラー:", err);
      resultText = `エラーが発生しました: ${err.message || String(err)}`;

      // コンテキスト上限エラーの場合はセッションをリセット
      if (err.message && (err.message.includes("context") || err.message.includes("tokens"))) {
        const savedFile = await this.saveMemory(channelId);
        this.chatHistory.delete(channelId);
        this.conversationHistory.delete(channelId);
        const memoryNote = savedFile ? `\n💾 会話履歴を \`${savedFile}\` に保存しました。` : "";
        resultText =
          `⚠️ 会話が長くなりすぎてコンテキスト上限に達しました。\n` +
          `セッションをリセットしました。もう一度質問してください。${memoryNote}`;
      }
    }

    // 設定データ（モデル・ワークスペース・会話履歴）を永続化
    this.save();

    // costUsd は Vercel AI SDK では計算されないため 0 を返す
    return { result: resultText, costUsd: 0 };
  }

  /**
   * チャンネルのセッションをクリアする
   * 会話履歴があればメモリに保存してから削除する
   */
  async clearSession(channelId: string): Promise<{ cleared: boolean; savedFile: string | null }> {
    const savedFile = await this.saveMemory(channelId);
    const cleared = (this.chatHistory.get(channelId)?.length ?? 0) > 0;
    this.chatHistory.delete(channelId);
    this.conversationHistory.delete(channelId);
    this.save();
    return { cleared, savedFile };
  }

  /**
   * チャット履歴にシステム通知を追加する（AIへの情報共有用）
   * !コマンドの実行結果などをAIに伝えるために使用する
   */
  addSystemNotice(channelId: string, text: string): void {
    const messages: ModelMessage[] = this.chatHistory.get(channelId) || [];
    // ユーザーからの通知としてchatHistoryに追加し、AIが次の応答時に認識できるようにする
    messages.push({ role: "user", content: `[システム通知] ${text}` });
    messages.push({ role: "assistant", content: "了解しました。" });
    this.chatHistory.set(channelId, messages);
  }

  /**
   * チャンネルのモデルを変更する
   * チャット履歴はそのまま継続（コンテキストを維持しつつモデルだけ切り替え）
   */
  setModel(channelId: string, model: string): void {
    this.channelModels.set(channelId, model);
    this.save();
  }

  /**
   * チャンネルで使用中のモデル名を取得する
   */
  getModel(channelId: string): string {
    return this.channelModels.get(channelId) || this.defaultModel;
  }

  /**
   * 全セッションをクリアする
   */
  clearAllSessions(): void {
    this.chatHistory.clear();
    this.channelModels.clear();
  }

  /**
   * チャンネルにアクティブなセッションがあるか確認
   */
  hasSession(channelId: string): boolean {
    return (this.chatHistory.get(channelId)?.length ?? 0) > 0;
  }
}
