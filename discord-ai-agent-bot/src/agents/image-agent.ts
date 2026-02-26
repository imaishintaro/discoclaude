/**
 * image-agent.ts
 * 画像エージェント — 単体エージェント（チームではない）
 *
 * ユーザーの依頼に基づいて画像の加工・編集を行う。
 * sharpライブラリを使用したリサイズ・回転・フィルタ等の操作を実行する。
 * 入力画像パスが指定された場合はプロンプトに含める。
 *
 * エクスポート: ImageAgent クラス
 */

import { generateText, stepCountIs } from "ai";

import { buildModel } from "../utils/build-model";
import { loadAgentsConfig, loadModelsConfig, loadPrompt } from "../utils/load-config";
import { createImageTools } from "../tools/image-tools";
import { createFileTools } from "../tools/file-tools";

// ========================================
// 型定義
// ========================================

/** 進捗コールバック */
type ProgressCallback = (event: {
  phase: string;
  agentName: string;
  message: string;
}) => void;

/** ImageAgent.execute() の戻り値 */
interface ImageResult {
  success: boolean;
  summary: string;
  filePath: string | null;
}

// ========================================
// モデル解決
// ========================================

/**
 * 画像タスクのモデル名を解決する
 */
function resolveModel(): string {
  const models = loadModelsConfig();
  const taskDefault = models.task_defaults?.image || "balanced";
  return models.options?.[taskDefault] || models.default;
}

// ========================================
// ImageAgent クラス
// ========================================

export class ImageAgent {
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
   * 画像加工タスクを実行する
   * @param task - ユーザーからの依頼テキスト
   * @param workDir - ワークスペースディレクトリのパス
   * @param inputImagePath - 入力画像のパス（省略可）
   * @returns 実行結果（成否・サマリー・出力ファイルパス）
   */
  async execute(
    task: string,
    workDir: string,
    inputImagePath?: string
  ): Promise<ImageResult> {
    const agents = loadAgentsConfig();
    const modelName = resolveModel();
    const agentConfig = agents.image_agent;

    try {
      // =============================================
      // 単一フェーズ: 画像加工
      // =============================================
      this.notify("process", agentConfig.name, "画像加工を開始します...");

      const systemPrompt = loadPrompt("image-agent.txt", {
        name: agentConfig.name,
        role: agentConfig.role,
      }) + `\n\n## ワークスペース: ${workDir}`;

      // ユーザープロンプトの構築
      let userPrompt = task;
      if (inputImagePath) {
        userPrompt = `入力画像: ${inputImagePath}\n\n${task}`;
      }

      console.log(
        `[ImageAgent] 画像加工開始 (${agentConfig.name})` +
          (inputImagePath ? ` 入力: ${inputImagePath}` : "")
      );

      // 画像ツール + ファイル読み取りツール（Read系のみ）
      const allFileTools = createFileTools(workDir);
      const readOnlyFileTools = {
        Read: allFileTools.Read,
        Glob: allFileTools.Glob,
        Grep: allFileTools.Grep,
      };
      const tools = {
        ...createImageTools(workDir),
        ...readOnlyFileTools,
      };

      const result = await generateText({
        model: buildModel(modelName),
        system: systemPrompt,
        prompt: userPrompt,
        tools,
        stopWhen: stepCountIs(20),
      });

      const resultText = result.text || "";
      console.log(`[ImageAgent] 完了: ${resultText.length}文字`);

      // 出力ファイルパスを抽出
      const filePath = extractImagePath(resultText);

      this.notify(
        "process",
        agentConfig.name,
        filePath
          ? `画像加工完了: ${filePath}`
          : "画像加工が完了しました"
      );

      return {
        success: true,
        summary: resultText,
        filePath,
      };
    } catch (err: any) {
      const errorMsg = `画像エージェントでエラーが発生しました: ${err.message || String(err)}`;
      console.error("[ImageAgent] エラー:", err);
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

/** 画像ファイルの拡張子パターン */
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|webp|avif|tiff|gif|bmp)/i;

/**
 * テキストから画像ファイルパスを抽出する
 * 「出力: filename.ext」パターンや、画像拡張子を含むパスを検索する
 *
 * @param text - 検索対象テキスト
 * @returns 見つかったファイルパス、または null
 */
function extractImagePath(text: string): string | null {
  // 「出力: filename.ext」パターン
  const outputMatch = text.match(
    /出力:\s*([^\s\n]+\.(jpg|jpeg|png|webp|avif|tiff|gif|bmp))/i
  );
  if (outputMatch) return outputMatch[1];

  // _processed や _resized 等のサフィックスがついたファイルパスを優先検索
  const processedMatch = text.match(
    /([\w./-]+_\w+\.(jpg|jpeg|png|webp|avif|tiff|gif|bmp))/i
  );
  if (processedMatch) return processedMatch[1];

  // 一般的な画像ファイルパス
  const pathMatch = text.match(
    /([\w./-]+\.(jpg|jpeg|png|webp|avif|tiff|gif|bmp))/i
  );
  if (pathMatch) return pathMatch[1];

  return null;
}
