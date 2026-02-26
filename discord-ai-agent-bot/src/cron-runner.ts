/**
 * cron-runner.ts
 *
 * YAML定義のジョブをスケジュール実行するクラス。
 * crontab.yaml をchokidarで監視し、変更時に自動的にジョブを再読み込みする。
 *
 * ジョブの種類:
 * - repeat: cron式に従い繰り返し実行される定期ジョブ
 * - once: 1回だけ実行され、完了後に backlog.yaml にアーカイブされる単発ジョブ
 *
 * ジョブ実行時は onRunPrompt コールバックを呼び出し、
 * 結果をDiscordチャンネルにEmbed形式で投稿する。
 */

import * as schedule from "node-schedule";
import * as yaml from "js-yaml";
import * as chokidar from "chokidar";
import {
  EmbedBuilder,
  type Client,
  type TextChannel,
} from "discord.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { EMBED_COLOR } from "./utils/embed-colors";

// ========================================
// 型定義
// ========================================

/** ジョブ共通のベース型 */
interface BaseCronJob {
  id?: string;          // 省略時は自動生成
  description?: string; // 省略時はcron式から自動生成
  channel_id: string;   // Discordの投稿先チャンネルID
  prompt: string;       // AIに送信するプロンプト
  enabled: boolean;     // 有効/無効フラグ
}

/** 繰り返しジョブ（cron式で定期実行） */
export interface RepeatCronJob extends BaseCronJob {
  type: "repeat";
  /** 標準cron式: "分 時 日 月 曜" 例: "0 9 * * 1-5" */
  cron: string;
}

/** 単発ジョブ（1回実行後にバックログへ移動） */
export interface OnceCronJob extends BaseCronJob {
  type: "once";
  /** 標準cron式: "分 時 日 月 曜" 例: "0 9 1 3 *" */
  cron: string;
}

/** ジョブの共用体型 */
export type CronJob = RepeatCronJob | OnceCronJob;

/** backlog.yaml に保存される完了ジョブのエントリ */
interface BacklogEntry extends OnceCronJob {
  executed_at: string;
  status: "completed" | "failed";
  error?: string;
}

/** crontab.yaml のトップレベル構造 */
interface CrontabConfig {
  jobs: CronJob[];
}

/** backlog.yaml のトップレベル構造 */
interface BacklogConfig {
  completed: BacklogEntry[];
}

/** id・description が必ず存在することが保証されたジョブ型 */
type NormalizedCronJob = CronJob & { id: string; description: string };

// ========================================
// ユーティリティ関数
// ========================================

/** スケジュールを人間が読みやすい文字列に変換する */
export function describeSchedule(job: CronJob): string {
  if (job.type === "once") {
    return `📅 単発: \`${job.cron}\``;
  }
  return `🔄 繰り返し: \`${job.cron}\``;
}

/** 現在時刻を "YYYY-MM-DD HH:MM:SS" 形式で返す（Asia/Tokyo） */
function nowJST(): string {
  return new Date()
    .toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" })
    .replace("T", " ");
}

/**
 * id・description が省略されていた場合に自動補完する。
 * id は index + cron式から生成、description は type + cron をそのまま使う。
 */
function normalizeJob(job: CronJob, index: number): NormalizedCronJob {
  const cronKey = job.cron.replace(/\s+/g, "").replace(/\*/g, "x");
  const autoId = `job-${index}-${cronKey}`;
  const autoDescription =
    job.type === "repeat"
      ? `繰り返しジョブ (${job.cron})`
      : `単発ジョブ (${job.cron})`;

  return {
    ...job,
    id: job.id ?? autoId,
    description: job.description ?? autoDescription,
  };
}

// ========================================
// CronRunner クラス
// ========================================

/**
 * YAMLベースのジョブスケジューラー。
 *
 * - crontab.yaml をchokidarでリアルタイム監視し、変更時に自動再読み込み
 * - node-schedule でジョブをスケジューリング
 * - ジョブ実行時は onRunPrompt コールバック経由でAI応答を取得
 * - 結果をDiscordチャンネルにEmbed形式で投稿
 */
export class CronRunner {
  /** 登録中のスケジュール済みタスク（ジョブID → node-schedule.Job） */
  private readonly tasks = new Map<string, schedule.Job>();

  /** crontab.yaml のファイルパス */
  private readonly crontabPath: string;

  /** backlog.yaml のファイルパス */
  private readonly backlogPath: string;

  /** chokidar のファイル監視インスタンス */
  private watcher: chokidar.FSWatcher | null = null;

  /**
   * @param crontabPath  crontab.yaml のファイルパス
   * @param backlogPath  backlog.yaml のファイルパス
   * @param client       Discord.js クライアント（チャンネル投稿に使用）
   * @param onRunPrompt  プロンプト実行コールバック（channelId, prompt → 結果テキスト）
   */
  constructor(
    crontabPath: string,
    backlogPath: string,
    private readonly client: Client,
    private readonly onRunPrompt: (
      channelId: string,
      prompt: string
    ) => Promise<string>
  ) {
    this.crontabPath = crontabPath;
    this.backlogPath = backlogPath;
  }

  // ========================================
  // 公開メソッド
  // ========================================

  /**
   * cronスケジューラーを起動する。
   *
   * - crontab.yaml が存在しなければスキップ
   * - chokidar でファイル変更を監視し、変更時に自動リロードする
   */
  start(): void {
    if (!existsSync(this.crontabPath)) {
      console.log(`[Cron] crontab.yaml が見つかりません: ${this.crontabPath}`);
      console.log(
        "[Cron] crontab.yaml を作成するとcronが有効になります"
      );
      return;
    }

    // 初回読み込み
    this.loadAndSchedule();

    // chokidar でファイル変更を監視
    this.watcher = chokidar.watch(this.crontabPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on("change", () => {
      console.log("[Cron] crontab.yaml が変更されました。再読み込みします...");
      this.reload();
    });

    console.log("[Cron] ファイル監視を開始しました（chokidar）");
  }

  /**
   * 全タスクを停止し、ファイル監視も終了する。
   */
  stop(): void {
    // 全スケジュール済みタスクをキャンセル
    this.tasks.forEach((job) => job.cancel());
    this.tasks.clear();

    // chokidar のファイル監視を停止
    if (this.watcher) {
      this.watcher.close().catch((err) => {
        console.error("[Cron] ファイル監視の停止に失敗:", err);
      });
      this.watcher = null;
    }

    console.log("[Cron] 全ジョブを停止しました");
  }

  /**
   * 全タスクを停止して crontab.yaml を再読み込みする。
   */
  reload(): void {
    // 既存タスクをすべてキャンセル
    this.tasks.forEach((job) => job.cancel());
    this.tasks.clear();

    // ファイルが存在しなければ何もしない
    if (!existsSync(this.crontabPath)) {
      console.log("[Cron] crontab.yaml が見つかりません（リロード中断）");
      return;
    }

    this.loadAndSchedule();
  }

  /**
   * 登録済みジョブ一覧を返す（表示用）。
   */
  getJobs(): CronJob[] {
    try {
      const raw = readFileSync(this.crontabPath, "utf-8");
      const config = yaml.load(raw) as CrontabConfig;
      return config?.jobs ?? [];
    } catch {
      return [];
    }
  }

  // ========================================
  // プライベートメソッド
  // ========================================

  /**
   * crontab.yaml を読み込んでジョブをスケジュール登録する。
   */
  private loadAndSchedule(): void {
    let config: CrontabConfig;
    try {
      const raw = readFileSync(this.crontabPath, "utf-8");
      config = yaml.load(raw) as CrontabConfig;
    } catch (err) {
      console.error("[Cron] crontab.yaml の読み込みに失敗:", err);
      return;
    }

    const rawJobs = config?.jobs ?? [];
    // id・description が省略されていた場合に自動補完
    const jobs = rawJobs.map((job, i) => normalizeJob(job, i));
    let scheduled = 0;

    for (const job of jobs) {
      // 無効なジョブはスキップ
      if (!job.enabled) {
        console.log(`[Cron] スキップ (disabled): ${job.id}`);
        continue;
      }

      const label = job.type === "once" ? "once" : "repeat";
      const task = schedule.scheduleJob(job.cron, () => this.runJob(job));
      if (!task) {
        console.warn(
          `[Cron] スケジュール登録失敗（無効なcron式？）: ${job.id} | "${job.cron}"`
        );
        continue;
      }

      this.tasks.set(job.id, task);
      scheduled++;
      console.log(
        `[Cron] 登録(${label}): ${job.id} | "${job.cron}" | ${job.description}`
      );
    }

    console.log(
      `[Cron] ${scheduled} 件のジョブを登録しました（全${jobs.length}件中）`
    );
  }

  /**
   * ジョブを実行する。
   *
   * 1. 開始通知Embedを送信
   * 2. onRunPrompt コールバックでAI応答を取得
   * 3. 結果をEmbed形式でチャンネルに投稿
   * 4. 単発ジョブの場合はバックログにアーカイブ
   */
  private async runJob(job: NormalizedCronJob): Promise<void> {
    console.log(`[Cron] ジョブ開始: ${job.id} — ${job.description}`);

    // チャンネルを取得
    const channel = this.client.channels.cache.get(
      job.channel_id
    ) as TextChannel | undefined;

    if (!channel || !("send" in channel)) {
      console.error(
        `[Cron] チャンネルが見つかりません: channel_id=${job.channel_id} (ジョブ: ${job.id})`
      );
      if (job.type === "once") {
        this.archiveJob(job, "failed", "チャンネルが見つかりません");
      }
      return;
    }

    // 開始通知Embedを送信（処理中表示）
    const startEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR.progress)
      .setTitle(`⏰ ${job.description}`)
      .setDescription("AIが応答を生成中です...")
      .setFooter({ text: `${describeSchedule(job)} | ID: ${job.id}` })
      .setTimestamp();

    let notifyMsg;
    try {
      notifyMsg = await channel.send({ embeds: [startEmbed] });
    } catch (err) {
      console.error(`[Cron] 開始通知の送信に失敗: ${job.id}`, err);
      if (job.type === "once") {
        this.archiveJob(job, "failed", "開始通知の送信に失敗");
      }
      return;
    }

    try {
      // onRunPrompt コールバックでAI応答を取得
      const result = await this.onRunPrompt(job.channel_id, job.prompt);
      const responseText = result || "（応答なし）";

      // Embed用にテキストを4000文字以内にトリミング
      const truncated = responseText.length > 4000;
      const displayText = truncated
        ? responseText.slice(0, 3950) + "\n\n...（長いため省略されました）"
        : responseText;

      // 完了Embedで上書き
      const responseEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR.success)
        .setTitle(`✅ ${job.description}`)
        .setDescription(displayText)
        .setFooter({ text: `${describeSchedule(job)} | ID: ${job.id}` })
        .setTimestamp();

      await notifyMsg.edit({ embeds: [responseEmbed] });
      console.log(`[Cron] ジョブ完了: ${job.id}`);

      // 単発ジョブは完了後にバックログへアーカイブ
      if (job.type === "once") {
        this.archiveJob(job, "completed");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "不明なエラー";
      console.error(`[Cron] ジョブ失敗: ${job.id} —`, errMsg);

      // エラーEmbedで上書き
      const errorEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR.error)
        .setTitle(`❌ エラー: ${job.description}`)
        .setDescription(errMsg)
        .setFooter({ text: `${describeSchedule(job)} | ID: ${job.id}` })
        .setTimestamp();

      try {
        await notifyMsg.edit({ embeds: [errorEmbed] });
      } catch {
        // エラーEmbedの送信に失敗した場合は無視
      }

      // 失敗した単発ジョブもバックログにアーカイブ
      if (job.type === "once") {
        this.archiveJob(job, "failed", errMsg);
      }
    }
  }

  /**
   * 単発ジョブを crontab.yaml から削除し backlog.yaml にアーカイブする。
   *
   * - crontab.yaml のヘッダーコメント（jobs: 行より前）は保持する
   * - backlog.yaml に実行結果を追記する
   */
  private archiveJob(
    job: OnceCronJob | NormalizedCronJob,
    status: "completed" | "failed",
    error?: string
  ): void {
    try {
      // ── 1. crontab.yaml からジョブを削除 ──────────────────────
      const raw = readFileSync(this.crontabPath, "utf-8");

      // jobs: 行より前のヘッダーコメントを保持する
      const headerLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (/^jobs\s*:/.test(line)) break;
        headerLines.push(line);
      }
      const header = headerLines.join("\n").trimEnd();

      const config = yaml.load(raw) as CrontabConfig;
      config.jobs = (config.jobs ?? []).filter((j) => j.id !== job.id);

      const jobsYaml = yaml.dump(config, { indent: 2, lineWidth: 120 });
      const newContent = header ? `${header}\n\n${jobsYaml}` : jobsYaml;
      writeFileSync(this.crontabPath, newContent, "utf-8");

      // ── 2. backlog.yaml にエントリを追記 ──────────────────────
      const backlog = this.getBacklog();

      const entry: BacklogEntry = {
        ...(job as OnceCronJob),
        executed_at: nowJST(),
        status,
        ...(error ? { error } : {}),
      };
      backlog.push(entry);

      // backlog.yaml の保存先ディレクトリを確保
      const backlogDir = dirname(this.backlogPath);
      if (!existsSync(backlogDir)) {
        mkdirSync(backlogDir, { recursive: true });
      }

      const backlogYaml = yaml.dump(
        { completed: backlog },
        { indent: 2, lineWidth: 120 }
      );
      writeFileSync(this.backlogPath, backlogYaml, "utf-8");

      console.log(
        `[Cron] 単発ジョブをバックログに移動しました: ${job.id} [${status}]`
      );
    } catch (err) {
      console.error("[Cron] バックログへの移動に失敗:", err);
    }
  }

  /**
   * backlog.yaml からアーカイブ済みジョブ一覧を読み込む。
   */
  private getBacklog(): BacklogEntry[] {
    try {
      if (!existsSync(this.backlogPath)) return [];
      const raw = readFileSync(this.backlogPath, "utf-8");
      const config = yaml.load(raw) as BacklogConfig;
      return config?.completed ?? [];
    } catch {
      return [];
    }
  }
}
