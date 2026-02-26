/**
 * build-model.ts
 * AIモデルインスタンスの構築ユーティリティ
 *
 * OpenRouter / Anthropic の切り替えを一元管理する。
 * 各エージェント・チームから共通で使用される。
 *
 * エクスポート: buildModel(modelName: string)
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * モデル名からVercel AI SDK用のモデルインスタンスを構築する。
 *
 * - OPENROUTER_API_KEY がある場合: OpenRouter経由（.chat() 必須）
 * - ANTHROPIC_API_KEY がある場合: Anthropic直接
 * - どちらもない場合: エラーを投げる
 *
 * @param modelName - モデルID文字列（例: "anthropic/claude-sonnet-4-20250514"）
 * @returns Vercel AI SDK のモデルインスタンス
 */
export function buildModel(modelName: string) {
  // OpenRouter を優先チェック
  if (process.env.OPENROUTER_API_KEY) {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    // 重要: OpenRouter利用時は必ず .chat() を使う
    // @ai-sdk/openai v6 はデフォルトで /v1/responses を使うため
    return openrouter.chat(modelName);
  }

  // Anthropic 直接利用
  if (process.env.ANTHROPIC_API_KEY) {
    // プロバイダ名プレフィックス（例: "anthropic/"）を除去
    const modelId = modelName.replace(/^[^/]+\//, "");
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    return anthropic(modelId);
  }

  throw new Error(
    "OPENROUTER_API_KEY または ANTHROPIC_API_KEY が必要です"
  );
}
