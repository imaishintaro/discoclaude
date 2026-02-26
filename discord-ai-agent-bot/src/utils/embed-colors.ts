/**
 * embed-colors.ts
 * Discord Embed カラー定数
 *
 * ボット全体で統一的に使用するEmbed配色を定義する。
 * index.ts と cron-runner.ts で共通利用される。
 *
 * エクスポート: EMBED_COLOR
 */

/** Discord EmbedのカラーHEX定数 */
export const EMBED_COLOR = {
  progress: 0xf59e0b, // 黄色（処理中）
  response: 0x5865f2, // Discord紫（応答）
  error: 0xef4444,    // 赤（エラー）
  info: 0x3b82f6,     // 青（情報）
  success: 0x22c55e,  // 緑（成功）
} as const;
