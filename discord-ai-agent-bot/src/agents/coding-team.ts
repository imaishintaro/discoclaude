/**
 * coding-team.ts
 * コーディングチーム — 4フェーズパイプライン
 *
 * 設計（designer） → 実装（implementer） → レビュー（reviewer） → まとめ（summarizer）
 * の順にgenerateText()を呼び出し、コーディングタスクを遂行する。
 * レビューで不合格の場合は実装フェーズに差し戻して最大3回リトライする。
 *
 * エクスポート: CodingTeam クラス
 */

import { generateText, stepCountIs, type ModelMessage } from "ai";

import { buildModel } from "../utils/build-model";
import { loadAgentsConfig, loadModelsConfig, loadPrompt } from "../utils/load-config";
import { createFileTools } from "../tools/file-tools";
import { createBashTool } from "../tools/bash-tool";
import { createWebSearchTool } from "../tools/web-search";

// ========================================
// 型定義
// ========================================

/** 進捗コールバック */
type ProgressCallback = (event: {
  phase: string;
  agentName: string;
  message: string;
}) => void;

/** CodingTeam.execute() の戻り値 */
interface CodingResult {
  success: boolean;
  summary: string;
  filesChanged: string[];
}

/** レビュー結果のJSON型 */
interface ReviewResult {
  approved: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  summary: string;
}

// ========================================
// モデル解決
// ========================================

/**
 * タスクの種別に応じたモデル名を解決する
 */
function resolveModel(): string {
  const models = loadModelsConfig();
  const taskDefault = models.task_defaults?.coding || "balanced";
  return models.options?.[taskDefault] || models.default;
}

// ========================================
// CodingTeam クラス
// ========================================

export class CodingTeam {
  private onProgress?: ProgressCallback;

  constructor(options?: { onProgress?: ProgressCallback }) {
    this.onProgress = options?.onProgress;
  }

  /**
   * 進捗イベントを発火する（コールバックが設定されていれば呼び出す）
   */
  private notify(phase: string, agentName: string, message: string): void {
    if (this.onProgress) {
      this.onProgress({ phase, agentName, message });
    }
  }

  /**
   * コーディングタスクを実行する
   * @param task - ユーザーからの依頼テキスト
   * @param workDir - ワークスペースディレクトリのパス
   * @param feedback - フィードバック（差し戻し時の修正指示、省略可）
   * @returns 実行結果（成否・サマリー・変更ファイル一覧）
   */
  async execute(
    task: string,
    workDir: string,
    feedback?: string
  ): Promise<CodingResult> {
    const agents = loadAgentsConfig();
    const modelName = resolveModel();

    // デフォルトの返却値
    let designText = "";
    let implementText = "";
    let reviewData: ReviewResult | null = null;
    let summaryText = "";
    const filesChanged: string[] = [];

    try {
      // =============================================
      // Phase 1: 設計（designerエージェント）
      // feedbackモード時はスキップ
      // =============================================
      if (!feedback) {
        const designer = agents.coding_team.designer;
        this.notify("design", designer.name, "設計を開始します...");

        const designPrompt = loadPrompt("coding-designer.txt", {
          name: designer.name,
          role: designer.role,
        });

        console.log(`[CodingTeam] Phase 1: 設計 (${designer.name})`);

        const designResult = await generateText({
          model: buildModel(modelName),
          system: designPrompt + `\n\n## ワークスペース: ${workDir}`,
          prompt: task,
        });

        designText = designResult.text || "";
        this.notify("design", designer.name, "設計が完了しました");
        console.log(`[CodingTeam] Phase 1 完了: ${designText.length}文字`);
      } else {
        console.log("[CodingTeam] フィードバックモード: Phase 1 スキップ");
      }

      // =============================================
      // Phase 2 + Phase 3: 実装 → レビューのループ（最大3回）
      // =============================================
      const MAX_REVIEW_ROUNDS = 3;
      let approved = false;

      for (
        let reviewRound = 0;
        reviewRound < MAX_REVIEW_ROUNDS;
        reviewRound++
      ) {
        // =============================================
        // Phase 2: 実装（implementerエージェント）
        // 自動継続ループ（最大5ラウンド）
        // =============================================
        const implementer = agents.coding_team.implementer;
        this.notify(
          "implement",
          implementer.name,
          reviewRound === 0
            ? "実装を開始します..."
            : `レビュー指摘に基づき修正中... (ラウンド ${reviewRound + 1})`
        );

        const implSystemPrompt = loadPrompt("coding-implementer.txt", {
          name: implementer.name,
          role: implementer.role,
        }) + `\n\n## ワークスペース: ${workDir}`;

        // 実装プロンプトの構築
        let implUserPrompt: string;
        if (feedback && reviewRound === 0) {
          // 初回のフィードバックモード
          implUserPrompt = [
            `## 元の依頼内容\n${task}`,
            "",
            `## フィードバック（修正依頼）`,
            feedback,
            "",
            "修正が必要な箇所のみ変更し、完了後に変更内容を報告してください。",
          ].join("\n");
        } else if (reviewRound > 0 && reviewData) {
          // レビュー差し戻し後の再実装
          implUserPrompt = [
            `## 元の依頼内容\n${task}`,
            "",
            `## レビューからの指摘（スコア: ${reviewData.score}/10）`,
            "**問題点:**",
            ...reviewData.issues.map((i) => `- ${i}`),
            "",
            ...(reviewData.suggestions.length > 0
              ? [
                  "**改善提案:**",
                  ...reviewData.suggestions.map((s) => `- ${s}`),
                  "",
                ]
              : []),
            "上記の指摘に基づいて修正し、完了後に変更内容を報告してください。",
          ].join("\n");
        } else {
          // 通常モード（設計結果を含む）
          implUserPrompt = designText
            ? `## 依頼内容\n${task}\n\n## 設計書\n以下の設計に基づいて実装してください:\n\n${designText}`
            : task;
        }

        console.log(
          `[CodingTeam] Phase 2: 実装 (${implementer.name}) ラウンド ${reviewRound + 1}`
        );

        // 実装ツールの構築
        const implTools = {
          ...createFileTools(workDir),
          ...createBashTool(workDir),
          ...createWebSearchTool(),
        };

        // 自動継続ループ（最大5ラウンド）
        const MAX_IMPL_ROUNDS = 5;
        let implMessages: ModelMessage[] = [
          { role: "user" as const, content: implUserPrompt },
        ];

        /** テキストが完了報告を含んでいるか判定 */
        const looksComplete = (text: string): boolean => {
          const patterns = [
            /完了/,
            /最終報告/,
            /実装が.*完了/,
            /作成・変更したファイル/,
            /すべて.*実装/,
          ];
          return patterns.some((p) => p.test(text));
        };

        for (let implRound = 0; implRound < MAX_IMPL_ROUNDS; implRound++) {
          const isFinalRound = implRound === MAX_IMPL_ROUNDS - 1;

          console.log(
            `[CodingTeam] Phase 2 実装ラウンド ${implRound + 1}/${MAX_IMPL_ROUNDS}${isFinalRound ? " (最終)" : ""}`
          );

          const result = await generateText({
            model: buildModel(modelName),
            system: implSystemPrompt,
            messages: implMessages,
            tools: implTools,
            toolChoice: isFinalRound ? "auto" : "required",
            stopWhen: stepCountIs(50),
            prepareStep: ({ stepNumber }) => {
              if (isFinalRound) return {};
              // 残り5ステップで auto に切り替え（報告テキスト生成用）
              if (stepNumber >= 45) {
                return { toolChoice: "auto" as const };
              }
              return {};
            },
          });

          implementText = result.text || "";

          // 会話履歴にレスポンスを追加（次ラウンドの継続用）
          implMessages = [...implMessages, ...result.response.messages];

          // ツール使用の有無を確認
          const usedTools =
            result.steps?.some(
              (s: any) => s.toolCalls && s.toolCalls.length > 0
            ) ?? false;

          // 変更されたファイルをトラッキング
          if (result.steps) {
            for (const step of result.steps) {
              if (step.toolCalls) {
                for (const tc of step.toolCalls as any[]) {
                  if (
                    tc.toolName === "Write" ||
                    tc.toolName === "Edit"
                  ) {
                    const fp = tc.args?.file_path || tc.input?.file_path;
                    if (fp && !filesChanged.includes(fp)) {
                      filesChanged.push(fp);
                    }
                  }
                }
              }
            }
          }

          // 完了判定
          if (!usedTools) {
            console.log(
              `[CodingTeam] Phase 2 ラウンド ${implRound + 1}: ツール未使用 → 完了`
            );
            break;
          }
          if (implementText && looksComplete(implementText)) {
            console.log(
              `[CodingTeam] Phase 2 ラウンド ${implRound + 1}: 完了報告検出 → 完了`
            );
            break;
          }
          if (isFinalRound) {
            console.log(
              `[CodingTeam] Phase 2: 最大ラウンド数(${MAX_IMPL_ROUNDS})に到達`
            );
            break;
          }

          // 継続プロンプト
          implMessages.push({
            role: "user" as const,
            content:
              "実装を続けてください。まだ完了していない機能があります。\n" +
              "すべて完了した場合のみ、作成・変更したファイルの一覧と実行方法を最終報告としてまとめてください。",
          });

          this.notify(
            "implement",
            implementer.name,
            `実装を継続中... (ラウンド ${implRound + 2}/${MAX_IMPL_ROUNDS})`
          );
        }

        this.notify("implement", implementer.name, "実装が完了しました");
        console.log(
          `[CodingTeam] Phase 2 完了: ${implementText.length}文字`
        );

        // =============================================
        // Phase 3: レビュー（reviewerエージェント）
        // =============================================
        const reviewer = agents.coding_team.reviewer;
        this.notify("review", reviewer.name, "コードレビューを開始します...");

        const reviewSystemPrompt = loadPrompt("coding-reviewer.txt", {
          name: reviewer.name,
          role: reviewer.role,
        }) + `\n\n## ワークスペース: ${workDir}`;

        const reviewUserPrompt = [
          `## 元の依頼内容\n${task}`,
          "",
          designText ? `## 設計書\n${designText}\n` : "",
          `## 実装エージェントの報告\n${implementText}`,
        ].join("\n");

        console.log(
          `[CodingTeam] Phase 3: レビュー (${reviewer.name}) ラウンド ${reviewRound + 1}`
        );

        // レビュー用ツール（読み取り系のみ: Read, Glob, Grep）
        const allFileTools = createFileTools(workDir);
        const readOnlyTools = {
          Read: allFileTools.Read,
          Glob: allFileTools.Glob,
          Grep: allFileTools.Grep,
        };

        const reviewResult = await generateText({
          model: buildModel(modelName),
          system: reviewSystemPrompt,
          prompt: reviewUserPrompt,
          tools: readOnlyTools,
          stopWhen: stepCountIs(20),
        });

        const reviewText = reviewResult.text || "";

        // JSON抽出（```json ... ``` またはそのまま）
        try {
          const jsonMatch =
            reviewText.match(/```json\s*([\s\S]*?)\s*```/) ||
            reviewText.match(/(\{[\s\S]*\})/);
          reviewData = JSON.parse(jsonMatch?.[1] || reviewText);
        } catch {
          console.warn(
            "[CodingTeam] レビューJSONのパースに失敗。承認として扱います。"
          );
          reviewData = {
            approved: true,
            score: 7,
            issues: [],
            suggestions: [],
            summary: reviewText.slice(0, 200),
          };
        }

        console.log(
          `[CodingTeam] Phase 3 レビュー結果: スコア ${reviewData!.score}/10, 承認: ${reviewData!.approved}`
        );

        // スコア7以上 → 承認
        if (reviewData!.approved || reviewData!.score >= 7) {
          approved = true;
          this.notify(
            "review",
            reviewer.name,
            `レビュー承認 (${reviewData!.score}/10)`
          );
          break;
        }

        // スコア7未満 → Phase 2 を再実行
        this.notify(
          "review",
          reviewer.name,
          `レビュー差し戻し (${reviewData!.score}/10) → 修正へ`
        );

        // 最終ラウンドで不合格の場合
        if (reviewRound === MAX_REVIEW_ROUNDS - 1) {
          console.log(
            `[CodingTeam] レビュー ${MAX_REVIEW_ROUNDS}回不合格 → 強制終了`
          );
          return {
            success: false,
            summary: `レビューを${MAX_REVIEW_ROUNDS}回通過できませんでした。\n最終スコア: ${reviewData!.score}/10\n問題点: ${reviewData!.issues.join(", ")}`,
            filesChanged,
          };
        }
      }

      // =============================================
      // Phase 4: まとめ（summarizerエージェント）
      // =============================================
      const summarizer = agents.coding_team.summarizer;
      this.notify("summarize", summarizer.name, "サマリーを作成中...");

      const summarySystemPrompt = loadPrompt("coding-summarizer.txt", {
        name: summarizer.name,
        role: summarizer.role,
      });

      const summaryUserPrompt = [
        `## 元の依頼内容\n${task}`,
        "",
        designText ? `## 設計書\n${designText}\n` : "",
        `## 実装結果\n${implementText}`,
        "",
        reviewData
          ? `## レビュー結果\nスコア: ${reviewData.score}/10\nサマリー: ${reviewData.summary}`
          : "",
      ].join("\n");

      console.log(
        `[CodingTeam] Phase 4: まとめ (${summarizer.name})`
      );

      const summaryResult = await generateText({
        model: buildModel(modelName),
        system: summarySystemPrompt,
        prompt: summaryUserPrompt,
      });

      summaryText = summaryResult.text || implementText;
      this.notify("summarize", summarizer.name, "サマリーが完了しました");
      console.log(
        `[CodingTeam] Phase 4 完了: ${summaryText.length}文字`
      );

      return {
        success: true,
        summary: summaryText,
        filesChanged,
      };
    } catch (err: any) {
      const errorMsg = `コーディングチームでエラーが発生しました: ${err.message || String(err)}`;
      console.error("[CodingTeam] エラー:", err);
      return {
        success: false,
        summary: errorMsg,
        filesChanged,
      };
    }
  }
}
