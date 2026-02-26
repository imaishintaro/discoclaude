/**
 * report-team.ts
 * レポートチーム — 2フェーズパイプライン
 *
 * 分析・情報収集（analyst） → 執筆（writer）
 * の順にgenerateText()を呼び出し、Wordファイル（DOCX）を生成する。
 *
 * エクスポート: ReportTeam クラス
 */

import { generateText, stepCountIs } from "ai";

import { buildModel } from "../utils/build-model";
import { loadAgentsConfig, loadModelsConfig, loadPrompt } from "../utils/load-config";
import { createFileTools } from "../tools/file-tools";
import { createReportTools } from "../tools/report-tools";
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

/** ReportTeam.execute() の戻り値 */
interface ReportResult {
  success: boolean;
  summary: string;
  filePath: string | null;
}

// ========================================
// モデル解決
// ========================================

/**
 * レポートタスクのモデル名を解決する
 */
function resolveModel(): string {
  const models = loadModelsConfig();
  const taskDefault = models.task_defaults?.report || "balanced";
  return models.options?.[taskDefault] || models.default;
}

// ========================================
// ReportTeam クラス
// ========================================

export class ReportTeam {
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
   * レポート生成タスクを実行する
   * @param task - ユーザーからの依頼テキスト
   * @param workDir - ワークスペースディレクトリのパス
   * @returns 実行結果（成否・サマリー・生成ファイルパス）
   */
  async execute(task: string, workDir: string): Promise<ReportResult> {
    const agents = loadAgentsConfig();
    const modelName = resolveModel();

    try {
      // =============================================
      // Phase 1: 分析・情報収集（analystエージェント）
      // =============================================
      const analyst = agents.report_team.analyst;
      this.notify("analyze", analyst.name, "情報収集・分析を開始します...");

      const analyzePrompt = loadPrompt("report-analyst.txt", {
        name: analyst.name,
        role: analyst.role,
      });

      console.log(`[ReportTeam] Phase 1: 分析 (${analyst.name})`);

      // 読み取り系ファイルツール + Web検索ツール
      const allFileTools = createFileTools(workDir);
      const readOnlyTools = {
        Read: allFileTools.Read,
        Glob: allFileTools.Glob,
        Grep: allFileTools.Grep,
      };
      const analyzeTools = {
        ...readOnlyTools,
        ...createWebSearchTool(),
      };

      const analyzeResult = await generateText({
        model: buildModel(modelName),
        system: analyzePrompt + `\n\n## ワークスペース: ${workDir}`,
        prompt: task,
        tools: analyzeTools,
        stopWhen: stepCountIs(20),
      });

      const analyzeText = analyzeResult.text || "";
      this.notify("analyze", analyst.name, "分析が完了しました");
      console.log(`[ReportTeam] Phase 1 完了: ${analyzeText.length}文字`);

      if (!analyzeText) {
        return {
          success: false,
          summary: "分析フェーズでテキストが生成されませんでした",
          filePath: null,
        };
      }

      // =============================================
      // Phase 2: 執筆（writerエージェント）
      // =============================================
      const writer = agents.report_team.writer;
      this.notify("write", writer.name, "レポートを執筆中...");

      const writePrompt = loadPrompt("report-writer.txt", {
        name: writer.name,
        role: writer.role,
      });

      const writeUserPrompt = [
        `## ユーザーの依頼\n${task}`,
        "",
        `## アナリストの分析結果・構成案\n${analyzeText}`,
        "",
        "上記の分析結果に基づいてWord文書（DOCX）を生成してください。",
        `ファイルはワークスペース (${workDir}) 内に保存してください。`,
      ].join("\n");

      console.log(`[ReportTeam] Phase 2: 執筆 (${writer.name})`);

      // レポート生成ツール + Web検索ツール
      const writeTools = {
        ...createReportTools(workDir),
        ...createWebSearchTool(),
      };

      const writeResult = await generateText({
        model: buildModel(modelName),
        system: writePrompt + `\n\n## ワークスペース: ${workDir}`,
        prompt: writeUserPrompt,
        tools: writeTools,
        stopWhen: stepCountIs(30),
      });

      const writeText = writeResult.text || "";
      console.log(`[ReportTeam] Phase 2 完了: ${writeText.length}文字`);

      // 生成されたファイルパスを抽出
      const filePath = extractFilePath(writeText, ".docx");

      this.notify(
        "write",
        writer.name,
        filePath
          ? `レポート生成完了: ${filePath}`
          : "レポート生成が完了しました"
      );

      return {
        success: true,
        summary: writeText,
        filePath,
      };
    } catch (err: any) {
      const errorMsg = `レポートチームでエラーが発生しました: ${err.message || String(err)}`;
      console.error("[ReportTeam] エラー:", err);
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
 * @param ext - 対象の拡張子（例: ".docx"）
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
