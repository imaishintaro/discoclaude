/**
 * index.ts
 *
 * Discord AIエージェントボットのメインエントリポイント。
 *
 * Discord.jsクライアントを初期化し、以下を統合管理する:
 * - SessionManager: チャット履歴・ワークスペース・モデル設定の管理
 * - MemoryManager: 短期メモリ（SQLite）+ 長期メモリ（JSON）
 * - RouterAgent: メッセージのタスク判定・ルーティング
 * - 専門チーム: CodingTeam / PptTeam / ReportTeam / ImageAgent
 * - CronRunner: YAMLベースのスケジュールジョブ実行
 *
 * v1のindex.tsをベースに、ルーターエージェント経由のマルチエージェント構成に変更。
 */

import {
  AttachmentBuilder,
  CategoryChannel,
  ChannelType,
  Client,
  Collection,
  EmbedBuilder,
  GatewayIntentBits,
  type Interaction,
  type Message,
  Partials,
  type TextChannel,
} from "discord.js";
import { config } from "dotenv";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { resolve, basename, join } from "path";
import { SessionManager } from "./session-manager";
import { MemoryManager } from "./memory-manager";
import { RouterAgent } from "./router-agent";
import { CodingTeam } from "./agents/coding-team";
import { PptTeam } from "./agents/ppt-team";
import { ReportTeam } from "./agents/report-team";
import { ImageAgent } from "./agents/image-agent";
import { CronRunner, describeSchedule } from "./cron-runner";
import { EMBED_COLOR } from "./utils/embed-colors";

// ========================================
// 環境変数の読み込みと検証
// ========================================

// .env ファイルから環境変数を読み込む
config();

// 必須環境変数のチェック
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("エラー: DISCORD_TOKEN が設定されていません");
  process.exit(1);
}

// Claude Code内から起動された場合のネスト実行制限を解除する
delete process.env.CLAUDECODE;

// ========================================
// 設定値
// ========================================

/** デフォルトのAIモデル */
const DEFAULT_MODEL = process.env.MODEL || "anthropic/claude-sonnet-4-20250514";

/** ワークスペースのベースディレクトリ */
const WORK_DIR = resolve(process.env.WORK_DIR || join(__dirname, "..", "workspace"));

/** 使用を許可するDiscordユーザーIDリスト（空の場合は全員許可） */
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((id) => id.trim())
  : [];

/** メンション不要で全メッセージに反応するチャンネルIDリスト */
const AUTO_CHANNELS = process.env.AUTO_CHANNELS
  ? process.env.AUTO_CHANNELS.split(",").map((id) => id.trim())
  : [];

/** エージェント間ログを投稿するチャンネルID（オプション） */
const AGENT_CHAT_CHANNEL_ID = process.env.AGENT_CHAT_CHANNEL_ID || "";

/** Embedのdescription文字数上限（Discord上限は4096） */
const EMBED_MAX_LENGTH = 4000;

/** 添付ファイルのダウンロード先ディレクトリ */
const ATTACHMENTS_DIR = join(WORK_DIR, ".discord-attachments");

/** Discordのファイルアップロード上限（無料サーバー: 25MB） */
const DISCORD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

// ========================================
// コンソールロギング
// ========================================

/** ANSIカラーコード */
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

/**
 * タイムスタンプ付きのカラーログ出力
 */
function log(label: string, color: string, ...args: string[]): void {
  const time = new Date().toLocaleTimeString("ja-JP");
  console.log(
    `${C.gray}[${time}]${C.reset} ${color}${C.bold}${label}${C.reset}`,
    ...args
  );
}

/**
 * ユーザーのメッセージ受信をログ出力
 */
function logUserMessage(
  username: string,
  userId: string,
  channelInfo: string,
  prompt: string
): void {
  log("📨 受信", C.cyan, `${username} (${userId}) @ ${channelInfo}`);
  console.log(
    `${C.gray}   └─ ${C.reset}${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`
  );
}

/**
 * AIの応答をログ出力
 */
function logResponse(responseText: string): void {
  const preview = responseText.slice(0, 200).replace(/\n/g, " ");
  log(
    "💬 応答",
    C.magenta,
    `${preview}${responseText.length > 200 ? "..." : ""}`
  );
}

// ========================================
// APIキー設定の確認ログ
// ========================================

if (process.env.OPENROUTER_API_KEY) {
  console.log("OpenRouter APIを使用します");
} else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
  console.log("Anthropic APIを直接使用します");
} else {
  console.warn(
    "警告: OPENROUTER_API_KEY または ANTHROPIC_API_KEY が設定されていません"
  );
}

// ========================================
// Discord.jsクライアントの初期化
// ========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ========================================
// マネージャー・エージェント初期化
// ========================================

// 4. SessionManager: セッション・ワークスペース・モデル管理
const sessionsPath = join(WORK_DIR, ".sessions.json");
const sessionManager = new SessionManager(sessionsPath);

// 5. MemoryManager: 短期メモリ（JSON）+ 長期メモリ（JSON）
const memoryShortTermPath = join(WORK_DIR, "memory", "short-term.json");
const memoryLongTermPath = join(WORK_DIR, "memory", "long-term.json");
const memoryManager = new MemoryManager(memoryShortTermPath, memoryLongTermPath);
memoryManager.initialize();

// 6. RouterAgent: ルーターエージェント（タスク判定・ルーティング）
const routerAgent = new RouterAgent(sessionManager, memoryManager, {
  defaultWorkDir: WORK_DIR,
  onDelegateTask: handleDelegateTask,
});

// 7. 専門チーム
const codingTeam = new CodingTeam({
  onProgress: (event) => log(`🔧 ${event.agentName}`, C.cyan, `[${event.phase}] ${event.message}`),
});
const pptTeam = new PptTeam({
  onProgress: (event) => log(`📊 ${event.agentName}`, C.cyan, `[${event.phase}] ${event.message}`),
});
const reportTeam = new ReportTeam({
  onProgress: (event) => log(`📝 ${event.agentName}`, C.cyan, `[${event.phase}] ${event.message}`),
});
const imageAgent = new ImageAgent({
  onProgress: (event) => log(`🖼️ ${event.agentName}`, C.cyan, `[${event.phase}] ${event.message}`),
});

// 8. CronRunner: YAMLベースのスケジュールジョブ
const crontabPath = join(WORK_DIR, "cron", "crontab.yaml");
const backlogPath = join(WORK_DIR, "cron", "backlog.yaml");
const cronRunner = new CronRunner(
  crontabPath,
  backlogPath,
  client,
  async (channelId: string, prompt: string): Promise<string> => {
    // CronジョブからのAI実行コールバック
    log("⏰ Cron実行", C.yellow, `channel=${channelId} prompt=${prompt.slice(0, 80)}`);
    const workDir = await sessionManager.resolveWorkDir(channelId, client);
    const result = await routerAgent.processMessage(channelId, prompt, workDir);
    return result.response || "（応答なし）";
  }
);

// ========================================
// ユーティリティ関数
// ========================================

/**
 * 長いテキストをEmbedのdescription上限に収まるように分割する
 */
function splitMessage(text: string, maxLength = EMBED_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 分割ポイントを探す（改行 > スペース > 強制分割）
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * ユーザーがボットの使用を許可されているか確認する
 */
function isUserAllowed(userId: string): boolean {
  if (ALLOWED_USER_IDS.length === 0) return true;
  return ALLOWED_USER_IDS.includes(userId);
}

// ========================================
// Embed ビルダー
// ========================================

/**
 * 処理中の進捗を表すEmbedを作成する
 */
function buildProgressEmbed(description?: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR.progress)
    .setDescription(description || "🤔 考え中...");
}

/**
 * AIの応答を表すEmbedを作成する
 */
function buildResponseEmbed(text: string, footerText?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR.response)
    .setDescription(text);
  if (footerText) embed.setFooter({ text: footerText });
  return embed;
}

/**
 * エラーを表すEmbedを作成する
 */
function buildErrorEmbed(errorMessage: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR.error)
    .setTitle("❌ エラーが発生しました")
    .setDescription(errorMessage);
}

/**
 * ヘルプを表すEmbedを作成する
 */
function buildHelpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR.info)
    .setTitle("Discord AI Agent Bot v2")
    .setDescription(
      "ルーターエージェント + 専門チームによるマルチエージェント構成のAIボットです。\n" +
        "メッセージを送ると、内容に応じて最適なチームが自動で対応します。"
    )
    .addFields(
      {
        name: "スラッシュコマンド",
        value:
          "`/model model:<モデル>` — 使用モデルを変更\n" +
          "`/clear` — セッションをリセット\n" +
          "`/workspace name:<名前> directory:<パス>` — ワークスペースを登録\n" +
          "`/workspaces` — ワークスペース一覧を表示\n" +
          "`/memory action:<操作>` — メモリの操作\n" +
          "`/cron-list` — スケジュールジョブ一覧\n" +
          "`/cron-reload` — crontab.yaml 再読み込み\n" +
          "`/help` — このヘルプを表示",
      },
      {
        name: "対応タスク",
        value:
          "💬 **チャット** — 雑談・質問・相談\n" +
          "💻 **コーディング** — コード作成・修正・デバッグ\n" +
          "📊 **スライド** — PowerPoint作成\n" +
          "📝 **レポート** — レポート・ドキュメント作成\n" +
          "🖼️ **画像** — 画像加工・編集",
      },
      {
        name: "メモリ",
        value:
          "短期メモリ（会話要約）と長期メモリ（好み・作業履歴）を保持します。\n" +
          "`/memory` コマンドで確認・クリアできます。",
      }
    );
}

// ========================================
// OpenRouter Vision API による画像説明
// ========================================

/**
 * OpenRouter の Vision API を直接呼び出して画像を説明させる。
 * OpenRouter 使用時はこの関数で事前に画像をテキスト化する。
 */
async function describeImageViaOpenRouter(imageUrl: string): Promise<string> {
  const model = process.env.MODEL || DEFAULT_MODEL;
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imageUrl } },
              {
                type: "text",
                text: "この画像の内容を詳しく説明してください。テキストが含まれる場合はそのまま引用してください。",
              },
            ],
          },
        ],
        max_tokens: 1024,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenRouter Vision API エラー (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Vision API からの応答が空でした");
  return content;
}

// ========================================
// 添付ファイルのダウンロード処理
// ========================================

/**
 * Discord添付ファイルをローカルにダウンロードする
 */
async function downloadAttachment(
  url: string,
  dir: string,
  filename: string
): Promise<string> {
  // ダウンロードディレクトリが存在しなければ作成
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // ファイル名の衝突を避けるためタイムスタンプを付加
  const timestamp = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = join(dir, `${timestamp}_${safeName}`);

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`ダウンロード失敗: ${response.statusText}`);
  }

  // Node.js ReadableStreamをファイルに書き込む
  const fileStream = createWriteStream(localPath);
  await pipeline(Readable.fromWeb(response.body as any), fileStream);

  return localPath;
}

/**
 * Discordメッセージの添付ファイルを処理してプロンプトに追加テキストを生成する
 */
async function processAttachments(
  attachments: Collection<string, any>,
  attachmentsDir: string
): Promise<{ promptAddition: string; downloadedPaths: string[] }> {
  if (attachments.size === 0) {
    return { promptAddition: "", downloadedPaths: [] };
  }

  const downloadedPaths: string[] = [];
  const promptParts: string[] = [];

  for (const [, attachment] of attachments) {
    try {
      const localPath = await downloadAttachment(
        attachment.url,
        attachmentsDir,
        attachment.name
      );
      downloadedPaths.push(localPath);

      // ファイルの種類に応じてプロンプトを構築
      const ext = attachment.name.split(".").pop()?.toLowerCase() || "";
      const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(
        ext
      );

      if (isImage) {
        if (process.env.OPENROUTER_API_KEY) {
          // OpenRouter使用時: Vision API で事前にテキスト化
          try {
            const description = await describeImageViaOpenRouter(
              attachment.url
            );
            promptParts.push(
              `[添付画像: ${attachment.name}]\n以下は画像の説明です:\n${description}`
            );
          } catch (error) {
            const errMsg =
              error instanceof Error ? error.message : "不明なエラー";
            promptParts.push(
              `[添付画像: ${attachment.name}] 画像説明の取得に失敗しました: ${errMsg}`
            );
          }
        } else {
          // Anthropic直接使用時: パスを参照
          promptParts.push(
            `[添付画像: ${attachment.name}] → ${localPath}`
          );
        }
      } else {
        promptParts.push(
          `[添付ファイル: ${attachment.name}] → ${localPath}\nこのファイルの内容を読んで処理してください。`
        );
      }
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "不明なエラー";
      promptParts.push(
        `[添付ファイル: ${attachment.name}] ダウンロード失敗: ${errorMsg}`
      );
    }
  }

  const promptAddition =
    promptParts.length > 0
      ? "\n\n--- 添付ファイル ---\n" + promptParts.join("\n")
      : "";

  return { promptAddition, downloadedPaths };
}

// ========================================
// タスク委譲ハンドラ
// ========================================

/**
 * ルーターエージェントからのタスク委譲を処理する。
 * 該当する専門チームを非同期で起動し、完了後にDiscordに結果を投稿する。
 *
 * @param taskType       タスクの種類（coding / ppt / report / image）
 * @param taskDescription タスクの説明テキスト
 * @param channelId      結果を投稿するDiscordチャンネルID
 * @returns ユーザーへの即時応答テキスト
 */
async function handleDelegateTask(
  taskType: string,
  taskDescription: string,
  channelId: string
): Promise<string> {
  // ワークスペースのディレクトリを解決
  const workDir = await sessionManager.resolveWorkDir(channelId, client);

  // #agent-chat にログを投稿（設定されている場合）
  if (AGENT_CHAT_CHANNEL_ID) {
    try {
      const agentChatChannel = client.channels.cache.get(
        AGENT_CHAT_CHANNEL_ID
      ) as TextChannel | undefined;
      if (agentChatChannel) {
        const logEmbed = new EmbedBuilder()
          .setColor(EMBED_COLOR.info)
          .setTitle(`🔀 タスク委譲: ${taskType}`)
          .setDescription(
            `**チャンネル:** <#${channelId}>\n**タスク:** ${taskDescription.slice(0, 200)}`
          )
          .setTimestamp();
        await agentChatChannel.send({ embeds: [logEmbed] });
      }
    } catch {
      // エージェントチャットへの投稿失敗は無視
    }
  }

  /**
   * チームの実行結果をDiscordに投稿するヘルパー
   */
  const sendResult = async (result: string) => {
    try {
      const channel = client.channels.cache.get(
        channelId
      ) as TextChannel | undefined;
      if (!channel) return;

      const chunks = splitMessage(result);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const embed = new EmbedBuilder()
          .setColor(EMBED_COLOR.success)
          .setTitle(
            i === 0
              ? `✅ ${taskType}チーム 完了`
              : undefined!
          )
          .setDescription(chunks[i]);
        if (isLast) {
          embed.setFooter({ text: `タスク: ${taskType}` });
        }
        await channel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error(
        `[DelegateTask] 結果の投稿に失敗: channel=${channelId}`,
        err
      );
    }
  };

  /** チーム実行エラーをDiscordに投稿するヘルパー */
  const sendErrorResult = async (err: unknown) => {
    const errMsg = err instanceof Error ? err.message : "不明なエラー";
    try {
      const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
      if (channel) {
        await channel.send({
          embeds: [buildErrorEmbed(`${taskType}チームでエラーが発生しました: ${errMsg}`)],
        });
      }
    } catch {
      // 投稿失敗は無視
    }
  };

  // チームを非同期で起動（結果は完了後にチャンネルに投稿される）
  switch (taskType) {
    case "coding":
      log("🔀 委譲", C.blue, `codingチームにタスクを委譲: ${taskDescription.slice(0, 80)}`);
      codingTeam.execute(taskDescription, workDir)
        .then((r) => sendResult(r.summary))
        .catch(sendErrorResult);
      break;
    case "ppt":
      log("🔀 委譲", C.blue, `pptチームにタスクを委譲: ${taskDescription.slice(0, 80)}`);
      pptTeam.execute(taskDescription, workDir)
        .then((r) => sendResult(r.summary))
        .catch(sendErrorResult);
      break;
    case "report":
      log("🔀 委譲", C.blue, `reportチームにタスクを委譲: ${taskDescription.slice(0, 80)}`);
      reportTeam.execute(taskDescription, workDir)
        .then((r) => sendResult(r.summary))
        .catch(sendErrorResult);
      break;
    case "image":
      log("🔀 委譲", C.blue, `imageAgentにタスクを委譲: ${taskDescription.slice(0, 80)}`);
      imageAgent.execute(taskDescription, workDir)
        .then((r) => sendResult(r.summary))
        .catch(sendErrorResult);
      break;
    default:
      log("⚠️ 不明なタスク", C.yellow, `タスクタイプ "${taskType}" は不明です`);
      return `不明なタスクタイプです: ${taskType}`;
  }

  return `${taskType}チームに作業を依頼しました。完了次第、このチャンネルに結果が投稿されます。`;
}

// ========================================
// 共通の応答送信処理
// ========================================

/**
 * AI応答をEmbed形式でDiscordに送信する共通関数。
 * 4096文字超のテキストは自動で分割して送信する。
 */
async function sendResponse(
  responseText: string,
  channelId: string,
  editFirstMessage: (options: { embeds: EmbedBuilder[] }) => Promise<any>,
  sendToChannel: (options: { embeds: EmbedBuilder[] }) => Promise<any>
): Promise<void> {
  const workspaceName = await sessionManager.resolveWorkspaceName(
    channelId,
    client
  );
  const chunks = splitMessage(responseText);

  // フッターテキストの構築
  const footerParts: string[] = [];
  if (workspaceName && workspaceName !== "default") {
    footerParts.push(`ワークスペース: ${workspaceName}`);
  }
  const footerText = footerParts.join(" | ");

  // 最初のチャンクで元のメッセージを編集
  const firstEmbed = buildResponseEmbed(
    chunks[0],
    chunks.length === 1 ? footerText : undefined
  );
  await editFirstMessage({ embeds: [firstEmbed] });

  // 残りのチャンクを追加送信
  for (let i = 1; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const embed = buildResponseEmbed(
      chunks[i],
      isLast ? footerText : undefined
    );
    await sendToChannel({ embeds: [embed] });
  }
}

// ========================================
// ボット起動時の処理
// ========================================

client.once("ready", () => {
  log("🚀 起動完了", C.green, `${client.user?.tag}`);
  console.log(`  作業ディレクトリ: ${WORK_DIR}`);
  console.log(`  デフォルトモデル: ${DEFAULT_MODEL}`);
  console.log(
    `  許可ユーザー: ${ALLOWED_USER_IDS.length === 0 ? "全員" : ALLOWED_USER_IDS.join(", ")}`
  );
  if (AUTO_CHANNELS.length > 0) {
    console.log(`  自動応答チャンネル: ${AUTO_CHANNELS.join(", ")}`);
  }

  // CronRunner を起動
  cronRunner.start();

  // models.json からモデル設定を読み込んでログ出力
  try {
    const modelsPath = join(__dirname, "..", "config", "models.json");
    if (existsSync(modelsPath)) {
      const models = JSON.parse(readFileSync(modelsPath, "utf-8"));
      console.log(`  モデル設定: ${modelsPath}`);
      console.log(`    デフォルト: ${models.default || DEFAULT_MODEL}`);
    }
  } catch {
    // models.json の読み込み失敗は無視
  }

  // agents.json からエージェント設定を読み込んでログ出力
  try {
    const agentsPath = join(__dirname, "..", "config", "agents.json");
    if (existsSync(agentsPath)) {
      const agents = JSON.parse(readFileSync(agentsPath, "utf-8"));
      log("🐾 エージェント", C.cyan, `ルーター: ${agents.router?.name || "不明"}`);
    }
  } catch {
    // agents.json の読み込み失敗は無視
  }
});

// ========================================
// スラッシュコマンドの処理
// ========================================

client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;

  // 権限チェック
  if (!isUserAllowed(userId)) {
    await interaction.reply({
      embeds: [buildErrorEmbed("このボットを使用する権限がありません。")],
      ephemeral: true,
    });
    return;
  }

  const { commandName } = interaction;

  // /help — ヘルプ表示
  if (commandName === "help") {
    await interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true });
    return;
  }

  // /clear — セッションリセット
  if (commandName === "clear") {
    // チャット履歴をクリア
    sessionManager.clearHistory(interaction.channelId);

    // 短期メモリもクリア
    memoryManager.clearShortTermMemory(interaction.channelId);

    const clearEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.success)
      .setDescription(
        "✅ セッションをクリアしました。新しい会話を始められます。"
      );
    await interaction.reply({ embeds: [clearEmbed] });
    return;
  }

  // /model — モデル変更
  if (commandName === "model") {
    const modelKey = interaction.options.getString("model", true);

    // models.json からモデルIDを解決
    let modelId = modelKey;
    try {
      const modelsPath = join(__dirname, "..", "config", "models.json");
      if (existsSync(modelsPath)) {
        const modelsConfig = JSON.parse(readFileSync(modelsPath, "utf-8"));
        if (modelsConfig.options && modelsConfig.options[modelKey]) {
          modelId = modelsConfig.options[modelKey];
        }
      }
    } catch {
      // models.json の読み込み失敗時はキーをそのまま使う
    }

    sessionManager.setModel(interaction.channelId, modelId);

    const modelEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.success)
      .setDescription(
        `✅ モデルを **${modelKey}** (\`${modelId}\`) に変更しました。\n次のメッセージからこのモデルが使用されます。`
      );
    await interaction.reply({ embeds: [modelEmbed] });
    return;
  }

  // /workspace — ワークスペース登録
  if (commandName === "workspace") {
    const name = interaction.options.getString("name", true);
    const directory = interaction.options.getString("directory", true);

    // ディレクトリの存在チェック
    if (!existsSync(directory)) {
      await interaction.reply({
        embeds: [
          buildErrorEmbed(`ディレクトリが存在しません: \`${directory}\``),
        ],
        ephemeral: true,
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        embeds: [
          buildErrorEmbed("このコマンドはサーバー内でのみ使用できます。"),
        ],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      // 既存のカテゴリを検索、なければ作成
      let category = guild.channels.cache.find(
        (ch): ch is CategoryChannel =>
          ch.type === ChannelType.GuildCategory && ch.name === `🤖 ${name}`
      );

      if (!category) {
        category = await guild.channels.create({
          name: `🤖 ${name}`,
          type: ChannelType.GuildCategory,
        });
      }

      // カテゴリ配下にデフォルトチャンネルがなければ作成
      const existingChannels = guild.channels.cache.filter(
        (ch) => ch.parentId === category!.id
      );
      if (existingChannels.size === 0) {
        await guild.channels.create({
          name: "general",
          type: ChannelType.GuildText,
          parent: category,
        });
      }

      // ワークスペースを登録
      sessionManager.registerWorkspace(name, directory, category.id);

      const wsEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR.success)
        .setTitle(`✅ ワークスペース登録: ${name}`)
        .setDescription(
          "このカテゴリ内のチャンネルでの操作は自動的にこのディレクトリで実行されます。"
        )
        .addFields(
          {
            name: "📁 ディレクトリ",
            value: `\`${directory}\``,
            inline: true,
          },
          { name: "📂 カテゴリ", value: category.name, inline: true }
        );
      await interaction.editReply({ embeds: [wsEmbed] });
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "不明なエラー";
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(`ワークスペースの作成に失敗: ${errorMsg}`),
        ],
      });
    }
    return;
  }

  // /workspaces — ワークスペース一覧
  if (commandName === "workspaces") {
    const workspaces = sessionManager.getWorkspaces();
    if (workspaces.length === 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLOR.info)
            .setDescription(
              "登録されたワークスペースはありません。\n`/workspace` で登録してください。"
            ),
        ],
        ephemeral: true,
      });
      return;
    }

    const wsListEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.info)
      .setTitle("ワークスペース一覧")
      .addFields(
        workspaces.map((ws) => ({
          name: ws.name,
          value: `\`${ws.directory}\``,
        }))
      );
    await interaction.reply({ embeds: [wsListEmbed], ephemeral: true });
    return;
  }

  // /memory — メモリ操作
  if (commandName === "memory") {
    const action = interaction.options.getString("action", true);

    switch (action) {
      case "view": {
        // 短期メモリの取得
        const shortTermMemories = memoryManager.getShortTermMemories(
          interaction.channelId,
          5
        );
        const longTermMemory = memoryManager.getLongTermMemory();

        const fields: { name: string; value: string }[] = [];

        // 短期メモリ表示
        if (shortTermMemories.length > 0) {
          const stText = shortTermMemories
            .map(
              (m) =>
                `[${m.created_at}] ${m.summary.slice(0, 100)}${m.summary.length > 100 ? "..." : ""}`
            )
            .join("\n");
          fields.push({
            name: "📝 短期メモリ（会話要約）",
            value: stText.slice(0, 1024),
          });
        } else {
          fields.push({
            name: "📝 短期メモリ（会話要約）",
            value: "なし",
          });
        }

        // 長期メモリ表示
        const prefCount = Object.keys(longTermMemory.preferences).length;
        const histCount = longTermMemory.work_history.length;
        const noteCount = longTermMemory.user_notes.length;
        fields.push({
          name: "💾 長期メモリ",
          value: `好み: ${prefCount}件 | 作業履歴: ${histCount}件 | ノート: ${noteCount}件`,
        });

        const memoryEmbed = new EmbedBuilder()
          .setColor(EMBED_COLOR.info)
          .setTitle("🧠 メモリ状態")
          .addFields(fields);
        await interaction.reply({
          embeds: [memoryEmbed],
          ephemeral: true,
        });
        break;
      }
      case "clear-short":
        memoryManager.clearShortTermMemory(interaction.channelId);
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLOR.success)
              .setDescription(
                "✅ このチャンネルの短期メモリをクリアしました。"
              ),
          ],
        });
        break;
      case "clear-long":
        memoryManager.clearLongTermMemory();
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLOR.success)
              .setDescription("✅ 長期メモリをクリアしました。"),
          ],
        });
        break;
      case "clear-all":
        memoryManager.clearShortTermMemory(interaction.channelId);
        memoryManager.clearLongTermMemory();
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLOR.success)
              .setDescription(
                "✅ 短期メモリ・長期メモリをすべてクリアしました。"
              ),
          ],
        });
        break;
      default:
        await interaction.reply({
          embeds: [buildErrorEmbed(`不明なアクション: ${action}`)],
          ephemeral: true,
        });
    }
    return;
  }

  // /cron-list — ジョブ一覧表示
  if (commandName === "cron-list") {
    const jobs = cronRunner.getJobs();
    if (jobs.length === 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLOR.info)
            .setDescription(
              "ジョブが登録されていません。\n`workspace/cron/crontab.yaml` を作成してください。"
            ),
        ],
        ephemeral: true,
      });
      return;
    }

    const cronListEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.info)
      .setTitle("⏰ スケジュールジョブ一覧")
      .addFields(
        jobs.map((job) => ({
          name: `${job.enabled ? "✅" : "⏸️"} ${job.description || job.id || "（名称なし）"}`,
          value:
            `${describeSchedule(job)}\n` +
            `📢 <#${job.channel_id}>\n` +
            `💬 ${job.prompt.slice(0, 60)}${job.prompt.length > 60 ? "..." : ""}`,
        }))
      );
    await interaction.reply({
      embeds: [cronListEmbed],
      ephemeral: true,
    });
    return;
  }

  // /cron-reload — crontab.yaml 再読み込み
  if (commandName === "cron-reload") {
    cronRunner.reload();
    const jobs = cronRunner.getJobs();
    const enabled = jobs.filter((j) => j.enabled).length;
    const reloadEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.success)
      .setDescription(
        `✅ crontab.yaml を再読み込みしました。\n有効なジョブ: **${enabled}件** / 全${jobs.length}件`
      );
    await interaction.reply({ embeds: [reloadEmbed] });
    return;
  }
});

// ========================================
// メッセージイベントの処理
// ========================================

client.on("messageCreate", async (message: Message) => {
  // Botメッセージは無視
  if (message.author.bot) return;

  const content = message.content.trim();

  // ========================================
  // メッセージの判定: メンション or DM or AUTO_CHANNELSで反応
  // ========================================

  const mentionPrefix = `<@${client.user?.id}>`;
  const isDM = !message.guild;
  const isAutoChannel = AUTO_CHANNELS.includes(message.channelId);
  let prompt = "";

  if (isDM || isAutoChannel) {
    // DM・指定チャンネルは全文をプロンプトとして使う
    prompt = content;
  } else if (content.startsWith(mentionPrefix)) {
    // メンションで始まるメッセージ
    prompt = content.slice(mentionPrefix.length).trim();
  } else {
    // 上記のいずれにも該当しない場合は無視
    return;
  }

  // 権限チェック
  if (!isUserAllowed(message.author.id)) {
    await message.reply({
      embeds: [buildErrorEmbed("このボットを使用する権限がありません。")],
    });
    return;
  }

  // プロンプトが空で添付もない場合
  if (!prompt && message.attachments.size === 0) {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR.info)
          .setDescription(
            "メッセージを入力してください。メンションまたはDMで話しかけてくださいね。"
          ),
      ],
    });
    return;
  }

  // ========================================
  // ユーザーメッセージのログ出力
  // ========================================

  const channelInfo = isDM
    ? "DM"
    : isAutoChannel && "name" in message.channel
      ? `#${(message.channel as any).name} [auto]`
      : "name" in message.channel
        ? `#${(message.channel as any).name}`
        : message.channelId;
  logUserMessage(
    message.author.username,
    message.author.id,
    channelInfo,
    prompt
  );

  // ========================================
  // 添付ファイルの処理
  // ========================================

  const workDir = await sessionManager.resolveWorkDir(
    message.channelId,
    client
  );
  const attachDir = join(workDir, ".discord-attachments");
  const { promptAddition } = await processAttachments(
    message.attachments,
    attachDir
  );
  const fullPrompt = prompt + promptAddition;

  // ========================================
  // 進捗Embed送信（処理中表示）
  // ========================================

  const thinkingMessage = await message.reply({
    embeds: [buildProgressEmbed()],
  });

  try {
    // ========================================
    // ルーターエージェント経由でメッセージを処理
    // ========================================

    const routerResult = await routerAgent.processMessage(
      message.channelId,
      fullPrompt,
      workDir
    );
    let responseText = routerResult.response || "（応答なし）";

    // タスク委譲がある場合、委譲メッセージを追加
    if (routerResult.delegatedTask) {
      const delegateMsg = await handleDelegateTask(
        routerResult.delegatedTask.taskType,
        routerResult.delegatedTask.taskDescription,
        message.channelId
      );
      responseText = responseText + "\n\n" + delegateMsg;
    }

    logResponse(responseText);

    // 応答をEmbed形式で表示
    await sendResponse(
      responseText,
      message.channelId,
      (options) => thinkingMessage.edit(options),
      (options) => (message.channel as TextChannel).send(options)
    );
  } catch (error) {
    // エラーハンドリング
    const errorMessage =
      error instanceof Error ? error.message : "不明なエラー";
    log("❌ エラー", C.red, errorMessage);
    console.error(error);
    await thinkingMessage.edit({ embeds: [buildErrorEmbed(errorMessage)] });
  }
});

// ========================================
// プロセスの終了処理
// ========================================

// graceful shutdown
process.on("SIGINT", () => {
  log("🛑 終了", C.red, "SIGINT を受信しました。シャットダウンします...");
  cronRunner.stop();
  memoryManager.close();
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("🛑 終了", C.red, "SIGTERM を受信しました。シャットダウンします...");
  cronRunner.stop();
  memoryManager.close();
  client.destroy();
  process.exit(0);
});

// ========================================
// ボットを起動
// ========================================

client.login(DISCORD_TOKEN);
