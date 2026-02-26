/**
 * load-config.ts
 * 設定ファイル・プロンプト読み込みユーティリティ
 *
 * config/ ディレクトリ内の agents.json, models.json, prompts/*.txt を
 * 読み込むヘルパー関数を提供する。
 * 各エージェント・チームから共通で使用される。
 *
 * エクスポート: loadAgentsConfig(), loadModelsConfig(), loadPrompt()
 */

import { readFileSync } from "fs";
import { join } from "path";

/** config ディレクトリのルートパス（dist/ からの相対パス） */
const CONFIG_DIR = join(__dirname, "../../config");

/**
 * config/agents.json からエージェント設定を読み込む
 *
 * @returns パース済みのエージェント設定オブジェクト
 */
export function loadAgentsConfig(): any {
  const raw = readFileSync(join(CONFIG_DIR, "agents.json"), "utf-8");
  return JSON.parse(raw);
}

/**
 * config/models.json からモデル設定を読み込む
 *
 * @returns パース済みのモデル設定オブジェクト
 */
export function loadModelsConfig(): any {
  const raw = readFileSync(join(CONFIG_DIR, "models.json"), "utf-8");
  return JSON.parse(raw);
}

/**
 * プロンプトファイルを読み込み、プレースホルダを置換する
 *
 * config/prompts/ 内のテキストファイルを読み込み、
 * {key} 形式のプレースホルダを指定された値で置換する。
 *
 * @param filename - config/prompts/ 内のファイル名（例: "coding-designer.txt"）
 * @param replacements - 置換する変数マップ（例: { name: "アーキ", role: "設計担当" }）
 * @returns プレースホルダ置換済みのテキスト
 */
export function loadPrompt(
  filename: string,
  replacements: Record<string, string>
): string {
  const raw = readFileSync(join(CONFIG_DIR, "prompts", filename), "utf-8");
  let result = raw;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return result;
}
