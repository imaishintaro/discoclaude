/**
 * deploy-commands.ts
 *
 * v2のスラッシュコマンドをDiscordに登録するスクリプト。
 * 実行: npm run deploy-commands（tsc && node dist/deploy-commands.js）
 */

import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "dotenv";

// 環境変数を読み込む
config();

// ========================================
// 必須環境変数のチェック
// ========================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error(
    "エラー: DISCORD_TOKEN と DISCORD_CLIENT_ID を .env に設定してください"
  );
  process.exit(1);
}

// ========================================
// スラッシュコマンドの定義
// ========================================

const commands = [
  // /model — 使用モデルを変更する
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("使用するAIモデルを変更する")
    .addStringOption((option) =>
      option
        .setName("model")
        .setDescription("使用するモデル")
        .setRequired(true)
        .addChoices(
          { name: "Fast（高速・軽量）", value: "fast" },
          { name: "Balanced（バランス型）", value: "balanced" },
          { name: "Powerful（最高性能）", value: "powerful" },
          { name: "Coding（コーディング特化）", value: "coding" }
        )
    ),

  // /clear — セッションをリセットする
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("このチャンネルのセッションをリセットする"),

  // /workspace — ワークスペースを登録する
  new SlashCommandBuilder()
    .setName("workspace")
    .setDescription(
      "ワークスペースを登録してDiscordカテゴリと紐付ける"
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("ワークスペース名")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("directory")
        .setDescription("作業ディレクトリの絶対パス")
        .setRequired(true)
    ),

  // /workspaces — ワークスペース一覧を表示する
  new SlashCommandBuilder()
    .setName("workspaces")
    .setDescription("登録済みワークスペースの一覧を表示する"),

  // /memory — メモリ操作
  new SlashCommandBuilder()
    .setName("memory")
    .setDescription("長期メモリの操作を行う")
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("実行するメモリ操作")
        .setRequired(true)
        .addChoices(
          { name: "view（メモリ一覧を表示）", value: "view" },
          {
            name: "clear-short（短期メモリをクリア）",
            value: "clear-short",
          },
          {
            name: "clear-long（長期メモリをクリア）",
            value: "clear-long",
          },
          { name: "clear-all（全メモリをクリア）", value: "clear-all" }
        )
    ),

  // /cron-list — スケジュールジョブ一覧を表示する
  new SlashCommandBuilder()
    .setName("cron-list")
    .setDescription("登録済みスケジュールジョブの一覧を表示する"),

  // /cron-reload — crontab.yaml を手動で再読み込みする
  new SlashCommandBuilder()
    .setName("cron-reload")
    .setDescription("crontab.yaml を再読み込みしてジョブを更新する"),

  // /help — ヘルプを表示する
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("ボットの使い方とコマンド一覧を表示する"),
].map((command) => command.toJSON());

// ========================================
// コマンドをDiscordに登録する
// ========================================

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(
      `スラッシュコマンドを登録中... (${commands.length}個)`
    );

    // グローバルコマンドとして登録（全サーバーで使用可能）
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
      body: commands,
    });

    // 登録完了メッセージ
    console.log("スラッシュコマンドの登録が完了しました:");
    console.log("  /model        — 使用モデルを変更");
    console.log("  /clear        — セッションをリセット");
    console.log("  /workspace    — ワークスペースを登録");
    console.log("  /workspaces   — ワークスペース一覧");
    console.log("  /memory       — メモリ操作");
    console.log("  /cron-list    — スケジュールジョブ一覧");
    console.log("  /cron-reload  — crontab.yaml 再読み込み");
    console.log("  /help         — ヘルプ表示");
  } catch (error) {
    console.error("コマンド登録エラー:", error);
    process.exit(1);
  }
})();
