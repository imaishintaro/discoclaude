/**
 * check-path.ts
 * ワークスペースパス検証ユーティリティ
 *
 * ファイルパスがワークスペースディレクトリ内に収まっていることを検証する。
 * ディレクトリトラバーサル攻撃を防止するために、
 * すべてのツールファイルから共通で使用される。
 *
 * エクスポート: checkPath(workDir: string, p: string): string
 */

import { resolve } from "path";

/**
 * パスがワークスペース内であることを検証し、絶対パスを返す。
 * ワークスペース外へのアクセスはエラーをスローする。
 *
 * @param workDir - ワークスペースディレクトリの絶対パス
 * @param p - 検証するパス（相対パスまたは絶対パス）
 * @returns 解決された絶対パス
 * @throws Error ワークスペース外のパスが指定された場合
 */
export function checkPath(workDir: string, p: string): string {
  const abs = resolve(workDir, p);
  const workDirWithSep = workDir.endsWith("/") ? workDir : workDir + "/";
  if (abs !== workDir && !abs.startsWith(workDirWithSep)) {
    throw new Error(`アクセス拒否: ワークスペース外のパスです (${p})`);
  }
  return abs;
}
