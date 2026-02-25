import { generateText, tool, zodSchema, stepCountIs, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { Client, EmbedBuilder, type TextChannel } from "discord.js";

const exec = promisify(execCb);

// Embed配色
const EMBED_COLORS = {
  request: 0x607d8b,   // 青灰色: クロウ→コーダー（依頼）
  spec: 0x9b59b6,      // 紫: コーダーの仕様提案
  progress: 0xf59e0b,  // 黄色: コーダーのツール実行中
  complete: 0x2ecc71,  // 緑: コーダーの最終回答
  review: 0x3498db,    // 青: レビュー結果
  feedback: 0xe67e22,  // オレンジ: クロウからの修正依頼
} as const;

// Embedのdescription文字数上限
const EMBED_MAX_LENGTH = 4000;

/**
 * コーディング専門エージェントサービス
 * クロウ（汎用エージェント）から呼び出され、ワークスペース内でコードを書く。
 * やり取りは #agent-chat チャンネルにリアルタイム投稿される。
 */
export class CodingAgentService {
  constructor(
    private defaultModel: string,
    private discordClient: Client,
    private agentChatChannelId: string
  ) {}

  /**
   * AIモデルを構築する
   * CODING_AGENT_MODEL 環境変数が設定されていればそれを優先、なければデフォルトモデルを使用
   */
  private buildModel() {
    // コーディングエージェント専用モデル（環境変数で上書き可能）
    const model = process.env.CODING_AGENT_MODEL || this.defaultModel;

    if (process.env.OPENROUTER_API_KEY) {
      const openrouter = createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      });
      return openrouter.chat(model);
    } else {
      const modelId = model.replace(/^[^/]+\//, "");
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "",
      });
      return anthropic(modelId);
    }
  }

  /**
   * #agent-chat チャンネルを取得する
   */
  private async getAgentChatChannel(): Promise<TextChannel | null> {
    try {
      const channel = await this.discordClient.channels.fetch(this.agentChatChannelId);
      if (channel && "send" in channel) {
        return channel as TextChannel;
      }
      return null;
    } catch (err) {
      console.error("[MultiAgent] #agent-chat チャンネルの取得に失敗:", err);
      return null;
    }
  }

  /**
   * コーディングエージェント用のツールを構築する
   * workDir 内のみアクセス可能
   */
  private buildCodingTools(workDir: string) {
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
        description: "ワークスペースディレクトリでbashコマンドを実行する",
        inputSchema: zodSchema(z.object({
          command: z.string().describe("実行するbashコマンド"),
        })),
        execute: async (input: { command: string }) => {
          // 危険なコマンドをブロック
          const blockedPatterns = [
            /\bsudo\b/, /\bsu\b/, /\bchmod\b/, /\bchown\b/,
            /\brm\s+(-[^\s]*)?-rf?\s+\//, /\brm\s+(-[^\s]*)?-rf?\s+~/,
            /\bshutdown\b/, /\breboot\b/, /\bmkfs\b/, /\bdd\b\s/,
            />\s*\/(?!dev\/null)/,
            /\bcurl\b.*\|\s*\bbash\b/, /\bwget\b.*\|\s*\bbash\b/,
          ];
          for (const pattern of blockedPatterns) {
            if (pattern.test(input.command)) {
              return `Error: セキュリティ上の理由でこのコマンドは実行できません: ${input.command}`;
            }
          }

          const wrappedCommand = `cd "${workDir}" && (${input.command}) 2>&1`;
          try {
            const result = await exec(wrappedCommand, {
              cwd: workDir,
              timeout: 30000,
              env: { ...process.env, HOME: workDir },
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
            if (err.code === 1) return "マッチしませんでした";
            return `Error: ${err.message}`;
          }
        },
      }),
    };
  }

  /**
   * ツール入力パラメータを簡潔な文字列に変換する（Embed表示用）
   */
  private formatToolInput(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Bash": return String(input.command || "").slice(0, 80);
      case "Read": return String(input.file_path || "");
      case "Write": return String(input.file_path || "");
      case "Edit": return String(input.file_path || "");
      case "Glob": return String(input.pattern || "");
      case "Grep": return `"${String(input.pattern || "")}"`;
      default: return JSON.stringify(input).slice(0, 80);
    }
  }

  /**
   * 進捗ログを #agent-chat のEmbedに投稿/更新する（レート制限対策付き）
   */
  private async updateProgressEmbed(
    agentChat: TextChannel | null,
    progressLines: string[],
    progressMessageRef: { current: any },
    lastEmbedUpdateRef: { current: number },
    embedUpdateInterval: number
  ): Promise<void> {
    if (!agentChat || progressLines.length === 0) return;

    const now = Date.now();
    if (now - lastEmbedUpdateRef.current < embedUpdateInterval) return;
    lastEmbedUpdateRef.current = now;

    // 表示する行を上限内に収める
    let displayLines = [...progressLines];
    let desc = displayLines.join("\n");
    while (desc.length > EMBED_MAX_LENGTH && displayLines.length > 1) {
      displayLines.shift();
      desc = displayLines.join("\n");
    }

    const progressEmbed = new EmbedBuilder()
      .setColor(EMBED_COLORS.progress)
      .setAuthor({ name: "🔧 コーダー 実行中..." })
      .setDescription(desc);

    try {
      if (progressMessageRef.current) {
        await progressMessageRef.current.edit({ embeds: [progressEmbed] });
      } else {
        progressMessageRef.current = await agentChat.send({ embeds: [progressEmbed] });
      }
    } catch {
      // Embed更新失敗は無視
    }
  }

  /**
   * メイン: クロウから呼ばれるコンサルテーション
   * コーディングエージェントを起動し、タスクを実行する。
   * 途中経過を #agent-chat に投稿し、最終結果を返す。
   *
   * 3フェーズで実行:
   * - Phase 1: 仕様提案（ツールなし）→ 設計・ファイル構成を提案（feedbackモード時はスキップ）
   * - Phase 2: 実装（ツールあり）→ 仕様に基づいてコードを書く
   * - Phase 3: 内部レビュー → レビュー＆修正ループ（最大3回）
   *
   * options.feedback が指定された場合はフィードバックモード:
   * Phase 1 をスキップし、フィードバック内容に基づいて修正を実行する
   */
  async consult(
    task: string,
    workDir: string,
    callerChannelId: string,
    onProgress?: (message: string) => void,
    options?: { feedback?: string }
  ): Promise<string> {
    const agentChat = await this.getAgentChatChannel();
    const startTime = Date.now();
    const isFeedbackMode = !!(options?.feedback);

    // 1. #agent-chat にクロウからの相談内容を投稿
    if (agentChat) {
      if (isFeedbackMode) {
        // フィードバックモード: オレンジ色のEmbed
        const feedbackEmbed = new EmbedBuilder()
          .setColor(EMBED_COLORS.feedback)
          .setAuthor({ name: "🐾 クロウ → コーダー（修正依頼）" })
          .setDescription(`**元タスク:** ${task.slice(0, 500)}\n\n**修正依頼:** ${options!.feedback!.slice(0, EMBED_MAX_LENGTH - 600)}`)
          .setFooter({ text: `相談元: <#${callerChannelId}>` })
          .setTimestamp();
        await agentChat.send({ embeds: [feedbackEmbed] });
      } else {
        // 通常モード: 青灰色のEmbed
        const requestEmbed = new EmbedBuilder()
          .setColor(EMBED_COLORS.request)
          .setAuthor({ name: "🐾 クロウ → コーダー" })
          .setDescription(task.slice(0, EMBED_MAX_LENGTH))
          .setFooter({ text: `相談元: <#${callerChannelId}>` })
          .setTimestamp();
        await agentChat.send({ embeds: [requestEmbed] });
      }
    }

    console.log(`[MultiAgent] コーディングエージェント起動${isFeedbackMode ? "（修正モード）" : ""}: ${task.slice(0, 100)}...`);

    let specText = "";

    // ========================================
    // Phase 1: 仕様提案（ツールなし）— フィードバックモード時はスキップ
    // ========================================
    if (!isFeedbackMode) {
      if (onProgress) {
        onProgress("📋 コーダーと仕様を相談中...");
      }

      const specSystemPrompt = [
        "あなたはコーディング専門のAIエンジニアです。",
        "汎用エージェント「クロウ」から依頼を受けて、プログラミングタスクの**仕様を提案**します。",
        "",
        "## このフェーズでやること",
        "まずコードを書く前に、以下の仕様を日本語で提案してください:",
        "1. **機能一覧** — 実装する機能の箇条書き",
        "2. **技術選定** — 使用する言語・ライブラリ・フレームワーク",
        "3. **ファイル構成** — 作成するファイルとその役割",
        "4. **実装方針** — アーキテクチャやデータ構造の概要",
        "",
        "## ルール",
        "- コードは書かず、仕様の提案のみ行ってください",
        "- 簡潔だが具体的にまとめること",
        "- ユーザーの意図を汲み取り、必要に応じて追加提案をすること",
        "",
        `## ワークスペース: ${workDir}`,
        "このディレクトリ内でファイルを作成・編集します（次のフェーズで実装）。",
      ].join("\n");

      try {
        console.log("[MultiAgent] Phase 1: 仕様提案を生成中...");

        const specResult = await generateText({
          model: this.buildModel(),
          system: specSystemPrompt,
          prompt: task,
        });

        specText = specResult.text || "";

        // 仕様提案を #agent-chat に投稿（紫）
        if (agentChat && specText) {
          const specEmbed = new EmbedBuilder()
            .setColor(EMBED_COLORS.spec)
            .setAuthor({ name: "📋 コーダー 仕様提案" })
            .setDescription(specText.slice(0, EMBED_MAX_LENGTH))
            .setTimestamp();
          await agentChat.send({ embeds: [specEmbed] });
        }

        console.log(`[MultiAgent] Phase 1 完了: 仕様提案 ${specText.length}文字`);

        if (onProgress) {
          onProgress("📋 仕様提案が完了しました。実装を開始します...");
        }

      } catch (err: any) {
        console.error("[MultiAgent] Phase 1 エラー:", err);
        if (onProgress) {
          onProgress("⚠️ 仕様提案でエラーが発生しましたが、実装を続行します...");
        }
      }
    } else {
      // フィードバックモード: Phase 1 スキップ
      console.log("[MultiAgent] フィードバックモード: Phase 1 スキップ");
      if (onProgress) {
        onProgress("🔧 修正依頼を受けて実装を開始します...");
      }
    }

    // ========================================
    // Phase 2: 実装（ツールあり）— 自動継続ループ
    // ========================================
    const implSystemPrompt = [
      "あなたはコーディング専門のAIエンジニアです。",
      "汎用エージェント「クロウ」から依頼を受けて、プログラミングタスクを実行します。",
      "",
      "## 重要: タスクを最後まで完遂すること",
      "- 仕様で提案した機能を**すべて**実装してください",
      "- 途中で止まらず、ファイル作成・コード記述・動作確認まで一気に進めること",
      "- 「次に〜します」と宣言だけして止まるのではなく、実際にツールを使って実行すること",
      "",
      "## ルール",
      "- ワークスペース内でファイルの作成・編集・コマンド実行が可能です",
      "- コードを書く際はわかりやすいコメントを付けること",
      "- 変数名・関数名は意味のある名前にすること",
      "- **すべての実装が完了してから**、何を作成/変更したかを簡潔に報告してください",
      "- クロウがユーザーに伝えるため、結果は日本語で簡潔にまとめること",
      "",
      `## ワークスペース: ${workDir}`,
      "このディレクトリ内でのみファイル操作が可能です。",
    ].join("\n");

    // 実装プロンプトの構築（通常モード / フィードバックモード）
    let implPrompt: string;
    if (isFeedbackMode) {
      // フィードバックモード: 修正指示に基づいて実装
      implPrompt = [
        `## 元の依頼内容\n${task}`,
        "",
        `## クロウからの修正依頼`,
        `以下のフィードバックに基づいて、既存の実装を修正してください:`,
        "",
        options!.feedback!,
        "",
        "## 注意",
        "- 修正が必要な箇所のみ変更し、他の部分は触らないこと",
        "- 修正完了後、変更した内容を簡潔に報告すること",
      ].join("\n");
    } else {
      // 通常モード: 仕様提案をコンテキストに含める
      implPrompt = specText
        ? `## 依頼内容\n${task}\n\n## 先ほど提案した仕様\n以下の仕様に基づいて実装してください:\n\n${specText}`
        : task;
    }

    // 進捗トラッキング用の変数（ラウンド間で共有）
    const progressLines: string[] = [];
    const progressMessageRef = { current: null as any };
    const lastEmbedUpdateRef = { current: 0 };
    const EMBED_UPDATE_INTERVAL = 2000;

    // ユーザーチャンネルへの進捗通知用（ラウンド間で共有）
    let fileCount = 0;
    let commandCount = 0;
    let lastUserProgressTime = Date.now();
    const USER_PROGRESS_INTERVAL = 10000; // 10秒間隔

    // 自動継続ループの設定
    const MAX_CONTINUATION_ROUNDS = 5;
    let implMessages: ModelMessage[] = [{ role: "user" as const, content: implPrompt }];
    let finalText = "";

    // onStepFinish コールバック（全ラウンド共通）
    const onStepFinish = async ({ text, toolCalls, toolResults }: any) => {
      // ツール呼び出しをログに追加
      if (toolCalls) {
        for (const tc of toolCalls) {
          const inputStr = this.formatToolInput(
            tc.toolName,
            ((tc as any).input ?? (tc as any).args ?? {}) as Record<string, unknown>
          );
          progressLines.push(`⏺ **${tc.toolName}**(${inputStr})`);
          console.log(`[MultiAgent] ⏺ ${tc.toolName}(${inputStr})`);

          // ファイル操作・コマンド実行のカウント
          if (tc.toolName === "Write" || tc.toolName === "Edit") fileCount++;
          if (tc.toolName === "Bash") commandCount++;
        }
      }

      // ツール実行結果をログに追加
      if (toolResults) {
        for (const tr of toolResults) {
          const rawOutput = (tr as any).output;
          const output = typeof rawOutput === "string"
            ? rawOutput
            : JSON.stringify(rawOutput ?? "");
          const preview = output.split("\n").slice(0, 3).join(" / ").slice(0, 200);
          progressLines.push(`  ⎿ ${preview}`);
        }
      }

      // アシスタントのテキスト出力
      if (text) {
        const preview = text.slice(0, 150).replace(/\n/g, " ");
        progressLines.push(`💭 ${preview}${text.length > 150 ? "..." : ""}`);
      }

      // #agent-chat に進捗を投稿/更新
      await this.updateProgressEmbed(
        agentChat, progressLines, progressMessageRef,
        lastEmbedUpdateRef, EMBED_UPDATE_INTERVAL
      );

      // ユーザーチャンネルへの進捗通知（10秒間隔）
      if (onProgress) {
        const now = Date.now();
        if (now - lastUserProgressTime >= USER_PROGRESS_INTERVAL) {
          lastUserProgressTime = now;
          const elapsed = Math.floor((now - startTime) / 1000);
          const parts = [];
          if (fileCount > 0) parts.push(`ファイル操作: ${fileCount}件`);
          if (commandCount > 0) parts.push(`コマンド実行: ${commandCount}回`);
          parts.push(`経過: ${elapsed}秒`);
          onProgress(`🔧 コーディング中... (${parts.join(", ")})`);
        }
      }
    };

    // 完了判定: テキストに「完了」を示すキーワードが含まれるか
    const looksComplete = (text: string): boolean => {
      const completionPatterns = [
        /(?:以上|これ)(?:で|が)(?:完了|終了|実装完了)/,
        /すべて(?:の|）)?(?:ファイル|実装|作業).*(?:完了|作成|終了)/,
        /最終報告/,
        /実装が完了しました/,
        /作成・変更したファイル/,
      ];
      return completionPatterns.some(p => p.test(text));
    };

    try {
      // 自動継続ループ: モデルがツールを使った後に止まったら「続けて」と促す
      for (let round = 0; round < MAX_CONTINUATION_ROUNDS; round++) {
        // 最終ラウンドかどうか（最終ラウンドはツール強制なし → 報告させる）
        const isFinalRound = round === MAX_CONTINUATION_ROUNDS - 1;

        console.log(`[MultiAgent] Phase 2 ラウンド ${round + 1}/${MAX_CONTINUATION_ROUNDS}${isFinalRound ? " (最終)" : ""}`);

        const result = await generateText({
          model: this.buildModel(),
          system: implSystemPrompt,
          messages: implMessages,
          tools: this.buildCodingTools(workDir),
          toolChoice: isFinalRound ? "auto" : "required",
          stopWhen: stepCountIs(50),
          // ステップごとにtoolChoiceを動的制御:
          // 残り5ステップになったら "auto" に切り替えて報告テキストを生成させる
          prepareStep: ({ stepNumber }) => {
            if (isFinalRound) return {};
            // 残り5ステップで auto に切り替え（報告用）
            if (stepNumber >= 45) {
              return { toolChoice: "auto" as const };
            }
            return {};
          },
          onStepFinish,
        });

        finalText = result.text || "";

        // レスポンスメッセージを会話履歴に追加（次のラウンドで継続するため）
        implMessages = [...implMessages, ...result.response.messages];

        // このラウンドでツールを使ったか確認
        const usedTools = result.steps?.some(
          (s: any) => s.toolCalls && s.toolCalls.length > 0
        ) ?? false;

        // ステップ数を取得
        const stepCount = result.steps?.length ?? 0;

        console.log(`[MultiAgent] Phase 2 ラウンド ${round + 1}: ${stepCount}ステップ, ツール使用: ${usedTools}`);

        // 完了判定:
        // 1. ツール未使用 → テキストのみ → 完了
        // 2. テキストが完了報告っぽい → 完了
        // 3. 最終ラウンド → 強制終了
        if (!usedTools) {
          console.log(`[MultiAgent] Phase 2 ラウンド ${round + 1}: ツール未使用 → 完了`);
          break;
        }

        if (finalText && looksComplete(finalText)) {
          console.log(`[MultiAgent] Phase 2 ラウンド ${round + 1}: 完了報告を検出 → 完了`);
          break;
        }

        if (isFinalRound) {
          console.log(`[MultiAgent] Phase 2: 最大ラウンド数(${MAX_CONTINUATION_ROUNDS})に到達`);
          break;
        }

        // 継続プロンプトを追加して次のラウンドへ
        implMessages.push({
          role: "user" as const,
          content:
            "実装を続けてください。仕様で提案した機能がまだ残っています。\n" +
            "ツールを使って実際にファイルを作成・編集してください。\n" +
            "すべて完了した場合のみ、作成・変更したファイルの一覧と実行方法を最終報告としてまとめてください。",
        });

        progressLines.push(`\n--- 🔄 継続ラウンド ${round + 2} ---`);

        if (onProgress) {
          onProgress(`🔧 実装を継続中... (ラウンド ${round + 2}/${MAX_CONTINUATION_ROUNDS})`);
        }
      }

      if (!finalText) {
        finalText = "(コーディングエージェントからの応答なし)";
      }

      // ========================================
      // Phase 3: 内部レビュー＆修正ループ（最大3回）
      // ========================================
      const MAX_REVIEW_ROUNDS = 3;

      for (let reviewRound = 0; reviewRound < MAX_REVIEW_ROUNDS; reviewRound++) {
        console.log(`[MultiAgent] Phase 3: レビューラウンド ${reviewRound + 1}/${MAX_REVIEW_ROUNDS}`);

        if (onProgress) {
          onProgress(`🔍 内部レビュー中... (ラウンド ${reviewRound + 1}/${MAX_REVIEW_ROUNDS})`);
        }

        // レビュー用システムプロンプト
        const reviewSystemPrompt = [
          "あなたはコードレビューの専門家です。",
          "コーディングエージェントが実装した内容をレビューしてください。",
          "",
          "## レビュー観点",
          "1. 要件を満たしているか（依頼内容と一致するか）",
          "2. コードの品質（可読性、保守性、エラー処理）",
          "3. バグや問題がないか",
          "4. セキュリティ上の懸念がないか",
          "",
          "## 回答形式",
          "必ず以下のJSON形式で回答してください。JSON以外のテキストは含めないでください:",
          '```json',
          '{',
          '  "approved": true/false,',
          '  "score": 1-10,',
          '  "issues": ["問題点1", "問題点2"],',
          '  "suggestions": ["改善提案1", "改善提案2"],',
          '  "summary": "レビュー結果の要約"',
          '}',
          '```',
          "",
          "- score が 7以上なら approved: true にしてください",
          "- score が 7未満なら approved: false にして、issues に具体的な修正指示を書いてください",
        ].join("\n");

        const reviewPrompt = [
          `## 元の依頼内容\n${task}`,
          "",
          `## コーディングエージェントの実行報告\n${finalText}`,
          "",
          `## 実行ログ（参考）\n${progressLines.slice(-30).join("\n")}`,
        ].join("\n");

        try {
          const reviewResult = await generateText({
            model: this.buildModel(),
            system: reviewSystemPrompt,
            prompt: reviewPrompt,
            // ツールなし: レビューのみ
          });

          const reviewText = reviewResult.text || "";

          // JSONを抽出（```json ... ``` またはそのまま）
          let reviewData: { approved: boolean; score: number; issues: string[]; suggestions: string[]; summary: string };
          try {
            const jsonMatch = reviewText.match(/```json\s*([\s\S]*?)\s*```/) || reviewText.match(/(\{[\s\S]*\})/);
            reviewData = JSON.parse(jsonMatch?.[1] || reviewText);
          } catch {
            console.warn("[MultiAgent] Phase 3: レビューJSONのパースに失敗。承認として扱います。");
            // パース失敗時は承認として扱う
            reviewData = { approved: true, score: 7, issues: [], suggestions: [], summary: reviewText.slice(0, 200) };
          }

          console.log(`[MultiAgent] Phase 3 レビュー結果: スコア ${reviewData.score}/10, 承認: ${reviewData.approved}`);

          // レビュー結果を #agent-chat に投稿（青）
          if (agentChat) {
            const isApproved = reviewData.approved || reviewData.score >= 7;
            const reviewEmbed = new EmbedBuilder()
              .setColor(EMBED_COLORS.review)
              .setAuthor({ name: isApproved ? `✅ レビュー承認 (${reviewData.score}/10)` : `🔄 レビュー修正必要 (${reviewData.score}/10)` })
              .setDescription([
                reviewData.summary,
                ...(reviewData.issues.length > 0 ? [`\n**問題点:**\n${reviewData.issues.map(i => `- ${i}`).join("\n")}`] : []),
                ...(reviewData.suggestions.length > 0 ? [`\n**改善提案:**\n${reviewData.suggestions.map(s => `- ${s}`).join("\n")}`] : []),
              ].join("\n").slice(0, EMBED_MAX_LENGTH))
              .setTimestamp();
            await agentChat.send({ embeds: [reviewEmbed] });
          }

          // 承認されたらレビューループ終了
          if (reviewData.approved || reviewData.score >= 7) {
            console.log(`[MultiAgent] Phase 3: レビュー承認 → 完了`);
            if (onProgress) {
              onProgress(`✅ 内部レビュー承認 (${reviewData.score}/10)`);
            }
            break;
          }

          // 未承認: 修正指示を作成してPhase 2的に再実行
          console.log(`[MultiAgent] Phase 3: 未承認 → 修正ラウンド ${reviewRound + 1}`);

          if (onProgress) {
            onProgress(`🔧 レビュー指摘に基づき修正中... (${reviewData.score}/10)`);
          }

          // 修正プロンプトを構築
          const fixPrompt = [
            "## レビューで以下の問題が指摘されました。修正してください。",
            "",
            `**スコア:** ${reviewData.score}/10`,
            "",
            "**問題点:**",
            ...reviewData.issues.map(i => `- ${i}`),
            "",
            ...(reviewData.suggestions.length > 0 ? [
              "**改善提案:**",
              ...reviewData.suggestions.map(s => `- ${s}`),
              "",
            ] : []),
            "上記の問題を修正し、完了したら変更内容を報告してください。",
          ].join("\n");

          // 修正ログの区切り
          progressLines.push(`\n--- 🔍 レビュー修正ラウンド ${reviewRound + 1} ---`);

          // 修正を実行（Phase 2 と同じツールを使用）
          implMessages.push({ role: "user" as const, content: fixPrompt });

          const fixResult = await generateText({
            model: this.buildModel(),
            system: implSystemPrompt,
            messages: implMessages,
            tools: this.buildCodingTools(workDir),
            toolChoice: "auto",
            stopWhen: stepCountIs(30),
            onStepFinish,
          });

          finalText = fixResult.text || finalText;
          implMessages = [...implMessages, ...fixResult.response.messages];

          console.log(`[MultiAgent] Phase 3: 修正完了 (ラウンド ${reviewRound + 1})`);

        } catch (err: any) {
          console.error(`[MultiAgent] Phase 3 レビューエラー (ラウンド ${reviewRound + 1}):`, err);
          // レビューエラー時はループを抜けて結果を返す
          break;
        }
      }

      // 最終回答を #agent-chat に投稿（緑）
      if (agentChat) {
        // 進捗メッセージを最終状態に更新
        if (progressMessageRef.current && progressLines.length > 0) {
          let displayLines = [...progressLines];
          let desc = displayLines.join("\n");
          while (desc.length > EMBED_MAX_LENGTH && displayLines.length > 1) {
            displayLines.shift();
            desc = displayLines.join("\n");
          }
          const finalProgressEmbed = new EmbedBuilder()
            .setColor(EMBED_COLORS.complete)
            .setAuthor({ name: "🔧 コーダー 実行完了" })
            .setDescription(desc);
          try {
            await progressMessageRef.current.edit({ embeds: [finalProgressEmbed] });
          } catch {
            // 更新失敗は無視
          }
        }

        // 最終回答Embed
        const completeEmbed = new EmbedBuilder()
          .setColor(EMBED_COLORS.complete)
          .setAuthor({ name: "🔧 コーダー → クロウ" })
          .setDescription(finalText.slice(0, EMBED_MAX_LENGTH))
          .setFooter({ text: `相談元: <#${callerChannelId}>` })
          .setTimestamp();
        await agentChat.send({ embeds: [completeEmbed] });
      }

      // ユーザーチャンネルに完了通知
      if (onProgress) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        onProgress(`✅ コーディング完了 (${elapsed}秒)`);
      }

      console.log(`[MultiAgent] コーディングエージェント完了: ${finalText.slice(0, 100)}...`);

      // 結果テキストを返す（クロウのツール結果として使われる）
      return finalText;

    } catch (err: any) {
      const errorMsg = `コーディングエージェントでエラーが発生しました: ${err.message || String(err)}`;
      console.error("[MultiAgent] エラー:", err);

      // エラーを #agent-chat に投稿
      if (agentChat) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xef4444)
          .setAuthor({ name: "🔧 コーダー エラー" })
          .setDescription(errorMsg.slice(0, EMBED_MAX_LENGTH))
          .setTimestamp();
        await agentChat.send({ embeds: [errorEmbed] });
      }

      if (onProgress) {
        onProgress("❌ コーディングエージェントでエラーが発生しました");
      }

      return errorMsg;
    }
  }
}
