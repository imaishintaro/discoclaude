/**
 * web-search.ts
 * Web検索ツール（Tavily API）
 *
 * Tavily APIを使用してWeb検索を行い、結果をテキスト形式で返す。
 * TAVILY_API_KEY 環境変数が必要。
 *
 * エクスポート: createWebSearchTool()
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";

/** Tavily APIのレスポンス型（必要なフィールドのみ） */
interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilySearchResponse {
  results: TavilySearchResult[];
  query: string;
}

/**
 * Web検索ツールを生成する
 * @returns Vercel AI SDK 用のツールオブジェクト
 */
export function createWebSearchTool() {
  return {
    /**
     * WebSearch: Tavily APIによるWeb検索
     * - 検索クエリを受け取り、結果をタイトル・URL・スニペットで返す
     * - 最大10件の結果を返す
     * - TAVILY_API_KEY が未設定の場合はエラーメッセージを返す
     */
    WebSearch: tool({
      description:
        "ウェブ検索を実行して最新情報を取得する（Tavily API経由）。" +
        "技術的な質問、最新ニュース、ドキュメント検索などに使用する。",
      inputSchema: zodSchema(z.object({
        query: z.string().describe("検索クエリ"),
        num_results: z.number().optional().describe("取得する結果数（デフォルト: 5、最大: 10）"),
      })),
      execute: async (input: { query: string; num_results?: number }) => {
        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) {
          return "Error: TAVILY_API_KEY が設定されていません。Web検索を利用するには環境変数に設定してください。";
        }

        const numResults = Math.min(input.num_results || 5, 10);

        try {
          // Tavily Search APIへリクエスト
          const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              api_key: apiKey,
              query: input.query,
              max_results: numResults,
              search_depth: "basic", // basic: 高速、advanced: より詳細
              include_answer: false,
            }),
            signal: AbortSignal.timeout(15000), // 15秒タイムアウト
          });

          if (!response.ok) {
            const body = await response.text().catch(() => "(読み取れず)");
            return `Error: Tavily API エラー (HTTP ${response.status}): ${body}`;
          }

          const data = (await response.json()) as TavilySearchResponse;
          const results = data.results || [];

          if (results.length === 0) {
            return `「${input.query}」に対する検索結果が見つかりませんでした`;
          }

          // 検索結果を見やすいテキスト形式に整形
          const formatted = results
            .map((r: TavilySearchResult, i: number) => {
              const lines = [`[${i + 1}] ${r.title || "(タイトルなし)"}`];
              lines.push(`    URL: ${r.url}`);
              if (r.content) {
                // スニペットは300文字までに切り詰め
                const snippet = r.content.length > 300
                  ? r.content.slice(0, 300) + "..."
                  : r.content;
                lines.push(`    ${snippet}`);
              }
              return lines.join("\n");
            })
            .join("\n\n");

          return `「${input.query}」の検索結果（${results.length}件）:\n\n${formatted}`;
        } catch (err: any) {
          if (err.name === "TimeoutError" || err.name === "AbortError") {
            return "Error: Web検索がタイムアウトしました（15秒超過）";
          }
          return `Error: Web検索に失敗しました: ${err.message}`;
        }
      },
    }),
  };
}
