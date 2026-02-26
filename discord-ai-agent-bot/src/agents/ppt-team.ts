/**
 * ppt-team.ts
 * PPTチーム — 2フェーズパイプライン
 *
 * 構成設計（planner） → スライド生成（creator）
 * の順にgenerateText()を呼び出し、PowerPointファイルを生成する。
 *
 * エクスポート: PptTeam クラス
 */

import { generateText, stepCountIs } from "ai";

import { buildModel } from "../utils/build-model";
import { loadAgentsConfig, loadModelsConfig, loadPrompt } from "../utils/load-config";
import { createPptTools } from "../tools/ppt-tools";
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

/** PptTeam.execute() の戻り値 */
interface PptResult {
  success: boolean;
  summary: string;
  filePath: string | null;
}

// ========================================
// モデル解決
// ========================================

/**
 * PPTタスクのモデル名を解決する
 */
function resolveModel(): string {
  const models = loadModelsConfig();
  const taskDefault = models.task_defaults?.ppt || "balanced";
  return models.options?.[taskDefault] || models.default;
}

// ========================================
// PptTeam クラス
// ========================================

export class PptTeam {
  private onProgress?: ProgressCallback;

  constructor(options?: { onProgress?: ProgressCallback }) {
    this.onProgress = options?.onProgress;
  }

  /**
   * 進捗イベントを発火する
   */
  private notify(phase: string, agentName: string, message: string): void {
    if (this.onProgress) {
      this.onProgress({ phase, agentName, message });
    }
  }

  /**
   * PPT生成タスクを実行する
   * @param task - ユーザーからの依頼テキスト
   * @param workDir - ワークスペースディレクトリのパス
   * @returns 実行結果（成否・サマリー・生成ファイルパス）
   */
  async execute(task: string, workDir: string): Promise<PptResult> {
    const agents = loadAgentsConfig();
    const modelName = resolveModel();

    try {
      // =============================================
      // Phase 1: 構成設計（plannerエージェント）
      // =============================================
      const planner = agents.ppt_team.planner;
      this.notify("plan", planner.name, "スライド構成を設計中...");

      const planPrompt = loadPrompt("ppt-planner.txt", {
        name: planner.name,
        role: planner.role,
      });

      console.log(`[PptTeam] Phase 1: 構成設計 (${planner.name})`);

      // Web検索ツールを使って情報収集しながら構成を設計
      const planResult = await generateText({
        model: buildModel(modelName),
        system: planPrompt + `\n\n## ワークスペース: ${workDir}`,
        prompt: task,
        tools: createWebSearchTool(),
        stopWhen: stepCountIs(20),
      });

      const planText = planResult.text || "";
      this.notify("plan", planner.name, "構成設計が完了しました");
      console.log(`[PptTeam] Phase 1 完了: ${planText.length}文字`);

      if (!planText) {
        return {
          success: false,
          summary: "構成設計でテキストが生成されませんでした",
          filePath: null,
        };
      }

      // =============================================
      // Phase 2: スライド生成（creatorエージェント）
      // =============================================
      const creator = agents.ppt_team.creator;
      this.notify("create", creator.name, "スライドを生成中...");

      const createPrompt = loadPrompt("ppt-creator.txt", {
        name: creator.name,
        role: creator.role,
      });

      const createUserPrompt = [
        `## ユーザーの依頼\n${task}`,
        "",
        `## プランナーの構成案\n${planText}`,
        "",
        "上記の構成案に基づいてPPTXファイルを生成してください。",
        `ファイルはワークスペース (${workDir}) 内に保存してください。`,
      ].join("\n");

      console.log(`[PptTeam] Phase 2: スライド生成 (${creator.name})`);

      // PPTツール + Web検索ツール
      const createTools = {
        ...createPptTools(workDir),
        ...createWebSearchTool(),
      };

      const createResult = await generateText({
        model: buildModel(modelName),
        system: createPrompt + `\n\n## ワークスペース: ${workDir}`,
        prompt: createUserPrompt,
        tools: createTools,
        stopWhen: stepCountIs(30),
      });

      const createText = createResult.text || "";
      console.log(`[PptTeam] Phase 2 完了: ${createText.length}文字`);

      // 生成されたファイルパスを抽出
      const filePath = extractFilePath(createText, ".pptx");

      this.notify(
        "create",
        creator.name,
        filePath
          ? `スライド生成完了: ${filePath}`
          : "スライド生成が完了しました"
      );

      return {
        success: true,
        summary: createText,
        filePath,
      };
    } catch (err: any) {
      const errorMsg = `PPTチームでエラーが発生しました: ${err.message || String(err)}`;
      console.error("[PptTeam] エラー:", err);
      return {
        success: false,
        summary: errorMsg,
        filePath: null,
      };
    }
  }
}

// ========================================
// ユーティリティ
// ========================================

/**
 * テキストからファイルパスを抽出する
 * 「出力: filename.ext」のパターンや、拡張子を含むパスを検索する
 *
 * @param text - 検索対象テキスト
 * @param ext - 対象の拡張子（例: ".pptx"）
 * @returns 見つかったファイルパス、または null
 */
function extractFilePath(text: string, ext: string): string | null {
  // 「出力: filename.ext」パターン
  const outputMatch = text.match(
    new RegExp(`出力:\\s*([^\\s\\n]+${ext.replace(".", "\\.")})`, "i")
  );
  if (outputMatch) return outputMatch[1];

  // 一般的なファイルパスパターン（拡張子を含む）
  const pathMatch = text.match(
    new RegExp(`([\\w./-]+${ext.replace(".", "\\.")})`, "i")
  );
  if (pathMatch) return pathMatch[1];

  return null;
}
