import {
  AttachmentBuilder,
  CategoryChannel,
  ChannelType,
  Client,
  Collection,
  EmbedBuilder,
  GatewayIntentBits,
  type GuildBasedChannel,
  type Interaction,
  type Message,
  Partials,
  type TextChannel,
} from "discord.js";
import { config } from "dotenv";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { createWriteStream, existsSync, mkdirSync, statSync } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { resolve, basename, join } from "path";
import { ClaudeSessionManager, type ProgressEvent } from "./claude-session";
import { CronRunner, describeSchedule } from "./cron-runner";
import { CodingAgentService } from "./multi-agent";

const exec = promisify(execCb);

// 環境変数を読み込む
config();

// 必須環境変数のチェック
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("エラー: DISCORD_TOKEN が設定されていません");
  process.exit(1);
}

// Claude Code内から起動された場合のネスト実行制限を解除する
// （このボット自体をClaude Codeセッション内で起動した場合に必要）
delete process.env.CLAUDECODE;

// APIキー設定の確認ログ
// OPENROUTER_API_KEY: OpenRouter経由でどのモデルでも使用可能
// ANTHROPIC_API_KEY: Anthropic直接（Pro/Maxプランのみ）
if (process.env.OPENROUTER_API_KEY) {
  console.log("OpenRouter APIを使用します（Vercel AI SDK経由）");
} else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
  console.log("Anthropic APIを直接使用します（Vercel AI SDK経由）");
} else {
  console.warn("警告: OPENROUTER_API_KEY または ANTHROPIC_API_KEY が設定されていません");
}

// 設定値
const DEFAULT_MODEL = process.env.MODEL || "claude-sonnet-4-20250514";
// WORK_DIR: 相対パスの場合はプロジェクトルートからの絶対パスに変換
const WORK_DIR = resolve(process.env.WORK_DIR || process.cwd());
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((id) => id.trim())
  : [];

// メンション不要で全メッセージに反応するチャンネルIDのリスト
const AUTO_CHANNELS = process.env.AUTO_CHANNELS
  ? process.env.AUTO_CHANNELS.split(",").map((id) => id.trim())
  : [];

// Embedのdescription文字数上限（Discord上限は4096）
const EMBED_MAX_LENGTH = 4000;

// Embedカラー定義
const EMBED_COLOR = {
  progress: 0xf59e0b, // アンバー（処理中）
  response: 0x5865f2, // ブランドパープル（応答）
  error: 0xef4444,    // 赤（エラー）
  info: 0x3b82f6,     // 青（情報）
  success: 0x22c55e,  // 緑（成功）
} as const;

// ボットへのプレフィックス（従来方式も維持）
const PREFIX = "!claude";

// 添付ファイルのダウンロード先ディレクトリ
const ATTACHMENTS_DIR = join(WORK_DIR, ".discord-attachments");

// セッションマネージャーの初期化
const sessionManager = new ClaudeSessionManager(WORK_DIR, DEFAULT_MODEL);

// Discordクライアントの初期化
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Cronランナーの初期化（クライアント準備後に start() を呼ぶ）
const cronRunner = new CronRunner(WORK_DIR, sessionManager, client);

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

// Discordのファイルアップロード上限（無料サーバー: 25MB）
const DISCORD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

/**
 * レスポンステキストからファイルパスを抽出し、実在するファイルのみ返す
 */
function extractAttachableFiles(text: string, workDir: string): string[] {
  const filePaths = new Set<string>();

  const backtickPattern = /`([^`\s]+\.[a-zA-Z0-9]+)`/g;
  let match;
  while ((match = backtickPattern.exec(text)) !== null) {
    filePaths.add(match[1]);
  }

  const validFiles: string[] = [];
  for (const filePath of filePaths) {
    const absolutePath = resolve(workDir, filePath);
    try {
      if (!existsSync(absolutePath)) continue;
      const stats = statSync(absolutePath);
      if (!stats.isFile()) continue;
      if (stats.size > DISCORD_FILE_SIZE_LIMIT) continue;
      if (stats.size === 0) continue;
      validFiles.push(absolutePath);
    } catch {
      continue;
    }
  }

  return validFiles;
}

/**
 * ユーザーがボットの使用を許可されているか確認する
 */
function isUserAllowed(userId: string): boolean {
  if (ALLOWED_USER_IDS.length === 0) return true;
  return ALLOWED_USER_IDS.includes(userId);
}

/**
 * ツール名を日本語の表示名に変換する
 */
function toolDisplayName(toolName: string): string {
  const names: Record<string, string> = {
    Bash: "コマンド実行",
    Read: "ファイル読み込み",
    Write: "ファイル書き込み",
    Edit: "ファイル編集",
    Glob: "ファイル検索",
    Grep: "テキスト検索",
    WebFetch: "Web取得",
    WebSearch: "Web検索",
    ConsultCodingAgent: "コーディングエージェント相談",
    Task: "サブタスク",
    TodoWrite: "タスク管理",
  };
  return names[toolName] || toolName;
}

// ========================================
// Embed ビルダー
// ========================================

/**
 * 処理中の進捗を表すEmbedを作成する
 * 文字数上限を超えた場合は古い行から削る
 */
function buildProgressEmbed(logLines: string[]): EmbedBuilder {
  const lines = [...logLines];
  let desc = lines.join("\n");
  while (desc.length > EMBED_MAX_LENGTH && lines.length > 1) {
    lines.shift();
    desc = lines.join("\n");
  }
  return new EmbedBuilder()
    .setColor(EMBED_COLOR.progress)
    .setDescription(desc || "考え中...");
}

/**
 * Claudeの応答を表すEmbedを作成する
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
    .setTitle("Discord Claude Code Bot")
    .setDescription(
      "Claude Codeの機能をDiscordから利用できます。\n" +
      "ファイルの読み書き、コード生成、Git操作などが可能です。"
    )
    .addFields(
      {
        name: "スラッシュコマンド",
        value:
          "`/claude prompt:<メッセージ>` — Claude Codeにメッセージを送る\n" +
          "`/claude-clear` — セッションをリセット\n" +
          "`/claude-model model:<モデル>` — モデルを変更\n" +
          "`/claude-workspace name:<名前> directory:<パス>` — ワークスペースを登録\n" +
          "`/claude-workspaces` — ワークスペース一覧を表示\n" +
          "`/claude-help` — このヘルプを表示",
      },
      {
        name: "プレフィックス方式（従来互換）",
        value:
          `\`${PREFIX} <メッセージ>\` — Claude Codeにメッセージを送る\n` +
          `\`${PREFIX} clear\` — セッションをリセット\n` +
          `\`${PREFIX} help\` — このヘルプを表示`,
      },
      {
        name: "添付ファイル",
        value: "メッセージに画像やファイルを添付すると、Claudeに渡されます。",
      },
      {
        name: "ワークスペース",
        value: "カテゴリ内のチャンネルは自動的にワークスペースのディレクトリで作業します。",
      },
      {
        name: "進捗通知",
        value: "処理中はツール実行状況がリアルタイムで表示されます。",
      },
    );
}

// ========================================
// OpenRouter Vision API による画像説明
// ========================================

/**
 * OpenRouter の Vision API を直接呼び出して画像を説明させる。
 * Claude Code SDK 経由では画像フォーマットが変換されない場合があるため、
 * OpenRouter 使用時はこの関数で事前に画像をテキスト化する。
 */
async function describeImageViaOpenRouter(imageUrl: string): Promise<string> {
  const model = process.env.MODEL || DEFAULT_MODEL;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
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
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter Vision API エラー (${response.status}): ${body}`);
  }

  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Vision API からの応答が空でした");
  return content;
}

// ========================================
// 添付ファイルのダウンロード処理
// ========================================

/**
 * Discord添付ファイルをローカルにダウンロードする
 * ダウンロードしたファイルのパスを返す
 */
async function downloadAttachment(
  url: string,
  filename: string
): Promise<string> {
  // ダウンロードディレクトリが存在しなければ作成
  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }

  // ファイル名の衝突を避けるためタイムスタンプを付加
  const timestamp = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = join(ATTACHMENTS_DIR, `${timestamp}_${safeName}`);

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
 * Discordメッセージの添付ファイルを処理してプロンプトに追加する
 * 画像はパスを参照、テキストファイルは内容も含める
 */
async function processAttachments(
  attachments: Collection<string, any>
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
        attachment.name
      );
      downloadedPaths.push(localPath);

      // ファイルの種類に応じてプロンプトを構築
      const ext = attachment.name.split(".").pop()?.toLowerCase() || "";
      const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);

      if (isImage) {
        if (process.env.OPENROUTER_API_KEY) {
          // OpenRouter使用時: Claude Code SDK では画像フォーマットが変換されず
          // サードパーティモデルに画像が届かない問題がある。
          // そのため OpenRouter Vision API を直接叩いて事前にテキスト化する。
          try {
            const description = await describeImageViaOpenRouter(attachment.url);
            promptParts.push(
              `[添付画像: ${attachment.name}]\n以下は画像の説明です:\n${description}`
            );
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : "不明なエラー";
            promptParts.push(
              `[添付画像: ${attachment.name}] 画像説明の取得に失敗しました: ${errMsg}`
            );
          }
        } else {
          // Anthropic（Claude Code）使用時: Readツールで直接画像を読める
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
// 進捗通知ヘルパー
// ========================================

/**
 * Discordメッセージをリアルタイム進捗でEmbedを使って更新する
 * ログを積み上げて表示し、レート制限を避けるため最低2秒間隔で更新する
 * finish() を呼ぶと以降の更新をキャンセルする（最終応答の上書き防止）
 */
function createProgressUpdater(
  editFn: (options: { embeds: EmbedBuilder[] }) => Promise<any>
): { handler: (event: ProgressEvent) => void; finish: () => Promise<void> } {
  let done = false;
  let lastUpdateTime = 0;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
  const UPDATE_INTERVAL_MS = 2000;
  // 積み上げるログ行
  const logLines: string[] = ["考え中..."];

  // すべてのeditFn呼び出しをこのチェーンで直列化する。
  // これにより「進捗Embedの更新」と「最終応答の書き込み」の順序が保証される。
  let editChain: Promise<void> = Promise.resolve();

  const scheduleEdit = () => {
    editChain = editChain.then(async () => {
      if (done) return;
      try { await editFn({ embeds: [buildProgressEmbed(logLines)] }); } catch { /* 無視 */ }
    });
  };

  const doUpdate = () => {
    if (done) return;
    const now = Date.now();
    const elapsed = now - lastUpdateTime;
    if (elapsed >= UPDATE_INTERVAL_MS) {
      // レート制限内: 即座に更新をスケジュール
      lastUpdateTime = now;
      if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }
      scheduleEdit();
    } else if (!pendingTimeout) {
      // レート制限中: 残り時間後に更新
      pendingTimeout = setTimeout(() => {
        pendingTimeout = null;
        if (done) return;
        lastUpdateTime = Date.now();
        scheduleEdit();
      }, UPDATE_INTERVAL_MS - elapsed);
    }
  };

  const handler = (event: ProgressEvent) => {
    if (done) return;
    switch (event.type) {
      case "assistant_text": {
        const preview = event.text.slice(0, 200).replace(/\n/g, " ");
        logLines.push(`💭 ${preview}${event.text.length > 200 ? "..." : ""}`);
        doUpdate();
        break;
      }
      case "tool_call": {
        const inputStr = formatToolInput(event.toolName, event.input);
        logLines.push(`⏺ **${event.toolName}**(${inputStr})`);
        doUpdate();
        break;
      }
      case "tool_result": {
        const lines = event.output.split("\n").slice(0, 3).join(" / ");
        const more = event.output.split("\n").length > 3
          ? ` (+${event.output.split("\n").length - 3}行)` : "";
        const icon = event.isError ? "⎿ Error:" : "⎿";
        logLines.push(`  ${icon} ${lines}${more}`);
        doUpdate();
        break;
      }
      case "tool_progress":
        logLines.push(`⏳ **${toolDisplayName(event.toolName)}** 実行中... (${Math.floor(event.elapsedSeconds)}秒)`);
        doUpdate();
        break;
      case "tool_summary":
        logLines.push(`✅ ${event.summary}`);
        doUpdate();
        break;
      case "task_started":
        logLines.push(`🔄 サブタスク: ${event.description}`);
        doUpdate();
        break;
      case "task_completed":
        logLines.push(
          event.status === "completed"
            ? `✅ 完了: ${event.summary}`
            : `❌ ${event.status}: ${event.summary}`
        );
        doUpdate();
        break;
    }
  };

  // done = true にし、飛んでいるeditFnが完了するまで待ってから返す。
  // これにより呼び出し元は await finish() 後に安全に最終応答を書き込める。
  const finish = async () => {
    done = true;
    if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }
    await editChain;
  };

  return { handler, finish };
}

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
 * タイムスタンプ付きのログ出力
 */
function log(label: string, color: string, ...args: string[]): void {
  const time = new Date().toLocaleTimeString("ja-JP");
  console.log(`${C.gray}[${time}]${C.reset} ${color}${C.bold}${label}${C.reset}`, ...args);
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
  console.log(`${C.gray}   └─ ${C.reset}${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`);
}

/**
 * Claudeの進捗イベントをログ出力
 */
function logProgress(event: ProgressEvent): void {
  switch (event.type) {
    case "assistant_text": {
      const preview = event.text.slice(0, 300).replace(/\n/g, " ");
      log("🤔 Claude", C.blue, `${preview}${event.text.length > 300 ? "..." : ""}`);
      break;
    }
    case "tool_call": {
      // ⏺ Bash(git status) のような形式で表示
      const inputStr = formatToolInput(event.toolName, event.input);
      console.log(`${C.green}⏺ ${event.toolName}${C.reset}(${C.gray}${inputStr}${C.reset})`);
      break;
    }
    case "tool_result": {
      // ⎿ 結果 の形式で表示
      const icon = event.isError ? `${C.red}⎿ Error:${C.reset}` : `${C.gray}⎿ ${C.reset}`;
      const lines = event.output.split("\n").slice(0, 5); // 最大5行
      const more = event.output.split("\n").length > 5 ? ` ... (+${event.output.split("\n").length - 5}行)` : "";
      console.log(`  ${icon} ${lines.join("\n     ")}${more}`);
      break;
    }
    case "tool_progress":
      log("🔧 実行中", C.yellow,
        `${toolDisplayName(event.toolName)} (${Math.floor(event.elapsedSeconds)}秒経過)`
      );
      break;
    case "tool_summary":
      log("✅ 完了", C.green, event.summary);
      break;
    case "task_started":
      log("🔄 サブタスク", C.blue, event.description);
      break;
    case "task_completed": {
      const icon = event.status === "completed" ? "✅" : "❌";
      log(`${icon} タスク完了`, event.status === "completed" ? C.green : C.red,
        `[${event.status}] ${event.summary}`
      );
      break;
    }
  }
}

/**
 * ツールの入力パラメータを簡潔な文字列に変換する
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  // ツールごとに主要なパラメータを抽出
  switch (toolName) {
    case "Bash":
      return String(input.command || "").slice(0, 100);
    case "Read":
      return String(input.file_path || "");
    case "Write":
      return String(input.file_path || "");
    case "Edit":
      return String(input.file_path || "");
    case "Glob":
      return String(input.pattern || "");
    case "Grep":
      return `"${String(input.pattern || "")}"`;
    case "WebFetch":
      return String(input.url || "").slice(0, 80);
    case "WebSearch":
      return String(input.query || "").slice(0, 80);
    case "ConsultCodingAgent":
      return String(input.task || "").slice(0, 80);
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}

/**
 * Claudeの応答をログ出力
 */
function logResponse(responseText: string): void {
  const preview = responseText.slice(0, 200).replace(/\n/g, " ");
  log("💬 応答", C.magenta, `${preview}${responseText.length > 200 ? "..." : ""}`);
}

// ========================================
// 共通の応答送信処理
// ========================================

/**
 * ClaudeCodeの応答結果をDiscord Embedで送信する共通関数
 */
async function sendResponse(
  responseText: string,
  channelId: string,
  editFirstMessage: (options: { embeds: EmbedBuilder[] }) => Promise<any>,
  sendToChannel: (options: { embeds: EmbedBuilder[] }) => Promise<any>,
  sendFilesToChannel: (files: AttachmentBuilder[]) => Promise<any>
): Promise<void> {
  const workDir = sessionManager.resolveWorkDir(channelId);
  const workspaceName = sessionManager.resolveWorkspaceName(channelId);
  const chunks = splitMessage(responseText);

  // ファイル添付の準備
  const attachableFiles = extractAttachableFiles(responseText, workDir);
  const attachments = attachableFiles.map(
    (filePath) => new AttachmentBuilder(filePath, { name: basename(filePath) })
  );

  // フッターテキストの構築
  const footerParts: string[] = [];
  if (attachableFiles.length > 0) {
    footerParts.push(`添付: ${attachableFiles.map((f) => basename(f)).join(", ")}`);
  }
  if (workspaceName) {
    footerParts.push(`ワークスペース: ${workspaceName}`);
  }
  const footerText = footerParts.join(" | ");

  // 最初のチャンクで元のメッセージを編集
  const firstEmbed = buildResponseEmbed(chunks[0], chunks.length === 1 ? footerText : undefined);
  await editFirstMessage({ embeds: [firstEmbed] });

  // 残りのチャンクを追加送信
  for (let i = 1; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const embed = buildResponseEmbed(chunks[i], isLast ? footerText : undefined);
    await sendToChannel({ embeds: [embed] });
  }

  // 添付ファイルがあれば送信
  if (attachments.length > 0) {
    await sendFilesToChannel(attachments);
  }
}

// ========================================
// ボット起動時の処理
// ========================================

client.once("ready", () => {
  console.log(`ボットが起動しました: ${client.user?.tag}`);
  console.log(`作業ディレクトリ: ${WORK_DIR}`);
  console.log(`デフォルトモデル: ${DEFAULT_MODEL}`);
  console.log(
    `許可ユーザー: ${ALLOWED_USER_IDS.length === 0 ? "全員" : ALLOWED_USER_IDS.join(", ")}`
  );

  // Cronスケジューラーを起動
  cronRunner.start();

  // マルチエージェント: AGENT_CHAT_CHANNEL_ID が設定されていればコーディングエージェントを有効化
  const agentChatChannelId = process.env.AGENT_CHAT_CHANNEL_ID;
  if (agentChatChannelId) {
    const codingAgent = new CodingAgentService(DEFAULT_MODEL, client, agentChatChannelId);
    sessionManager.setCodingAgent(codingAgent);
    const codingModel = process.env.CODING_AGENT_MODEL || DEFAULT_MODEL;
    console.log(`[MultiAgent] コーディングエージェント有効 → チャンネルID: ${agentChatChannelId}, モデル: ${codingModel}`);
  }

  // メモリファイルの変更を監視してエンベディングを自動更新
  sessionManager.startMemoryWatcher();

  // システムプロンプトの読み込み元を表示
  const identifyMdPath = `${WORK_DIR}/identify.md`;
  const contextMdPath  = `${WORK_DIR}/context.md`;
  const hasIdentify = existsSync(identifyMdPath);
  const hasContext  = existsSync(contextMdPath);
  if (hasIdentify || hasContext) {
    if (hasIdentify) console.log(`システムプロンプト: identify.md (性格・口調)`);
    if (hasContext)  console.log(`システムプロンプト: context.md  (プロジェクト情報)`);
  } else if (process.env.SYSTEM_PROMPT) {
    console.log(`システムプロンプト: 環境変数 SYSTEM_PROMPT を使用`);
  } else {
    console.log(`システムプロンプト: 未設定`);
  }
});

// ========================================
// スラッシュコマンドの処理
// ========================================

client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;

  if (!isUserAllowed(userId)) {
    await interaction.reply({
      embeds: [buildErrorEmbed("このボットを使用する権限がありません。")],
      ephemeral: true,
    });
    return;
  }

  const { commandName } = interaction;

  // /claude-help
  if (commandName === "claude-help") {
    await interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true });
    return;
  }

  // /claude-clear
  if (commandName === "claude-clear") {
    const { cleared, savedFile } = await sessionManager.clearSession(interaction.channelId);
    const memoryNote = savedFile ? `\n💾 会話履歴を \`${savedFile}\` に保存しました。` : "";
    const clearEmbed = new EmbedBuilder()
      .setColor(cleared ? EMBED_COLOR.success : EMBED_COLOR.info)
      .setDescription(
        cleared
          ? `✅ セッションをクリアしました。新しい会話を始められます。${memoryNote}`
          : "このチャンネルにはアクティブなセッションがありません。"
      );
    await interaction.reply({ embeds: [clearEmbed] });
    return;
  }

  // /claude-model
  if (commandName === "claude-model") {
    const model = interaction.options.getString("model", true);
    sessionManager.setModel(interaction.channelId, model);

    // よく使うモデルの表示名（未登録の場合はモデルIDをそのまま表示）
    const modelNames: Record<string, string> = {
      "anthropic/claude-sonnet-4-20250514": "Claude Sonnet 4 (高速・バランス型)",
      "anthropic/claude-opus-4-20250514": "Claude Opus 4 (最高性能)",
      "anthropic/claude-haiku-4-5-20251001": "Claude Haiku 4.5 (最速・軽量)",
      "anthropic/claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
      "anthropic/claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
      "openai/gpt-4o": "GPT-4o",
      "openai/gpt-4o-mini": "GPT-4o Mini",
      "google/gemini-2.0-flash-001": "Gemini 2.0 Flash",
      "google/gemini-2.5-pro-preview-03-25": "Gemini 2.5 Pro",
      "meta-llama/llama-3.3-70b-instruct": "Llama 3.3 70B",
    };
    const displayName = modelNames[model] || model;

    const modelEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.success)
      .setDescription(`✅ モデルを **${displayName}** に変更しました。\n次のメッセージからこのモデルが使用されます。`);
    await interaction.reply({ embeds: [modelEmbed] });
    return;
  }

  // /claude-workspace — ワークスペース登録
  if (commandName === "claude-workspace") {
    const name = interaction.options.getString("name", true);
    const directory = interaction.options.getString("directory", true);

    // ディレクトリの存在チェック
    if (!existsSync(directory)) {
      await interaction.reply({
        embeds: [buildErrorEmbed(`ディレクトリが存在しません: \`${directory}\``)],
        ephemeral: true,
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        embeds: [buildErrorEmbed("このコマンドはサーバー内でのみ使用できます。")],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      // 既存のカテゴリを検索、なければ作成
      let category = guild.channels.cache.find(
        (ch): ch is CategoryChannel =>
          ch.type === ChannelType.GuildCategory &&
          ch.name === `🤖 ${name}`
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
      sessionManager.addWorkspace({
        name,
        directory,
        categoryId: category.id,
      });

      const wsEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR.success)
        .setTitle(`✅ ワークスペース登録: ${name}`)
        .setDescription("このカテゴリ内のチャンネルでの操作は自動的にこのディレクトリで実行されます。")
        .addFields(
          { name: "📁 ディレクトリ", value: `\`${directory}\``, inline: true },
          { name: "📂 カテゴリ", value: category.name, inline: true }
        );
      await interaction.editReply({ embeds: [wsEmbed] });
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "不明なエラー";
      await interaction.editReply({ embeds: [buildErrorEmbed(`ワークスペースの作成に失敗: ${errorMsg}`)] });
    }
    return;
  }

  // /claude-workspaces — ワークスペース一覧
  if (commandName === "claude-workspaces") {
    const workspaces = sessionManager.getWorkspaces();
    if (workspaces.length === 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLOR.info)
            .setDescription("登録されたワークスペースはありません。\n`/claude-workspace` で登録してください。"),
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

  // /cron-list — 登録済みジョブ一覧を表示
  if (commandName === "cron-list") {
    const jobs = cronRunner.getJobs();
    if (jobs.length === 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLOR.info)
            .setDescription("ジョブが登録されていません。\n`workspace/cron/crontab.json` を編集してください。"),
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
          name: `${job.enabled ? "✅" : "⏸️"} ${job.description}`,
          value:
            `${describeSchedule(job)}\n` +
            `📢 <#${job.channel_id}>\n` +
            `💬 ${job.prompt.slice(0, 60)}${job.prompt.length > 60 ? "..." : ""}`,
        }))
      );
    await interaction.reply({ embeds: [cronListEmbed], ephemeral: true });
    return;
  }

  // /cron-id — 現在のチャンネルIDを表示
  if (commandName === "cron-id") {
    const channelId = interaction.channelId;
    const channelMention = interaction.channel ? `<#${channelId}>` : "このチャンネル";
    const idEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.info)
      .setTitle("📋 チャンネルID")
      .setDescription(`${channelMention}\n\`\`\`\n${channelId}\n\`\`\``)
      .setFooter({ text: "crontab.json の channelId にコピーしてください" });
    await interaction.reply({ embeds: [idEmbed], ephemeral: true });
    return;
  }

  // /cron-reload — crontab.json を再読み込み
  if (commandName === "cron-reload") {
    cronRunner.reload();
    const jobs = cronRunner.getJobs();
    const enabled = jobs.filter((j: any) => j.enabled).length;
    const reloadEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.success)
      .setDescription(`✅ crontab.json を再読み込みしました。\n有効なジョブ: **${enabled}件** / 全${jobs.length}件`);
    await interaction.reply({ embeds: [reloadEmbed] });
    return;
  }

  // /claude — メッセージ送信
  if (commandName === "claude") {
    const prompt = interaction.options.getString("prompt", true);

    // チャンネルの親カテゴリ情報をキャッシュ
    const channel = interaction.channel;
    if (channel && "parentId" in channel && channel.parentId) {
      sessionManager.setChannelCategory(
        interaction.channelId,
        channel.parentId
      );
    }

    // ユーザーメッセージをコンソールに出力
    const channelName = channel && "name" in channel ? `#${channel.name}` : "スラッシュコマンド";
    logUserMessage(interaction.user.username, interaction.user.id, channelName, prompt);

    await interaction.deferReply();

    // 進捗更新用コールバック（Discord表示 + コンソールログ）
    const { handler: onProgress, finish: finishProgress } = createProgressUpdater((options) =>
      interaction.editReply(options)
    );
    const onProgressWithLog = (event: ProgressEvent) => {
      logProgress(event);
      onProgress(event);
    };

    try {
      const { result } = await sessionManager.sendPrompt(
        interaction.channelId,
        prompt,
        onProgressWithLog
      );

      await finishProgress(); // 進行中のEmbed更新が完了するまで待ってから最終応答を書き込む
      const responseText = result || "（応答なし）";
      logResponse(responseText);

      await sendResponse(
        responseText,
        interaction.channelId,
        (options) => interaction.editReply(options),
        (options) => (interaction.channel as TextChannel).send(options),
        (files) => (interaction.channel as TextChannel).send({ files })
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "不明なエラー";
      log("❌ エラー", C.red, errorMessage);
      console.error(error);
      await interaction.editReply({ embeds: [buildErrorEmbed(errorMessage)] });
    }
  }
});

// ========================================
// プレフィックス方式の処理（従来互換 + 添付ファイル対応）
// ========================================

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  // ========================================
  // !コマンド ダイレクト実行（AIを介さずシェルで直接実行）
  // ========================================
  if (content.startsWith("!") && !content.startsWith(PREFIX)) {
    const shellCommand = content.slice(1).trim();
    if (!shellCommand) return;

    // 権限チェック
    if (!isUserAllowed(message.author.id)) {
      await message.reply({
        embeds: [buildErrorEmbed("このボットを使用する権限がありません。")],
      });
      return;
    }

    // 危険なコマンドをブロック（Bashツールと同じパターン）
    const blockedPatterns = [
      /\bsudo\b/,
      /\bsu\b/,
      /\bchmod\b/,
      /\bchown\b/,
      /\brm\s+(-[^\s]*)?-rf?\s+\//,
      /\brm\s+(-[^\s]*)?-rf?\s+~/,
      /\bshutdown\b/,
      /\breboot\b/,
      /\bmkfs\b/,
      /\bdd\b\s/,
      />\s*\/(?!dev\/null)/,
      /\bcurl\b.*\|\s*\bbash\b/,
      /\bwget\b.*\|\s*\bbash\b/,
    ];
    for (const pattern of blockedPatterns) {
      if (pattern.test(shellCommand)) {
        await message.reply({
          embeds: [buildErrorEmbed(`セキュリティ上の理由でこのコマンドは実行できません: \`${shellCommand}\``)],
        });
        return;
      }
    }

    // workspace内で実行（タイムアウト30秒）
    const workDir = sessionManager.resolveWorkDir(message.channelId);
    log(`⚡ !コマンド実行`, C.cyan, `[${message.author.username}] ${shellCommand}`);

    try {
      const result = await exec(`cd "${workDir}" && (${shellCommand}) 2>&1`, {
        cwd: workDir,
        timeout: 30000,
        env: { ...process.env, HOME: workDir },
      });
      const output = String(result.stdout || "").slice(0, 4000) || "(出力なし)";

      // 結果をEmbedで返信
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR.success)
        .setTitle(`\`${shellCommand}\``)
        .setDescription(`\`\`\`\n${output}\n\`\`\``)
        .setFooter({ text: "!コマンド ダイレクト実行" });
      await message.reply({ embeds: [embed] });

      // AIのchatHistoryに通知を追加
      sessionManager.addSystemNotice(
        message.channelId,
        `ユーザーが \`!${shellCommand}\` コマンドを実行しました。結果:\n${output.slice(0, 1000)}`
      );
    } catch (err: any) {
      const stdout = err.stdout ? String(err.stdout) : "";
      const stderr = err.stderr ? String(err.stderr) : "";
      const output = (stdout + "\n" + stderr).trim().slice(0, 4000) || err.message;

      // エラー時もEmbedで返信
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR.error)
        .setTitle(`\`${shellCommand}\``)
        .setDescription(`\`\`\`\n${output}\n\`\`\``)
        .setFooter({ text: "!コマンド ダイレクト実行（エラー）" });
      await message.reply({ embeds: [embed] });

      // AIにもエラーを通知
      sessionManager.addSystemNotice(
        message.channelId,
        `ユーザーが \`!${shellCommand}\` コマンドを実行しましたが、エラーが発生しました:\n${output.slice(0, 500)}`
      );
    }
    return;
  }

  // メンション or プレフィックスで始まるメッセージのみ処理
  // DM または AUTO_CHANNELS に指定されたチャンネルはプレフィックス不要
  const mentionPrefix = `<@${client.user?.id}>`;
  const isDM = !message.guild; // ギルドがなければDM
  const isAutoChannel = AUTO_CHANNELS.includes(message.channelId);
  let prompt = "";

  if (isDM || isAutoChannel) {
    // DM・指定チャンネルは全文をプロンプトとして使う
    prompt = content;
  } else if (content.startsWith(PREFIX)) {
    prompt = content.slice(PREFIX.length).trim();
  } else if (content.startsWith(mentionPrefix)) {
    prompt = content.slice(mentionPrefix.length).trim();
  } else {
    return;
  }

  if (!isUserAllowed(message.author.id)) {
    await message.reply({
      embeds: [buildErrorEmbed("このボットを使用する権限がありません。")],
    });
    return;
  }

  // セッションクリアコマンド（大文字小文字・/プレフィックス不問）
  if (/^\/?clear$/i.test(prompt)) {
    const { cleared, savedFile } = await sessionManager.clearSession(message.channelId);
    const memoryNote = savedFile ? `\n💾 会話履歴を \`${savedFile}\` に保存しました。` : "";
    const clearMsgEmbed = new EmbedBuilder()
      .setColor(cleared ? EMBED_COLOR.success : EMBED_COLOR.info)
      .setDescription(
        cleared
          ? `✅ セッションをクリアしました。新しい会話を始められます。${memoryNote}`
          : "このチャンネルにはアクティブなセッションがありません。"
      );
    await message.reply({ embeds: [clearMsgEmbed] });
    return;
  }

  // ヘルプコマンド
  if (/^\/?help$/i.test(prompt)) {
    await message.reply({ embeds: [buildHelpEmbed()] });
    return;
  }

  // プロンプトが空で添付もない場合
  if (!prompt && message.attachments.size === 0) {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR.info)
          .setDescription(`メッセージを入力してください。例: \`${PREFIX} このプロジェクトの構成を教えて\``),
      ],
    });
    return;
  }

  // チャンネルの親カテゴリ情報をキャッシュ
  if ("parentId" in message.channel && message.channel.parentId) {
    sessionManager.setChannelCategory(
      message.channelId,
      message.channel.parentId
    );
  }

  // ユーザーメッセージをコンソールに出力
  const channelInfo = isDM
    ? "DM"
    : isAutoChannel && "name" in message.channel
    ? `#${(message.channel as any).name} [auto]`
    : "name" in message.channel
    ? `#${(message.channel as any).name}`
    : message.channelId;
  logUserMessage(message.author.username, message.author.id, channelInfo, prompt);

  // 処理中の表示（Embed）
  const thinkingMessage = await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLOR.progress)
        .setDescription("考え中..."),
    ],
  });

  // 進捗更新用コールバック（Discord表示 + コンソールログ）
  const { handler: onProgress, finish: finishProgress } = createProgressUpdater((options) =>
    thinkingMessage.edit(options)
  );
  const onProgressWithLog = (event: ProgressEvent) => {
    logProgress(event);
    onProgress(event);
  };

  try {
    // 添付ファイルを処理してプロンプトに追加
    const { promptAddition } = await processAttachments(message.attachments);
    const fullPrompt = prompt + promptAddition;

    // Claude Codeにプロンプトを送信
    const { result } = await sessionManager.sendPrompt(
      message.channelId,
      fullPrompt,
      onProgressWithLog
    );

    await finishProgress(); // 進行中のEmbed更新が完了するまで待ってから最終応答を書き込む
    const responseText = result || "（応答なし）";
    logResponse(responseText);

    const channel = message.channel as TextChannel;

    await sendResponse(
      responseText,
      message.channelId,
      (options) => thinkingMessage.edit(options),
      (options) => channel.send(options),
      (files) => channel.send({ files })
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "不明なエラー";
    log("❌ エラー", C.red, errorMessage);
    console.error(error);
    await thinkingMessage.edit({ embeds: [buildErrorEmbed(errorMessage)] });
  }
});

// ボットを起動
client.login(DISCORD_TOKEN);
