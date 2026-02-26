/**
 * ppt-tools.ts
 * PowerPointファイル生成ツール（pptxgenjs使用）
 *
 * pptxgenjsライブラリを使ってPPTXファイルを生成する。
 * スライド配列を受け取り、各スライドにタイトル・本文・レイアウト等を設定して
 * ワークスペース内にファイルを出力する。
 *
 * エクスポート: createPptTools(workDir: string)
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import PptxGenJS from "pptxgenjs";
import { checkPath } from "../utils/check-path";

/** スライドのレイアウト種別 */
const SLIDE_LAYOUTS = ["title", "content", "two_column", "blank"] as const;
type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/** スライドデータの型定義 */
interface SlideData {
  layout?: SlideLayout;
  title?: string;
  body?: string;
  body_right?: string;
  notes?: string;
  background_color?: string;
}

/**
 * PPTXファイル生成ツールを生成する
 * @param workDir - ワークスペースディレクトリのパス
 * @returns Vercel AI SDK 用のツールオブジェクト
 */
export function createPptTools(workDir: string) {
  return {
    /**
     * CreatePPT: PPTXファイルを生成する
     * スライド配列を受け取り、各スライドのレイアウトに応じてコンテンツを配置する
     */
    CreatePPT: tool({
      description:
        "PPTXファイル（PowerPointプレゼンテーション）を生成する。" +
        "スライド配列を指定して、タイトル・本文・レイアウトを含むプレゼンテーションを作成する。",
      inputSchema: zodSchema(z.object({
        filename: z
          .string()
          .describe("出力ファイル名（例: presentation.pptx）"),
        title: z
          .string()
          .optional()
          .describe("プレゼンテーション全体のタイトル（メタデータ）"),
        author: z
          .string()
          .optional()
          .describe("作成者名（メタデータ）"),
        slides: z
          .array(
            z.object({
              layout: z
                .enum(SLIDE_LAYOUTS)
                .optional()
                .describe("スライドレイアウト（title: タイトルスライド、content: 本文、two_column: 2カラム、blank: 空白）"),
              title: z
                .string()
                .optional()
                .describe("スライドタイトル"),
              body: z
                .string()
                .optional()
                .describe("スライド本文（改行で段落を分ける）"),
              body_right: z
                .string()
                .optional()
                .describe("右カラムの本文（two_columnレイアウト時のみ有効）"),
              notes: z
                .string()
                .optional()
                .describe("スピーカーノート"),
              background_color: z
                .string()
                .optional()
                .describe("背景色（CSS色指定。例: #FFFFFF, #003366）"),
            })
          )
          .describe("スライドの配列（順番に生成される）"),
      })),
      execute: async (input: { filename: string; title?: string; author?: string; slides: SlideData[] }) => {
        try {
          // 出力パスの検証
          const filename = input.filename.endsWith(".pptx")
            ? input.filename
            : `${input.filename}.pptx`;
          const outputAbs = checkPath(workDir, filename);

          // 出力ディレクトリの自動作成
          mkdirSync(dirname(outputAbs), { recursive: true });

          // PPTXオブジェクトの生成
          const pptx = new PptxGenJS();

          // メタデータの設定
          if (input.title) pptx.title = input.title;
          if (input.author) pptx.author = input.author;

          // スライドが空の場合はエラー
          if (!input.slides || input.slides.length === 0) {
            return "Error: スライドが1枚も指定されていません";
          }

          // 各スライドを生成
          for (const slideData of input.slides) {
            const slide = pptx.addSlide();
            const layout: SlideLayout = slideData.layout || "content";

            // 背景色の設定
            if (slideData.background_color) {
              // '#' プレフィックスを除去（pptxgenjsの要件）
              const color = slideData.background_color.replace(/^#/, "");
              slide.background = { color };
            }

            // レイアウトに応じたコンテンツ配置
            switch (layout) {
              case "title":
                // タイトルスライド: 中央に大きなタイトル + サブタイトル
                if (slideData.title) {
                  slide.addText(slideData.title, {
                    x: 0.5,
                    y: 1.5,
                    w: 9.0,
                    h: 1.5,
                    fontSize: 36,
                    bold: true,
                    align: "center",
                    valign: "middle",
                    color: "333333",
                  });
                }
                if (slideData.body) {
                  slide.addText(slideData.body, {
                    x: 1.0,
                    y: 3.2,
                    w: 8.0,
                    h: 1.0,
                    fontSize: 18,
                    align: "center",
                    valign: "middle",
                    color: "666666",
                  });
                }
                break;

              case "two_column":
                // 2カラムレイアウト: タイトル + 左右の本文
                if (slideData.title) {
                  slide.addText(slideData.title, {
                    x: 0.5,
                    y: 0.3,
                    w: 9.0,
                    h: 0.8,
                    fontSize: 24,
                    bold: true,
                    color: "333333",
                  });
                }
                // 左カラム
                if (slideData.body) {
                  slide.addText(slideData.body, {
                    x: 0.5,
                    y: 1.3,
                    w: 4.2,
                    h: 3.8,
                    fontSize: 14,
                    color: "444444",
                    valign: "top",
                    lineSpacing: 22,
                  });
                }
                // 右カラム
                if (slideData.body_right) {
                  slide.addText(slideData.body_right, {
                    x: 5.3,
                    y: 1.3,
                    w: 4.2,
                    h: 3.8,
                    fontSize: 14,
                    color: "444444",
                    valign: "top",
                    lineSpacing: 22,
                  });
                }
                break;

              case "blank":
                // 空白スライド: タイトルのみ（あれば）
                if (slideData.title) {
                  slide.addText(slideData.title, {
                    x: 0.5,
                    y: 0.3,
                    w: 9.0,
                    h: 0.8,
                    fontSize: 24,
                    bold: true,
                    color: "333333",
                  });
                }
                break;

              case "content":
              default:
                // 標準コンテンツスライド: タイトル + 本文
                if (slideData.title) {
                  slide.addText(slideData.title, {
                    x: 0.5,
                    y: 0.3,
                    w: 9.0,
                    h: 0.8,
                    fontSize: 24,
                    bold: true,
                    color: "333333",
                  });
                }
                if (slideData.body) {
                  slide.addText(slideData.body, {
                    x: 0.5,
                    y: 1.3,
                    w: 9.0,
                    h: 3.8,
                    fontSize: 16,
                    color: "444444",
                    valign: "top",
                    lineSpacing: 24,
                  });
                }
                break;
            }

            // スピーカーノートの追加
            if (slideData.notes) {
              slide.addNotes(slideData.notes);
            }
          }

          // PPTXファイルをバッファとして出力し、ファイルに書き込む
          const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
          writeFileSync(outputAbs, buffer);

          return (
            `PPTXファイルを生成しました。\n` +
            `出力: ${filename}\n` +
            `スライド数: ${input.slides.length}枚\n` +
            (input.title ? `タイトル: ${input.title}` : "")
          );
        } catch (err: any) {
          return `Error: PPTXファイルの生成に失敗しました: ${err.message}`;
        }
      },
    }),
  };
}
