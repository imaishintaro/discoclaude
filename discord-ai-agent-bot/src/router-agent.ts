/**
 * router-agent.ts
 *
 * ルーターエージェント: すべてのユーザー入力を最初に受け取る中心エージェント。
 * 友人キャラ「クロウ」として振る舞い、タスクを判定して専門チームに委譲する。
 *
 * 実装方式: Vercel AI SDK generateText() + stopWhen: stepCountIs(N)
 *
 * エクスポート: RouterAgent クラス
 */

import { generateText, tool, zodSchema, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";

import { buildModel } from "./utils/build-model";
import { SessionManager } from "./session-manager";
import { MemoryManager } from "./memory-manager";
import { createWebSearchTool } from "./tools/web-search";

// ========================================
// 定数
// ========================================

/** プロジェクトルート（dist/ からの相対パス） */
const BOT_ROOT = join(__dirname, "..");

// ========================================
// 型定義
// ========================================

/** agents.json のルーター部分の型 */
interface RouterConfig {
  name: string;
  emoji: string;
  personality: string;
  description: string;
}

/** models.json の型 */
interface ModelsConfig {
  default: string;
  options: Record<string, string>;
  task_defaults: Record<string, string>;
}

/** processMessage の戻り値 */
export interface RouterResult {
  response: string;
  delegatedTask?: {
    taskType: string;
    taskDescription: string;
  };
}

/** コンストラクタのオプション */
export interface RouterAgentOptions {
  defaultWorkDir?: string;
  onDelegateTask?: (
    taskType: string,
    taskDescription: string,
    channelId: string
  ) => Promise<string>;
}

// ========================================
// RouterAgent クラス
// ========================================

export class RouterAgent {
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager;
  private options: RouterAgentOptions;

  /** agents.json から読み込んだルーター設定 */
  private routerConfig: RouterConfig;
  /** models.json から読み込んだモデル設定 */
  private modelsConfig: ModelsConfig;
  /** router.txt のプレースホルダ置換済みテンプレート */
  private baseSystemPrompt: string;

  /**
   * @param sessionManager セッション管理インスタンス
   * @param memoryManager  メモリ管理インスタンス
   * @param options        オプション設定（タスク委譲コールバックなど）
   */
  constructor(
    sessionManager: SessionManager,
    memoryManager: MemoryManager,
    options?: RouterAgentOptions
  ) {
    this.sessionManager = sessionManager;
    this.memoryManager = memoryManager;
    this.options = options ?? {};

    // 設定ファイルを読み込み
    this.routerConfig = this.loadRouterConfig();
    this.modelsConfig = this.loadModelsConfig();
    this.baseSystemPrompt = this.loadAndBuildSystemPrompt();

    console.log(
      `[RouterAgent] 初期化完了: name=${this.routerConfig.name}, model=${this.resolveModelId()}`
    );
  }

  // ========================================
  // パブリックメソッド
  // ========================================

  /**
   * ユーザーのメッセージを処理して応答を返す
   *
   * 1. 長期メモリからコンテキストを構築
   * 2. generateText() でAIを呼び出し（ツール付き）
   * 3. 応答を返し、チャット履歴を更新
   *
   * @param channelId Discordチャンネル ID
   * @param prompt    ユーザーの入力メッセージ
   * @param workDir   作業ディレクトリ（未使用だが将来拡張用に受け取る）
   * @returns 応答テキストと、タスク委譲情報（あれば）
   */
  async processMessage(
    channelId: string,
    prompt: string,
    workDir: string
  ): Promise<RouterResult> {
    // タスク委譲情報を追跡するための変数
    let delegatedTask: RouterResult["delegatedTask"] | undefined;

    try {
      // --- システムプロンプトに長期メモリ情報を付加 ---
      const systemPrompt = this.buildFullSystemPrompt(channelId);

      // --- ユーザーメッセージをチャット履歴に追加 ---
      const userMessage: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: prompt }],
      };
      this.sessionManager.appendToHistory(channelId, [userMessage]);

      // --- AIモデルを構築 ---
      const model = this.buildModel();

      // --- ツールを定義 ---
      const tools = this.buildTools(channelId, (taskType, taskDescription) => {
        // delegateTask が呼ばれたらタスク情報を保存
        delegatedTask = { taskType, taskDescription };
      });

      // --- generateText 呼び出し ---
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: this.sessionManager.getChatHistory(channelId),
        tools,
        stopWhen: stepCountIs(10),
      });

      // --- デバッグ: ツール呼び出し状況をログ出力 ---
      const toolCalls = result.steps?.flatMap((s: any) => s.toolCalls || []) || [];
      console.log(
        `[RouterAgent] generateText完了: steps=${result.steps?.length || 0}, toolCalls=${toolCalls.length}`,
        toolCalls.length > 0
          ? toolCalls.map((tc: any) => tc.toolName || tc.type).join(", ")
          : "(なし)"
      );

      // --- 応答テキストを取得 ---
      const responseText =
        result.text || "すみません、うまく応答を生成できませんでした。";

      // --- アシスタントの応答をチャット履歴に追加 ---
      // result.response.messages には、アシスタントの応答とツール結果のメッセージが含まれる
      if (result.response?.messages && result.response.messages.length > 0) {
        this.sessionManager.appendToHistory(
          channelId,
          result.response.messages as ModelMessage[]
        );
      }

      // delegatedTask の状態をログ出力（デバッグ用）
      if (delegatedTask) {
        console.log(
          `[RouterAgent] delegateTaskツール呼び出し検出: type=${delegatedTask.taskType}`
        );
      } else {
        console.log("[RouterAgent] delegateTaskツールは呼ばれませんでした");
      }

      // ※ 実際のチーム起動は index.ts 側で行う（二重呼び出し防止）
      return {
        response: responseText,
        delegatedTask,
      };
    } catch (error: any) {
      console.error("[RouterAgent] processMessage エラー:", error);

      // APIエラーの種別に応じたフレンドリーなメッセージ
      const friendlyMessage = this.buildErrorMessage(error);

      return {
        response: friendlyMessage,
        delegatedTask,
      };
    }
  }

  // ========================================
  // 設定ファイル読み込み
  // ========================================

  /**
   * config/agents.json からルーター設定を読み込む
   */
  private loadRouterConfig(): RouterConfig {
    try {
      const agentsPath = join(BOT_ROOT, "config", "agents.json");
      const raw = readFileSync(agentsPath, "utf-8");
      const agents = JSON.parse(raw);
      return agents.router as RouterConfig;
    } catch (error) {
      console.error("[RouterAgent] agents.json の読み込みに失敗:", error);
      // フォールバック設定
      return {
        name: "クロウ",
        emoji: "\uD83D\uDC3E",
        personality: "カジュアルと丁寧の間。親しみやすいけど礼儀正しく",
        description: "Shintaroの専用AI秘書",
      };
    }
  }

  /**
   * config/models.json からモデル設定を読み込む
   */
  private loadModelsConfig(): ModelsConfig {
    try {
      const modelsPath = join(BOT_ROOT, "config", "models.json");
      const raw = readFileSync(modelsPath, "utf-8");
      return JSON.parse(raw) as ModelsConfig;
    } catch (error) {
      console.error("[RouterAgent] models.json の読み込みに失敗:", error);
      // フォールバック設定
      return {
        default: "anthropic/claude-sonnet-4-20250514",
        options: {
          balanced: "anthropic/claude-sonnet-4-20250514",
        },
        task_defaults: {
          router: "balanced",
        },
      };
    }
  }

  /**
   * config/prompts/router.txt を読み込み、プレースホルダを置換する
   *
   * プレースホルダ:
   *   {name}        → ルーター名（例: "クロウ"）
   *   {emoji}       → 絵文字（例: "🐾"）
   *   {personality} → 性格設定
   */
  private loadAndBuildSystemPrompt(): string {
    try {
      const promptPath = join(BOT_ROOT, "config", "prompts", "router.txt");
      let template = readFileSync(promptPath, "utf-8");

      // プレースホルダを置換
      template = template.replace(/\{name\}/g, this.routerConfig.name);
      template = template.replace(/\{emoji\}/g, this.routerConfig.emoji);
      template = template.replace(
        /\{personality\}/g,
        this.routerConfig.personality
      );

      return template;
    } catch (error) {
      console.error("[RouterAgent] router.txt の読み込みに失敗:", error);
      // フォールバック: 最低限のシステムプロンプト
      return `あなたは「${this.routerConfig.name}」です。${this.routerConfig.personality}。ユーザーのメッセージに対して親しみやすく応答してください。`;
    }
  }

  // ========================================
  // AIモデル構築
  // ========================================

  /**
   * models.json の task_defaults.router から実際のモデルIDを解決する
   *
   * @returns OpenRouterまたはAnthropicのモデルID文字列
   */
  private resolveModelId(): string {
    // task_defaults.router → options[key] でモデル名を解決
    const routerOptionKey =
      this.modelsConfig.task_defaults?.router || "balanced";
    const modelId =
      this.modelsConfig.options?.[routerOptionKey] ||
      this.modelsConfig.default ||
      "anthropic/claude-sonnet-4-20250514";

    return modelId;
  }

  /**
   * AIモデルインスタンスを構築する（共通ユーティリティに委譲）
   */
  private buildModel() {
    const modelId = this.resolveModelId();
    return buildModel(modelId);
  }

  // ========================================
  // ツール定義
  // ========================================

  /**
   * generateText に渡すツール群を構築する
   *
   * @param channelId          対象チャンネルID
   * @param onDelegateInternal delegateTask発火時の内部コールバック
   * @returns ツールオブジェクト
   */
  private buildTools(
    channelId: string,
    onDelegateInternal: (taskType: string, taskDescription: string) => void
  ) {
    // --- Web検索ツール ---
    const webSearchTools = createWebSearchTool();

    return {
      // Web検索: createWebSearchTool() が返すオブジェクトをスプレッド
      ...webSearchTools,

      // --- メモリ読み出しツール ---
      memoryRead: tool({
        description:
          "ユーザーに関する過去の記憶（好み・作業履歴・メモ）を検索する。" +
          "ユーザーの好みや過去の会話を思い出したいときに使う。",
        inputSchema: zodSchema(
          z.object({
            query: z.string().describe("検索キーワード（日本語OK）"),
          })
        ),
        execute: async (input: { query: string }) => {
          try {
            const result = this.memoryManager.searchMemories(
              channelId,
              input.query
            );
            return result;
          } catch (error: any) {
            console.error("[RouterAgent] memoryRead エラー:", error);
            return `メモリ検索に失敗しました: ${error.message}`;
          }
        },
      }),

      // --- メモリ書き込みツール ---
      memoryWrite: tool({
        description:
          "ユーザーに関する情報を長期メモリに保存する。" +
          "ユーザーの好み・重要な情報・作業結果を覚えておくために使う。",
        inputSchema: zodSchema(
          z.object({
            type: z
              .enum(["preference", "note", "work_history"])
              .describe(
                "保存する情報の種類: preference=好み, note=メモ, work_history=作業履歴"
              ),
            key: z
              .string()
              .optional()
              .describe("好みのキー（type=preferenceの場合に必要。例: 'coding_language'）"),
            value: z
              .string()
              .describe(
                "保存する値（preference: 好みの値, note: メモ内容, work_history: タスク名）"
              ),
            note: z
              .string()
              .optional()
              .describe("補足情報（work_historyの場合の成果・備考など）"),
          })
        ),
        execute: async (input: {
          type: "preference" | "note" | "work_history";
          key?: string;
          value: string;
          note?: string;
        }) => {
          try {
            switch (input.type) {
              case "preference": {
                // 好みの保存にはkeyが必要
                const key = input.key || "general";
                this.memoryManager.updatePreference(key, input.value);
                return `好みを記録しました: ${key} = ${input.value}`;
              }
              case "note": {
                this.memoryManager.addUserNote(input.value);
                return `メモを保存しました: ${input.value}`;
              }
              case "work_history": {
                this.memoryManager.addWorkHistory({
                  task: input.value,
                  date: new Date().toISOString().slice(0, 10),
                  outcome: input.note || "完了",
                  notes: input.note,
                });
                return `作業履歴を記録しました: ${input.value}`;
              }
              default:
                return "不明な情報タイプです。";
            }
          } catch (error: any) {
            console.error("[RouterAgent] memoryWrite エラー:", error);
            return `メモリ保存に失敗しました: ${error.message}`;
          }
        },
      }),

      // --- タスク委譲ツール ---
      delegateTask: tool({
        description:
          "専門チームにタスクを委譲する。" +
          "コーディング・PPT作成・レポート作成・画像加工など、" +
          "専門的な作業が必要な場合に使用する。",
        inputSchema: zodSchema(
          z.object({
            taskType: z
              .enum(["coding", "ppt", "report", "image"])
              .describe(
                "タスクの種類: coding=コーディング, ppt=スライド作成, report=レポート作成, image=画像加工"
              ),
            taskDescription: z
              .string()
              .describe("タスクの詳細な説明（専門チームに渡す内容）"),
          })
        ),
        execute: async (input: {
          taskType: "coding" | "ppt" | "report" | "image";
          taskDescription: string;
        }) => {
          // 内部コールバックでタスク情報を保存
          onDelegateInternal(input.taskType, input.taskDescription);

          // タスクタイプに応じた日本語ラベル
          const taskLabels: Record<string, string> = {
            coding: "コーディング",
            ppt: "スライド作成",
            report: "レポート作成",
            image: "画像加工",
          };

          const label = taskLabels[input.taskType] || input.taskType;

          console.log(
            `[RouterAgent] タスク委譲: type=${input.taskType}, desc=${input.taskDescription}`
          );

          return `${label}チームに作業を依頼しました。完了したらお知らせします。`;
        },
      }),
    };
  }

  // ========================================
  // システムプロンプト構築
  // ========================================

  /**
   * ベースのシステムプロンプトに長期メモリ情報を付加した完全版を構築する
   *
   * @param channelId チャンネルID（短期メモリ検索に使用）
   * @returns 完全なシステムプロンプト
   */
  private buildFullSystemPrompt(channelId: string): string {
    const parts: string[] = [this.baseSystemPrompt];

    try {
      // 長期メモリからユーザー情報を取得
      const longTermMemory = this.memoryManager.getLongTermMemory();

      // ユーザーの好みがあればプロンプトに付加
      const prefEntries = Object.entries(longTermMemory.preferences);
      if (prefEntries.length > 0) {
        parts.push("\n## ユーザーの好み（長期メモリ）");
        for (const [key, value] of prefEntries) {
          parts.push(`- ${key}: ${value}`);
        }
      }

      // 最近の作業履歴があればプロンプトに付加（直近5件）
      if (longTermMemory.work_history.length > 0) {
        const recentHistory = longTermMemory.work_history.slice(-5);
        parts.push("\n## 最近の作業履歴（長期メモリ）");
        for (const entry of recentHistory) {
          const notePart = entry.notes ? ` (${entry.notes})` : "";
          parts.push(`- [${entry.date}] ${entry.task} → ${entry.outcome}${notePart}`);
        }
      }

      // ユーザーノートがあればプロンプトに付加
      if (longTermMemory.user_notes.length > 0) {
        parts.push("\n## ユーザーノート（長期メモリ）");
        for (const note of longTermMemory.user_notes) {
          parts.push(`- ${note}`);
        }
      }

      // 短期メモリ（会話要約）があればプロンプトに付加（直近3件）
      const shortTermMemories = this.memoryManager.getShortTermMemories(
        channelId,
        3
      );
      if (shortTermMemories.length > 0) {
        parts.push("\n## 最近の会話要約（短期メモリ）");
        for (const mem of shortTermMemories) {
          parts.push(`- [${mem.created_at}] ${mem.summary}`);
        }
      }
    } catch (error) {
      console.error("[RouterAgent] メモリ情報取得エラー:", error);
      // メモリ取得に失敗してもベースプロンプトは使える
    }

    return parts.join("\n");
  }

  // ========================================
  // エラーハンドリング
  // ========================================

  /**
   * AI APIエラーをユーザーフレンドリーなメッセージに変換する
   *
   * @param error エラーオブジェクト
   * @returns ユーザー向けエラーメッセージ
   */
  private buildErrorMessage(error: any): string {
    const message = error?.message || String(error);

    // レートリミット
    if (message.includes("rate_limit") || message.includes("429")) {
      return "ごめん、APIのリクエスト制限にかかっちゃった。少し待ってからもう一度試してみて。";
    }

    // 認証エラー
    if (
      message.includes("401") ||
      message.includes("authentication") ||
      message.includes("invalid_api_key")
    ) {
      return "APIキーの認証に問題があるみたい。管理者に確認してもらえると助かる。";
    }

    // コンテキスト長超過
    if (
      message.includes("context_length") ||
      message.includes("max_tokens") ||
      message.includes("too long")
    ) {
      return "会話が長くなりすぎたみたい。`/clear` で履歴をリセットしてみて。";
    }

    // タイムアウト
    if (
      message.includes("timeout") ||
      message.includes("ETIMEDOUT") ||
      message.includes("ECONNRESET")
    ) {
      return "AIサービスとの接続がタイムアウトしました。もう一度試してみて。";
    }

    // サーバーエラー
    if (message.includes("500") || message.includes("503")) {
      return "AIサービス側でエラーが発生しているみたい。しばらく待ってから再試行してね。";
    }

    // その他の不明エラー
    return `エラーが発生しちゃった。もう一回試してみてくれる？\n(詳細: ${message.slice(0, 200)})`;
  }
}
