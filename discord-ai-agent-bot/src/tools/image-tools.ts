/**
 * image-tools.ts
 * 画像加工ツール（sharp使用）
 *
 * sharpライブラリを使って画像のリサイズ、回転、グレースケール変換、
 * ぼかし、クロップ等の加工処理を行う。
 * 入力ファイルと出力ファイルはすべてワークスペース内に制限される。
 *
 * エクスポート: createImageTools(workDir: string)
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { existsSync, mkdirSync } from "fs";
import { dirname, basename, extname, join } from "path";
import sharp from "sharp";
import { checkPath } from "../utils/check-path";

/**
 * 出力ファイルパスを生成する
 * 指定がなければ入力ファイル名に "_processed" サフィックスを付ける
 */
function generateOutputPath(inputPath: string, outputPath?: string): string {
  if (outputPath) return outputPath;
  const ext = extname(inputPath);
  const base = basename(inputPath, ext);
  const dir = dirname(inputPath);
  return join(dir, `${base}_processed${ext}`);
}

/** 画像操作パラメータの型定義 */
interface ImageOperations {
  resize?: { width?: number; height?: number; fit?: "cover" | "contain" | "fill" | "inside" | "outside" };
  rotate?: number;
  grayscale?: boolean;
  blur?: number;
  crop?: { left: number; top: number; width: number; height: number };
  flip?: boolean;
  flop?: boolean;
  format?: "jpeg" | "png" | "webp" | "avif" | "tiff";
  quality?: number;
}

/**
 * 画像加工ツール群を生成する
 * @param workDir - ワークスペースディレクトリのパス
 * @returns Vercel AI SDK 用のツールオブジェクト
 */
export function createImageTools(workDir: string) {
  return {
    /**
     * ProcessImage: 画像加工ツール
     * 各種操作（リサイズ、回転、グレースケール、ぼかし、クロップ等）を
     * チェーンで適用し、結果を保存する。
     */
    ProcessImage: tool({
      description:
        "画像を加工する。リサイズ、回転、グレースケール、ぼかし、クロップなどの操作を適用できる。" +
        "複数の操作を同時に指定可能。",
      inputSchema: zodSchema(z.object({
        input_path: z.string().describe("加工する画像ファイルのパス"),
        output_path: z
          .string()
          .optional()
          .describe("出力ファイルパス（省略時は入力ファイル名_processed.拡張子）"),
        operations: z.object({
          resize: z
            .object({
              width: z.number().optional().describe("リサイズ後の幅（ピクセル）"),
              height: z.number().optional().describe("リサイズ後の高さ（ピクセル）"),
              fit: z
                .enum(["cover", "contain", "fill", "inside", "outside"])
                .optional()
                .describe("リサイズのフィット方法（デフォルト: cover）"),
            })
            .optional()
            .describe("リサイズ操作"),
          rotate: z
            .number()
            .optional()
            .describe("回転角度（度数。正の値で時計回り）"),
          grayscale: z
            .boolean()
            .optional()
            .describe("グレースケール変換するかどうか"),
          blur: z
            .number()
            .optional()
            .describe("ぼかしの強度（sigma値。0.3〜100）"),
          crop: z
            .object({
              left: z.number().describe("クロップ開始位置X（ピクセル）"),
              top: z.number().describe("クロップ開始位置Y（ピクセル）"),
              width: z.number().describe("クロップ幅（ピクセル）"),
              height: z.number().describe("クロップ高さ（ピクセル）"),
            })
            .optional()
            .describe("クロップ（切り抜き）操作"),
          flip: z
            .boolean()
            .optional()
            .describe("上下反転するかどうか"),
          flop: z
            .boolean()
            .optional()
            .describe("左右反転するかどうか"),
          format: z
            .enum(["jpeg", "png", "webp", "avif", "tiff"])
            .optional()
            .describe("出力フォーマット（省略時は入力と同じ）"),
          quality: z
            .number()
            .optional()
            .describe("出力品質（1-100、jpeg/webp/avifで有効）"),
        }).describe("適用する画像操作"),
      })),
      execute: async (input: { input_path: string; output_path?: string; operations: ImageOperations }) => {
        try {
          // 入力パスの検証
          const inputAbs = checkPath(workDir, input.input_path);
          if (!existsSync(inputAbs)) {
            return `Error: 入力画像が見つかりません: ${input.input_path}`;
          }

          // 出力パスの生成と検証
          const outputRelative = generateOutputPath(input.input_path, input.output_path);
          const outputAbs = checkPath(workDir, outputRelative);

          // 出力ディレクトリの自動作成
          mkdirSync(dirname(outputAbs), { recursive: true });

          // sharpパイプラインを構築
          let pipeline = sharp(inputAbs);
          const ops = input.operations;
          const appliedOps: string[] = [];

          // クロップ（extract）は他の操作の前に適用
          if (ops.crop) {
            pipeline = pipeline.extract({
              left: ops.crop.left,
              top: ops.crop.top,
              width: ops.crop.width,
              height: ops.crop.height,
            });
            appliedOps.push(`クロップ(${ops.crop.width}x${ops.crop.height})`);
          }

          // リサイズ
          if (ops.resize) {
            pipeline = pipeline.resize({
              width: ops.resize.width,
              height: ops.resize.height,
              fit: ops.resize.fit || "cover",
            });
            const sizeStr = [ops.resize.width, ops.resize.height].filter(Boolean).join("x");
            appliedOps.push(`リサイズ(${sizeStr})`);
          }

          // 回転
          if (ops.rotate !== undefined) {
            pipeline = pipeline.rotate(ops.rotate);
            appliedOps.push(`回転(${ops.rotate}度)`);
          }

          // グレースケール変換
          if (ops.grayscale) {
            pipeline = pipeline.grayscale();
            appliedOps.push("グレースケール");
          }

          // ぼかし
          if (ops.blur !== undefined) {
            // sharpのblurはsigma値（0.3以上）
            const sigma = Math.max(0.3, Math.min(100, ops.blur));
            pipeline = pipeline.blur(sigma);
            appliedOps.push(`ぼかし(sigma=${sigma})`);
          }

          // 上下反転
          if (ops.flip) {
            pipeline = pipeline.flip();
            appliedOps.push("上下反転");
          }

          // 左右反転
          if (ops.flop) {
            pipeline = pipeline.flop();
            appliedOps.push("左右反転");
          }

          // 出力フォーマット変換
          if (ops.format) {
            const formatOptions: Record<string, any> = {};
            if (ops.quality !== undefined) {
              formatOptions.quality = Math.max(1, Math.min(100, ops.quality));
            }
            pipeline = pipeline.toFormat(ops.format, formatOptions);
            appliedOps.push(`フォーマット変換(${ops.format})`);
          } else if (ops.quality !== undefined) {
            appliedOps.push(`品質(${ops.quality})`);
          }

          // ファイルに出力
          const info = await pipeline.toFile(outputAbs);

          return (
            `画像を加工しました。\n` +
            `出力: ${outputRelative}\n` +
            `サイズ: ${info.width}x${info.height} (${info.size} bytes)\n` +
            `フォーマット: ${info.format}\n` +
            `適用した操作: ${appliedOps.length > 0 ? appliedOps.join(", ") : "なし"}`
          );
        } catch (err: any) {
          return `Error: 画像加工に失敗しました: ${err.message}`;
        }
      },
    }),
  };
}
