/**
 * report-tools.ts
 * Wordファイル（DOCX）生成ツール（docxライブラリ使用）
 *
 * docxライブラリを使ってWordドキュメントを生成する。
 * セクション配列を受け取り、見出し・本文・リスト等を含むドキュメントを
 * ワークスペース内にファイルとして出力する。
 *
 * エクスポート: createReportTools(workDir: string)
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  type ISectionOptions,
} from "docx";
import { checkPath } from "../utils/check-path";

/** セクション内の要素種別 */
const ELEMENT_TYPES = [
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
  "bullet_list",
  "numbered_list",
] as const;
type ElementType = (typeof ELEMENT_TYPES)[number];

/** セクション要素の型定義 */
interface SectionElement {
  type: ElementType;
  text: string;
}

/**
 * テキストをTextRunオブジェクトの配列に変換する
 * 改行がある場合はbreak付きのTextRunに分割する
 */
function createTextRuns(
  text: string,
  options?: { bold?: boolean; italic?: boolean; size?: number }
): TextRun[] {
  const lines = text.split("\n");
  const runs: TextRun[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      // 改行をbreak: 1で表現
      runs.push(new TextRun({ text: lines[i], break: 1, ...options }));
    } else {
      runs.push(new TextRun({ text: lines[i], ...options }));
    }
  }
  return runs;
}

/**
 * セクション要素からParagraphオブジェクトの配列を生成する
 * bullet_list / numbered_list は各行を個別のParagraphにする
 */
function createParagraphsFromElement(
  type: ElementType,
  text: string
): Paragraph[] {
  switch (type) {
    case "heading1":
      return [
        new Paragraph({
          children: createTextRuns(text, { bold: true, size: 32 }),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
        }),
      ];

    case "heading2":
      return [
        new Paragraph({
          children: createTextRuns(text, { bold: true, size: 26 }),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 100 },
        }),
      ];

    case "heading3":
      return [
        new Paragraph({
          children: createTextRuns(text, { bold: true, size: 22 }),
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 160, after: 80 },
        }),
      ];

    case "paragraph":
      return [
        new Paragraph({
          children: createTextRuns(text, { size: 22 }),
          spacing: { before: 80, after: 80 },
        }),
      ];

    case "bullet_list": {
      // テキストを改行で分割し、各行を箇条書き項目にする
      const items = text.split("\n").filter((line: string) => line.trim());
      return items.map(
        (item: string) =>
          new Paragraph({
            children: createTextRuns(item.replace(/^[-*]\s*/, ""), { size: 22 }),
            bullet: { level: 0 },
            spacing: { before: 40, after: 40 },
          })
      );
    }

    case "numbered_list": {
      // テキストを改行で分割し、各行を番号付きリスト項目にする
      const items = text.split("\n").filter((line: string) => line.trim());
      return items.map(
        (item: string) =>
          new Paragraph({
            children: createTextRuns(
              item.replace(/^\d+[.)]\s*/, ""),
              { size: 22 }
            ),
            numbering: { reference: "default-numbering", level: 0 },
            spacing: { before: 40, after: 40 },
          })
      );
    }

    default:
      return [
        new Paragraph({
          children: createTextRuns(text, { size: 22 }),
        }),
      ];
  }
}

/**
 * レポート（Word DOCX）生成ツールを生成する
 * @param workDir - ワークスペースディレクトリのパス
 * @returns Vercel AI SDK 用のツールオブジェクト
 */
export function createReportTools(workDir: string) {
  return {
    /**
     * CreateReport: Wordファイルを生成する
     * セクション配列を受け取り、見出し・本文・リスト等を含むドキュメントを作成する
     */
    CreateReport: tool({
      description:
        "Word文書（DOCXファイル）を生成する。" +
        "セクション配列を指定して、見出し・本文・箇条書き・番号付きリストを含むレポートを作成する。",
      inputSchema: zodSchema(z.object({
        filename: z
          .string()
          .describe("出力ファイル名（例: report.docx）"),
        title: z
          .string()
          .optional()
          .describe("ドキュメントタイトル（メタデータおよび表紙に使用）"),
        author: z
          .string()
          .optional()
          .describe("作成者名（メタデータ）"),
        sections: z
          .array(
            z.object({
              type: z
                .enum(ELEMENT_TYPES)
                .describe("要素タイプ（heading1: 大見出し、heading2: 中見出し、heading3: 小見出し、paragraph: 本文、bullet_list: 箇条書き、numbered_list: 番号付きリスト）"),
              text: z
                .string()
                .describe("テキスト内容（bullet_list/numbered_listの場合は改行区切りで各項目を記述）"),
            })
          )
          .describe("ドキュメントの要素配列（順番に出力される）"),
      })),
      execute: async (input: { filename: string; title?: string; author?: string; sections: SectionElement[] }) => {
        try {
          // 出力パスの検証
          const filename = input.filename.endsWith(".docx")
            ? input.filename
            : `${input.filename}.docx`;
          const outputAbs = checkPath(workDir, filename);

          // 出力ディレクトリの自動作成
          mkdirSync(dirname(outputAbs), { recursive: true });

          // セクションが空の場合はエラー
          if (!input.sections || input.sections.length === 0) {
            return "Error: セクションが1つも指定されていません";
          }

          // ドキュメントの全パラグラフを構築
          const allParagraphs: Paragraph[] = [];

          // タイトルがあれば最初にタイトルパラグラフを追加
          if (input.title) {
            allParagraphs.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: input.title,
                    bold: true,
                    size: 40,
                    color: "2B579A",
                  }),
                ],
                heading: HeadingLevel.TITLE,
                alignment: AlignmentType.CENTER,
                spacing: { after: 300 },
              })
            );
          }

          // 各セクション要素をパラグラフに変換
          for (const section of input.sections) {
            const paragraphs = createParagraphsFromElement(section.type, section.text);
            allParagraphs.push(...paragraphs);
          }

          // 番号付きリストが含まれているか確認
          const hasNumberedList = input.sections.some(
            (s: SectionElement) => s.type === "numbered_list"
          );

          // Documentオプションを構築
          const docOptions: any = {
            creator: input.author || "AI Agent Bot",
            title: input.title || "",
            description: "AI Agent Botが生成したレポート",
            sections: [
              {
                properties: {},
                children: allParagraphs,
              } as ISectionOptions,
            ],
          };

          // 番号付きリストがある場合はナンバリング定義を追加
          if (hasNumberedList) {
            docOptions.numbering = {
              config: [
                {
                  reference: "default-numbering",
                  levels: [
                    {
                      level: 0,
                      format: "decimal",
                      text: "%1.",
                      alignment: AlignmentType.LEFT,
                      style: {
                        paragraph: {
                          indent: { left: 720, hanging: 360 },
                        },
                      },
                    },
                  ],
                },
              ],
            };
          }

          const doc = new Document(docOptions);

          // Bufferにパック
          const buffer = await Packer.toBuffer(doc);

          // ファイルに書き込み
          writeFileSync(outputAbs, buffer);

          // 統計情報を集計
          const stats = {
            headings: input.sections.filter((s: SectionElement) =>
              s.type.startsWith("heading")
            ).length,
            paragraphs: input.sections.filter(
              (s: SectionElement) => s.type === "paragraph"
            ).length,
            lists: input.sections.filter(
              (s: SectionElement) =>
                s.type === "bullet_list" || s.type === "numbered_list"
            ).length,
          };

          return (
            `Wordファイルを生成しました。\n` +
            `出力: ${filename}\n` +
            `セクション数: ${input.sections.length}\n` +
            `内訳: 見出し${stats.headings}件, 本文${stats.paragraphs}件, リスト${stats.lists}件\n` +
            (input.title ? `タイトル: ${input.title}` : "")
          );
        } catch (err: any) {
          return `Error: Wordファイルの生成に失敗しました: ${err.message}`;
        }
      },
    }),
  };
}
