/**
 * bash-tool.ts
 * シェルコマンド実行ツール
 *
 * ワークスペース内でbashコマンドを実行する。
 * セキュリティのため、危険なコマンドパターンをブロックし、
 * HOME環境変数をワークスペースに制限する。
 * タイムアウトは30秒。
 *
 * エクスポート: createBashTool(workDir: string)
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { exec as execCb } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb);

/**
 * 実行を禁止するコマンドパターン一覧
 * セキュリティリスクのあるコマンドをブロックする
 */
const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\b/, reason: "権限昇格" },
  { pattern: /\bsu\s/, reason: "ユーザー切り替え" },
  { pattern: /\bchmod\b/, reason: "パーミッション変更" },
  { pattern: /\bchown\b/, reason: "オーナー変更" },
  { pattern: /\brm\s+(-[^\s]*)?-rf?\s+\//, reason: "ルートディレクトリ削除" },
  { pattern: /\brm\s+(-[^\s]*)?-rf?\s+~/, reason: "ホームディレクトリ削除" },
  { pattern: /\bshutdown\b/, reason: "シャットダウン" },
  { pattern: /\breboot\b/, reason: "再起動" },
  { pattern: /\bmkfs\b/, reason: "ディスクフォーマット" },
  { pattern: /\bdd\b\s/, reason: "ディスク書き込み" },
  { pattern: />\s*\/(?!dev\/null)/, reason: "ルート直下への書き込みリダイレクト" },
  { pattern: /\bcurl\b.*\|\s*\bbash\b/, reason: "curl | bash パイプ実行" },
  { pattern: /\bwget\b.*\|\s*\bbash\b/, reason: "wget | bash パイプ実行" },
  { pattern: /\bcurl\b.*\|\s*\bsh\b/, reason: "curl | sh パイプ実行" },
  { pattern: /\bwget\b.*\|\s*\bsh\b/, reason: "wget | sh パイプ実行" },
  { pattern: /\bsystemctl\b/, reason: "systemdサービス操作" },
  { pattern: /\blaunchctl\b/, reason: "macOSサービス操作" },
  { pattern: /\bkillall\b/, reason: "全プロセス停止" },
  { pattern: /\bpasswd\b/, reason: "パスワード変更" },
];

/**
 * コマンドが禁止パターンに一致するか検査する
 * @returns 一致した場合はブロック理由、一致しなければ null
 */
function checkBlockedCommand(command: string): string | null {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

/**
 * Bashツールを生成する
 * @param workDir - ワークスペースディレクトリのパス
 * @returns Vercel AI SDK 用のツールオブジェクト
 */
export function createBashTool(workDir: string) {
  return {
    /**
     * Bash: ワークスペースでシェルコマンドを実行する
     * - 禁止コマンドパターンをチェック
     * - 30秒タイムアウト
     * - HOMEをワークスペースに制限
     * - 出力は最大10,000文字に切り詰め
     */
    Bash: tool({
      description:
        "ワークスペースディレクトリでbashコマンドを実行する。" +
        "ファイル操作、パッケージインストール、ビルド、テスト等に使用する。" +
        "ワークスペース外へのアクセスは禁止。",
      inputSchema: zodSchema(z.object({
        command: z.string().describe("実行するbashコマンド"),
      })),
      execute: async (input: { command: string }) => {
        // 禁止コマンドの検査
        const blockReason = checkBlockedCommand(input.command);
        if (blockReason) {
          return `Error: セキュリティ上の理由でこのコマンドは実行できません（${blockReason}）: ${input.command}`;
        }

        // ワークスペース外へのcdを防ぐため、コマンドをラップ
        const wrappedCommand = `cd "${workDir}" && (${input.command}) 2>&1`;

        try {
          const result = await exec(wrappedCommand, {
            cwd: workDir,
            timeout: 30000, // 30秒タイムアウト
            env: {
              ...process.env,
              HOME: workDir, // HOMEをワークスペースに限定
            },
          });
          const stdout = String(result.stdout || "");
          // 出力が長すぎる場合は切り詰め
          if (stdout.length > 10000) {
            return stdout.slice(0, 10000) + "\n\n...(10,000文字で切り詰めました)";
          }
          return stdout || "(出力なし)";
        } catch (err: any) {
          // コマンド実行エラー時はstdout/stderrも含めて返す
          const stdout = err.stdout ? String(err.stdout) : "";
          const stderr = err.stderr ? String(err.stderr) : "";
          const parts = [
            err.message,
            stdout && `STDOUT: ${stdout}`,
            stderr && `STDERR: ${stderr}`,
          ].filter(Boolean).join("\n");
          return parts.slice(0, 5000);
        }
      },
    }),
  };
}
