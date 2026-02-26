/**
 * memory-manager.ts
 *
 * デュアルメモリシステム: 短期メモリ（SQLite）+ 長期メモリ（JSONファイル）
 *
 * 短期メモリ:
 *   - better-sqlite3 を使い、チャンネルごとの会話要約を保存
 *   - チャット履歴が80メッセージを超えたら自動要約・トリム
 *
 * 長期メモリ:
 *   - JSONファイルにユーザーの好み・作業履歴・メモを永続化
 *   - workspace/memory/long-term.json に保存
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

// ========================================
// 型定義
// ========================================

/** 短期メモリの1レコード */
export interface ShortTermMemory {
  id: number;
  channel_id: string;
  summary: string;
  created_at: string;
  message_count: number;
}

/** 作業履歴の1エントリ */
export interface WorkHistoryEntry {
  task: string;
  date: string;
  outcome: string;
  notes?: string;
}

/** 長期メモリ全体の構造 */
export interface LongTermMemory {
  preferences: Record<string, string>;
  work_history: WorkHistoryEntry[];
  user_notes: string[];
}

// ========================================
// デフォルト値
// ========================================

/** 長期メモリの初期状態 */
const DEFAULT_LONG_TERM_MEMORY: LongTermMemory = {
  preferences: {},
  work_history: [],
  user_notes: [],
};

// ========================================
// MemoryManager クラス
// ========================================

export class MemoryManager {
  private dbPath: string;
  private longTermPath: string;
  private db: Database.Database | null = null;

  /**
   * @param dbPath       SQLiteデータベースファイルのパス
   * @param longTermPath 長期メモリJSONファイルのパス
   */
  constructor(dbPath: string, longTermPath: string) {
    this.dbPath = dbPath;
    this.longTermPath = longTermPath;
  }

  // ========================================
  // 初期化・終了
  // ========================================

  /** データベースを初期化し、テーブルを作成する */
  initialize(): void {
    try {
      // SQLiteデータベースのディレクトリを確保
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // データベースに接続
      this.db = new Database(this.dbPath);

      // WALモードで高速化
      this.db.pragma("journal_mode = WAL");

      // 短期メモリテーブルを作成
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS short_term_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          message_count INTEGER
        )
      `);

      // チャンネルIDでの検索を高速化するインデックス
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_short_term_channel
        ON short_term_memory (channel_id, created_at DESC)
      `);

      // 長期メモリJSONのディレクトリを確保
      const ltDir = path.dirname(this.longTermPath);
      if (!fs.existsSync(ltDir)) {
        fs.mkdirSync(ltDir, { recursive: true });
      }

      // 長期メモリJSONが存在しなければ初期値で作成
      if (!fs.existsSync(this.longTermPath)) {
        this.saveLongTermMemory(DEFAULT_LONG_TERM_MEMORY);
      }

      console.log("[MemoryManager] 初期化完了");
    } catch (error) {
      console.error("[MemoryManager] 初期化エラー:", error);
      throw error;
    }
  }

  /** データベース接続を閉じる */
  close(): void {
    try {
      if (this.db) {
        this.db.close();
        this.db = null;
        console.log("[MemoryManager] データベース接続を閉じました");
      }
    } catch (error) {
      console.error("[MemoryManager] クローズエラー:", error);
    }
  }

  // ========================================
  // 短期メモリ操作
  // ========================================

  /**
   * 短期メモリに要約を保存する
   *
   * チャット履歴が長くなった場合に、要約を保存してから履歴をトリムする用途。
   *
   * @param channelId    Discordチャンネル ID
   * @param summary      会話の要約テキスト
   * @param messageCount 要約対象のメッセージ数
   */
  saveShortTermMemory(
    channelId: string,
    summary: string,
    messageCount: number
  ): void {
    this.ensureDb();

    try {
      const stmt = this.db!.prepare(`
        INSERT INTO short_term_memory (channel_id, summary, message_count)
        VALUES (?, ?, ?)
      `);
      stmt.run(channelId, summary, messageCount);
      console.log(
        `[MemoryManager] 短期メモリ保存: channel=${channelId}, messages=${messageCount}`
      );
    } catch (error) {
      console.error("[MemoryManager] 短期メモリ保存エラー:", error);
      throw error;
    }
  }

  /**
   * 指定チャンネルの短期メモリを取得する
   *
   * 新しい順に返す。limitで最大件数を制限可能。
   *
   * @param channelId チャンネル ID
   * @param limit     最大取得件数（デフォルト: 10）
   * @returns 短期メモリの配列
   */
  getShortTermMemories(
    channelId: string,
    limit: number = 10
  ): ShortTermMemory[] {
    this.ensureDb();

    try {
      const stmt = this.db!.prepare(`
        SELECT id, channel_id, summary, created_at, message_count
        FROM short_term_memory
        WHERE channel_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(channelId, limit) as ShortTermMemory[];
      return rows;
    } catch (error) {
      console.error("[MemoryManager] 短期メモリ取得エラー:", error);
      return [];
    }
  }

  /**
   * 短期メモリをクリアする
   *
   * channelIdを指定した場合はそのチャンネルのみ、
   * 省略した場合は全チャンネルの短期メモリを削除する。
   *
   * @param channelId 対象チャンネルID（省略時は全削除）
   */
  clearShortTermMemory(channelId?: string): void {
    this.ensureDb();

    try {
      if (channelId) {
        const stmt = this.db!.prepare(
          "DELETE FROM short_term_memory WHERE channel_id = ?"
        );
        const result = stmt.run(channelId);
        console.log(
          `[MemoryManager] 短期メモリクリア: channel=${channelId}, 削除件数=${result.changes}`
        );
      } else {
        this.db!.exec("DELETE FROM short_term_memory");
        console.log("[MemoryManager] 全短期メモリをクリアしました");
      }
    } catch (error) {
      console.error("[MemoryManager] 短期メモリクリアエラー:", error);
      throw error;
    }
  }

  // ========================================
  // 長期メモリ操作
  // ========================================

  /**
   * 長期メモリを読み込んで返す
   *
   * ファイルが存在しない場合やパースエラーの場合はデフォルト値を返す。
   *
   * @returns 長期メモリオブジェクト
   */
  getLongTermMemory(): LongTermMemory {
    try {
      if (!fs.existsSync(this.longTermPath)) {
        return { ...DEFAULT_LONG_TERM_MEMORY };
      }

      const raw = fs.readFileSync(this.longTermPath, "utf-8");
      const parsed = JSON.parse(raw) as LongTermMemory;

      // 各フィールドが欠けている場合はデフォルト値で補完
      return {
        preferences: parsed.preferences ?? {},
        work_history: parsed.work_history ?? [],
        user_notes: parsed.user_notes ?? [],
      };
    } catch (error) {
      console.error("[MemoryManager] 長期メモリ読み込みエラー:", error);
      return { ...DEFAULT_LONG_TERM_MEMORY };
    }
  }

  /**
   * ユーザーの好みを追加・更新する
   *
   * @param key   好みのキー（例: "coding_language"）
   * @param value 好みの値（例: "Python"）
   */
  updatePreference(key: string, value: string): void {
    try {
      const memory = this.getLongTermMemory();
      memory.preferences[key] = value;
      this.saveLongTermMemory(memory);
      console.log(`[MemoryManager] 好み更新: ${key} = ${value}`);
    } catch (error) {
      console.error("[MemoryManager] 好み更新エラー:", error);
      throw error;
    }
  }

  /**
   * 作業履歴を追加する
   *
   * @param entry 作業履歴エントリ
   */
  addWorkHistory(entry: WorkHistoryEntry): void {
    try {
      const memory = this.getLongTermMemory();
      memory.work_history.push(entry);
      this.saveLongTermMemory(memory);
      console.log(`[MemoryManager] 作業履歴追加: ${entry.task}`);
    } catch (error) {
      console.error("[MemoryManager] 作業履歴追加エラー:", error);
      throw error;
    }
  }

  /**
   * ユーザーノートを追加する
   *
   * 重複するノートは追加しない。
   *
   * @param note ノート文字列
   */
  addUserNote(note: string): void {
    try {
      const memory = this.getLongTermMemory();

      // 重複チェック
      if (memory.user_notes.includes(note)) {
        console.log(`[MemoryManager] ユーザーノート重複のためスキップ: ${note}`);
        return;
      }

      memory.user_notes.push(note);
      this.saveLongTermMemory(memory);
      console.log(`[MemoryManager] ユーザーノート追加: ${note}`);
    } catch (error) {
      console.error("[MemoryManager] ユーザーノート追加エラー:", error);
      throw error;
    }
  }

  /**
   * 長期メモリを初期状態にリセットする
   */
  clearLongTermMemory(): void {
    try {
      this.saveLongTermMemory({ ...DEFAULT_LONG_TERM_MEMORY });
      console.log("[MemoryManager] 長期メモリをクリアしました");
    } catch (error) {
      console.error("[MemoryManager] 長期メモリクリアエラー:", error);
      throw error;
    }
  }

  // ========================================
  // 統合検索
  // ========================================

  /**
   * 短期メモリと長期メモリを横断して検索し、関連情報をテキストで返す
   *
   * ルーターエージェントがコンテキスト構築に利用する。
   *
   * @param channelId チャンネル ID
   * @param query     検索クエリ
   * @returns 検索結果をまとめたテキスト
   */
  searchMemories(channelId: string, query: string): string {
    const results: string[] = [];
    const queryLower = query.toLowerCase();

    // --- 短期メモリから検索 ---
    const shortTermMemories = this.getShortTermMemories(channelId, 20);
    const relevantShortTerm = shortTermMemories.filter((m) =>
      m.summary.toLowerCase().includes(queryLower)
    );

    if (relevantShortTerm.length > 0) {
      results.push("## 短期メモリ（会話要約）");
      for (const mem of relevantShortTerm) {
        results.push(`- [${mem.created_at}] ${mem.summary}`);
      }
    }

    // --- 長期メモリから検索 ---
    const longTerm = this.getLongTermMemory();

    // 好みを検索
    const matchedPrefs = Object.entries(longTerm.preferences).filter(
      ([key, value]) =>
        key.toLowerCase().includes(queryLower) ||
        value.toLowerCase().includes(queryLower)
    );
    if (matchedPrefs.length > 0) {
      results.push("## ユーザーの好み");
      for (const [key, value] of matchedPrefs) {
        results.push(`- ${key}: ${value}`);
      }
    }

    // 作業履歴を検索
    const matchedHistory = longTerm.work_history.filter(
      (entry) =>
        entry.task.toLowerCase().includes(queryLower) ||
        entry.outcome.toLowerCase().includes(queryLower) ||
        (entry.notes && entry.notes.toLowerCase().includes(queryLower))
    );
    if (matchedHistory.length > 0) {
      results.push("## 作業履歴");
      for (const entry of matchedHistory) {
        const notePart = entry.notes ? ` (${entry.notes})` : "";
        results.push(
          `- [${entry.date}] ${entry.task} → ${entry.outcome}${notePart}`
        );
      }
    }

    // ユーザーノートを検索
    const matchedNotes = longTerm.user_notes.filter((note) =>
      note.toLowerCase().includes(queryLower)
    );
    if (matchedNotes.length > 0) {
      results.push("## ユーザーノート");
      for (const note of matchedNotes) {
        results.push(`- ${note}`);
      }
    }

    // 結果がない場合
    if (results.length === 0) {
      return `「${query}」に関連するメモリは見つかりませんでした。`;
    }

    return results.join("\n");
  }

  // ========================================
  // プライベートメソッド
  // ========================================

  /** DBが初期化済みであることを確認する */
  private ensureDb(): void {
    if (!this.db) {
      throw new Error(
        "[MemoryManager] データベースが初期化されていません。initialize() を先に呼び出してください。"
      );
    }
  }

  /**
   * 長期メモリをJSONファイルに保存する
   *
   * @param memory 保存する長期メモリオブジェクト
   */
  private saveLongTermMemory(memory: LongTermMemory): void {
    try {
      const dir = path.dirname(this.longTermPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.longTermPath,
        JSON.stringify(memory, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error("[MemoryManager] 長期メモリ保存エラー:", error);
      throw error;
    }
  }
}
