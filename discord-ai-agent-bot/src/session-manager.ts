/**
 * session-manager.ts
 *
 * セッション管理・ワークスペースルーティング・Discord送受信のヘルパー。
 * v1の ClaudeSessionManager からAI呼び出し・ツール・メモリ部分を分離し、
 * 純粋なセッション管理のみを担当する。
 */

import type { ModelMessage } from "ai";
import type { Client, TextChannel, CategoryChannel } from "discord.js";
import { ChannelType } from "discord.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ========================================
// 型定義
// ========================================

/** ワークスペース設定（Discordカテゴリとローカルディレクトリのマッピング） */
export type WorkspaceConfig = {
  name: string;
  directory: string;
  categoryId: string;
};

/** 会話の1ターン（人間可読形式の会話履歴） */
export type ConversationTurn = {
  timestamp: Date;
  userPrompt: string;
  assistantResponse: string;
};

/** 永続化するセッションデータの型 */
type PersistedData = {
  channelModels: Record<string, string>;
  workspaces: Record<string, WorkspaceConfig>;
  channelCategoryCache: Record<string, string | null>;
  // 会話履歴（タイムスタンプはISO文字列で保存される）
  conversationHistory: Record<
    string,
    Array<{
      timestamp: string;
      userPrompt: string;
      assistantResponse: string;
    }>
  >;
  // チャット履歴（AI SDKのModelMessage[]をそのままJSON化して保存）
  chatHistory?: Record<string, ModelMessage[]>;
};

// ========================================
// 定数
// ========================================

/** 永続化するチャット履歴の最大メッセージ数 */
const MAX_PERSISTED_MESSAGES = 40;

/** デフォルトのワークスペースディレクトリ */
const DEFAULT_WORK_DIR = process.env.WORKDIR || "./workspace";

// ========================================
// SessionManager クラス
// ========================================

/**
 * セッション管理クラス
 *
 * 担当範囲:
 * - チャット履歴（AI SDK ModelMessage[]）の管理
 * - 会話履歴（人間可読形式）の管理
 * - チャンネルごとのモデル設定
 * - ワークスペースの登録・解決
 * - セッションデータの永続化（.sessions.json）
 *
 * AI呼び出し・ツール・メモリ（RAG）は別モジュールが担当する。
 */
export class SessionManager {
  /** チャット履歴（AI SDKのModelMessage[]） */
  chatHistory: Map<string, ModelMessage[]> = new Map();

  /** 会話履歴（人間可読形式、メモリ保存やRAG用） */
  conversationHistory: Map<string, ConversationTurn[]> = new Map();

  /** チャンネルごとのモデル設定（チャンネルID → モデルID） */
  channelModels: Map<string, string> = new Map();

  /** ワークスペース一覧（カテゴリID → ワークスペース設定） */
  workspaces: Map<string, WorkspaceConfig> = new Map();

  /** チャンネル→カテゴリIDキャッシュ（ルーティング高速化） */
  channelCategoryCache: Map<string, string | null> = new Map();

  /** セッションデータの保存先ファイルパス */
  private persistPath: string;

  /**
   * @param sessionsPath - .sessions.json の絶対パス
   */
  constructor(sessionsPath: string) {
    this.persistPath = sessionsPath;
    this.load();
  }

  // ========================================
  // 永続化
  // ========================================

  /**
   * セッションデータをファイルから読み込む。
   * chatHistory も復元し、再起動後も会話を継続可能にする。
   */
  load(): void {
    if (!existsSync(this.persistPath)) return;

    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const data: PersistedData = JSON.parse(raw);

      // 各Mapを復元
      this.channelModels = new Map(
        Object.entries(data.channelModels || {})
      );
      this.workspaces = new Map(
        Object.entries(data.workspaces || {})
      );
      this.channelCategoryCache = new Map(
        Object.entries(data.channelCategoryCache || {})
      );

      // 会話履歴を復元（タイムスタンプをDateオブジェクトに変換）
      for (const [channelId, turns] of Object.entries(
        data.conversationHistory || {}
      )) {
        this.conversationHistory.set(
          channelId,
          turns.map((t) => ({
            ...t,
            timestamp: new Date(t.timestamp),
          }))
        );
      }

      // チャット履歴を復元（AI SDK ModelMessage[]）
      if (data.chatHistory) {
        for (const [channelId, messages] of Object.entries(
          data.chatHistory
        )) {
          if (messages && messages.length > 0) {
            this.chatHistory.set(channelId, messages);
          }
        }
        console.log(
          `[SessionManager] セッションデータを読み込みました` +
            `（チャット${this.chatHistory.size}ch, 履歴${this.conversationHistory.size}ch）`
        );
      } else {
        console.log(
          `[SessionManager] セッションデータを読み込みました` +
            `（履歴${this.conversationHistory.size}チャンネル）`
        );
      }
    } catch {
      console.error(
        "[SessionManager] セッションデータの読み込みに失敗しました（新規作成します）"
      );
    }
  }

  /**
   * セッションデータをファイルに保存する。
   * chatHistory は直近 MAX_PERSISTED_MESSAGES メッセージのみ保存しファイルサイズを抑制する。
   */
  save(): void {
    try {
      // 保存先ディレクトリが存在しなければ作成
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // chatHistory は直近メッセージのみ保存
      const chatHistoryToSave: Record<string, ModelMessage[]> = {};
      for (const [channelId, messages] of this.chatHistory.entries()) {
        if (messages.length > 0) {
          chatHistoryToSave[channelId] = messages.slice(
            -MAX_PERSISTED_MESSAGES
          );
        }
      }

      const data: PersistedData = {
        channelModels: Object.fromEntries(this.channelModels),
        workspaces: Object.fromEntries(this.workspaces),
        channelCategoryCache: Object.fromEntries(this.channelCategoryCache),
        // 会話履歴（タイムスタンプをISO文字列に変換して保存）
        conversationHistory: Object.fromEntries(
          Array.from(this.conversationHistory.entries()).map(
            ([k, v]) => [
              k,
              v.map((t) => ({
                ...t,
                timestamp: t.timestamp.toISOString(),
              })),
            ]
          )
        ),
        chatHistory: chatHistoryToSave,
      };

      writeFileSync(
        this.persistPath,
        JSON.stringify(data, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.error(
        "[SessionManager] セッションデータの保存に失敗しました:",
        err
      );
    }
  }

  // ========================================
  // ワークスペース管理
  // ========================================

  /**
   * チャンネルに対応する作業ディレクトリを解決する。
   * Discordクライアントを使ってチャンネルの親カテゴリを取得し、
   * ワークスペースが紐付いていればそのディレクトリを返す。
   * キャッシュになければDiscord APIから取得してキャッシュに保存する。
   *
   * @param channelId - DiscordのチャンネルID
   * @param client - Discord.jsクライアント（カテゴリ情報の取得に使用）
   * @returns 作業ディレクトリの絶対パス
   */
  async resolveWorkDir(channelId: string, client: Client): Promise<string> {
    const categoryId = await this.resolveCategoryId(channelId, client);

    if (categoryId) {
      const workspace = this.workspaces.get(categoryId);
      if (workspace) {
        return workspace.directory;
      }
    }

    return DEFAULT_WORK_DIR;
  }

  /**
   * チャンネルに対応するワークスペース名を取得する（表示用）。
   *
   * @param channelId - DiscordのチャンネルID
   * @param client - Discord.jsクライアント
   * @returns ワークスペース名。該当なしの場合は "default"
   */
  async resolveWorkspaceName(
    channelId: string,
    client: Client
  ): Promise<string> {
    const categoryId = await this.resolveCategoryId(channelId, client);

    if (categoryId) {
      const workspace = this.workspaces.get(categoryId);
      if (workspace) {
        return workspace.name;
      }
    }

    return "default";
  }

  /**
   * ワークスペースを登録する。
   * カテゴリIDが未指定の場合は "manual:<name>" をキーとして登録する。
   *
   * @param name - ワークスペース名
   * @param directory - 作業ディレクトリの絶対パス
   * @param categoryId - DiscordカテゴリID（省略時は自動生成キー）
   */
  registerWorkspace(
    name: string,
    directory: string,
    categoryId: string
  ): void {
    const config: WorkspaceConfig = { name, directory, categoryId };
    this.workspaces.set(categoryId, config);
    this.save();
    console.log(
      `[SessionManager] ワークスペース登録: ${name} → ${directory} (category: ${categoryId})`
    );
  }

  /**
   * 全ワークスペースを取得する。
   */
  getWorkspaces(): WorkspaceConfig[] {
    return Array.from(this.workspaces.values());
  }

  /**
   * チャンネルの親カテゴリIDを解決する（内部ヘルパー）。
   * キャッシュにあればキャッシュから返し、なければDiscord APIで取得してキャッシュに保存する。
   */
  private async resolveCategoryId(
    channelId: string,
    client: Client
  ): Promise<string | null> {
    // キャッシュにあればそれを返す
    if (this.channelCategoryCache.has(channelId)) {
      return this.channelCategoryCache.get(channelId) ?? null;
    }

    // Discord APIからチャンネル情報を取得
    try {
      const channel = await client.channels.fetch(channelId);
      if (
        channel &&
        (channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.GuildVoice)
      ) {
        const textChannel = channel as TextChannel;
        const categoryId = textChannel.parentId ?? null;
        this.channelCategoryCache.set(channelId, categoryId);
        this.save();
        return categoryId;
      }
    } catch (err) {
      console.error(
        `[SessionManager] チャンネル ${channelId} のカテゴリ取得に失敗:`,
        err
      );
    }

    // 取得できなかった場合もキャッシュしておく（再試行を避ける）
    this.channelCategoryCache.set(channelId, null);
    return null;
  }

  // ========================================
  // チャット履歴（AI SDK ModelMessage[]）
  // ========================================

  /**
   * チャンネルのチャット履歴を取得する。
   * 存在しない場合は空の配列を返す。
   *
   * @param channelId - DiscordのチャンネルID
   * @returns AI SDK ModelMessage の配列（コピーではなく参照）
   */
  getChatHistory(channelId: string): ModelMessage[] {
    return this.chatHistory.get(channelId) || [];
  }

  /**
   * チャット履歴にメッセージを追加する。
   * 既存の履歴に追記し、永続化も行う。
   *
   * @param channelId - DiscordのチャンネルID
   * @param messages - 追加する ModelMessage の配列
   */
  appendToHistory(channelId: string, messages: ModelMessage[]): void {
    const existing = this.chatHistory.get(channelId) || [];
    existing.push(...messages);
    this.chatHistory.set(channelId, existing);
    this.save();
  }

  /**
   * チャンネルのチャット履歴をクリアする。
   *
   * @param channelId - DiscordのチャンネルID
   */
  clearHistory(channelId: string): void {
    this.chatHistory.delete(channelId);
    this.conversationHistory.delete(channelId);
    this.save();
  }

  /**
   * チャット履歴を指定件数にトリムする。
   * 古いメッセージから削除し、直近のメッセージのみ残す。
   *
   * @param channelId - DiscordのチャンネルID
   * @param maxMessages - 残す最大メッセージ数（デフォルト: 40）
   */
  trimHistory(channelId: string, maxMessages: number = 40): void {
    const history = this.chatHistory.get(channelId);
    if (history && history.length > maxMessages) {
      this.chatHistory.set(channelId, history.slice(-maxMessages));
      console.log(
        `[SessionManager] チャット履歴をトリム: ${channelId} (${history.length} → ${maxMessages})`
      );
    }

    // 会話履歴もトリム（チャット履歴の半分を目安に）
    const convHistory = this.conversationHistory.get(channelId);
    const maxConv = Math.max(Math.floor(maxMessages / 2), 10);
    if (convHistory && convHistory.length > maxConv) {
      this.conversationHistory.set(
        channelId,
        convHistory.slice(-maxConv)
      );
    }

    this.save();
  }

  // ========================================
  // モデル管理
  // ========================================

  /**
   * チャンネルで使用中のモデル名を取得する。
   * チャンネル固有の設定がなければ環境変数 MODEL のデフォルト値を返す。
   *
   * @param channelId - DiscordのチャンネルID
   * @returns モデルID文字列
   */
  getModel(channelId: string): string {
    return (
      this.channelModels.get(channelId) ||
      process.env.MODEL ||
      "anthropic/claude-sonnet-4-20250514"
    );
  }

  /**
   * チャンネルのモデルを変更する。
   * チャット履歴はそのまま継続（コンテキストを維持しつつモデルだけ切り替え）。
   *
   * @param channelId - DiscordのチャンネルID
   * @param model - 設定するモデルID
   */
  setModel(channelId: string, model: string): void {
    this.channelModels.set(channelId, model);
    this.save();
    console.log(
      `[SessionManager] モデル変更: ${channelId} → ${model}`
    );
  }
}
