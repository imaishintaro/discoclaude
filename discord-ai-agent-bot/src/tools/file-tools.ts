/**
 * file-tools.ts
 * ファイル操作関連のツール定義
 *
 * ワークスペース内のファイルに対して読み書き・編集・検索を行うツール群。
 * すべての操作は checkPath() でワークスペース外へのアクセスをブロックする。
 *
 * エクスポート: createFileTools(workDir: string)
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { checkPath } from "../utils/check-path";

const exec = promisify(execCb);

/**
 * ファイル操作ツール群を生成する
 * @param workDir - ワークスペースディレクトリのパス
 * @returns Vercel AI SDK 用のツールオブジェクト
 */
export function createFileTools(workDir: string) {
  return {
    /**
     * Read: ワークスペース内のファイルを読み込む
     * 最大50,000文字まで返す（大きすぎるファイルは切り詰め）
     */
    Read: tool({
      description: "ワークスペース内のファイルを読み込む。テキストファイルの内容を返す。",
      inputSchema: zodSchema(z.object({
        file_path: z.string().describe("読み込むファイルのパス（ワークスペースからの相対パスまたは絶対パス）"),
      })),
      execute: async (input: { file_path: string }) => {
        try {
          const abs = checkPath(workDir, input.file_path);
          if (!existsSync(abs)) {
            return `Error: ファイルが見つかりません: ${input.file_path}`;
          }
          const content = readFileSync(abs, "utf-8");
          // 大きすぎるファイルは切り詰める
          if (content.length > 50000) {
            return content.slice(0, 50000) + "\n\n...(50,000文字で切り詰めました)";
          }
          return content;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    /**
     * Write: ワークスペース内にファイルを書き込む
     * 親ディレクトリが存在しない場合は自動作成する
     */
    Write: tool({
      description: "ワークスペース内のファイルに内容を書き込む。親ディレクトリは自動作成される。",
      inputSchema: zodSchema(z.object({
        file_path: z.string().describe("書き込むファイルのパス"),
        content: z.string().describe("書き込む内容"),
      })),
      execute: async (input: { file_path: string; content: string }) => {
        try {
          const abs = checkPath(workDir, input.file_path);
          // 親ディレクトリがなければ再帰的に作成
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, input.content, "utf-8");
          return `${input.file_path} に ${input.content.length} 文字を書き込みました`;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    /**
     * Edit: ファイル内の文字列を検索して置換する
     * old_string が見つからない場合はエラーを返す
     */
    Edit: tool({
      description: "ファイル内の文字列を置換して編集する。old_string を new_string に置き換える。",
      inputSchema: zodSchema(z.object({
        file_path: z.string().describe("編集するファイルのパス"),
        old_string: z.string().describe("置換前の文字列（完全一致で検索）"),
        new_string: z.string().describe("置換後の文字列"),
      })),
      execute: async (input: { file_path: string; old_string: string; new_string: string }) => {
        try {
          const abs = checkPath(workDir, input.file_path);
          if (!existsSync(abs)) {
            return `Error: ファイルが見つかりません: ${input.file_path}`;
          }
          const content = readFileSync(abs, "utf-8");
          if (!content.includes(input.old_string)) {
            return `Error: 指定した文字列が ${input.file_path} 内に見つかりませんでした`;
          }
          // 最初の一致のみ置換する
          const newContent = content.replace(input.old_string, input.new_string);
          writeFileSync(abs, newContent, "utf-8");
          return `${input.file_path} を編集しました`;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    /**
     * Glob: ワークスペース内でファイルをパターン検索する
     * node_modules, .git は除外。最大100件まで返す。
     */
    Glob: tool({
      description: "ワークスペース内でファイルをパターン検索する（例: *.ts, src/**/*.js）",
      inputSchema: zodSchema(z.object({
        pattern: z.string().describe("検索パターン（例: *.ts, src/**/*.js）"),
        path: z.string().optional().describe("検索するディレクトリ（省略時はワークスペースルート）"),
      })),
      execute: async (input: { pattern: string; path?: string }) => {
        try {
          const searchDir = input.path ? checkPath(workDir, input.path) : workDir;
          // glob パターンのファイル名部分を抽出して find コマンドに渡す
          const namePattern = input.pattern.replace(/.*\//, "") || input.pattern;
          const result = await exec(
            `find ${JSON.stringify(searchDir)} -name ${JSON.stringify(namePattern)} -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -100`,
            { timeout: 10000 }
          );
          const output = String(result.stdout).trim();
          return output || "ファイルが見つかりませんでした";
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    /**
     * Grep: ワークスペース内でテキストを正規表現検索する
     * node_modules, .git は除外。最大100件まで返す。
     */
    Grep: tool({
      description: "ワークスペース内でテキストを検索する（正規表現対応）",
      inputSchema: zodSchema(z.object({
        pattern: z.string().describe("検索パターン（正規表現可）"),
        path: z.string().optional().describe("検索するファイルまたはディレクトリ（省略時はワークスペースルート）"),
      })),
      execute: async (input: { pattern: string; path?: string }) => {
        try {
          const target = input.path ? checkPath(workDir, input.path) : workDir;
          const result = await exec(
            `grep -rn ${JSON.stringify(input.pattern)} ${JSON.stringify(target)} --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -100`,
            { cwd: workDir, timeout: 10000 }
          );
          const output = String(result.stdout).trim();
          return output || "マッチしませんでした";
        } catch (err: any) {
          // grep はマッチなしでも exit code 1 を返す
          if (err.code === 1) return "マッチしませんでした";
          return `Error: ${err.message}`;
        }
      },
    }),
  };
}
