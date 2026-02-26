/**
 * memory-manager.ts
 *
 * デュアルメモリシステム: 短期メモリ（JSONファイル）+ 長期メモリ（JSONファイル）
 *
 * 短期メモリ:
 *   - チャンネルごとの会話要約をJSONファイルに保存
 *   - チャット履歴が80メッセージを超えたら自動要約・トリム
 *
 * 長期メモリ:
 *   - JSONファイルにユーザーの好み・作業履歴・メモを永続化
 *   - workspace/memory/long-term.json に保存
 *
 * ※ better-sqlite3 はNode.js v25+でネイティブビルドに問題があるため、
 *   短期メモリもJSONファイルベースで実装している。
 */

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

/** 短期メモリの保存形式（チャンネルIDをキーにした配列） */
type ShortTermStore = Record<string, ShortTermMemory[]>;

// ========================================
// デフォルト値
// ========================================

/** 長期メモリの初期状態 */
const DEFAULT_LONG_TERM_MEMORY: LongTermMemory = {
  preferences: {},
  work_history: [],
  user_notes: [],
};

/** 短期メモリのID採番用カウンター */
let nextShortTermId = 1;

// ========================================
// MemoryManager クラス
// ========================================

export class MemoryManager {
  private shortTermPath: string;
  private longTermPath: string;
  private shortTermStore: ShortTermStore = {};

  /**
   * @param shortTermPath 短期メモリJSONファイルのパス
   * @param longTermPath  長期メモリJSONファイルのパス
   */
  constructor(shortTermPath: string, longTermPath: string) {
    this.shortTermPath = shortTermPath;
    this.longTermPath = longTermPath;
  }

  // ========================================
  // 初期化・終了
  // ========================================

  /** メモリファイルを初期化する */
  initialize(): void {
    try {
      // 短期メモリのディレクトリを確保
      const stDir = path.dirname(this.shortTermPath);
      if (!fs.existsSync(stDir)) {
        fs.mkdirSync(stDir, { recursive: true });
      }

      // 短期メモリJSONを読み込み（存在すれば）
      if (fs.existsSync(this.shortTermPath)) {
        try {
          const raw = fs.readFileSync(this.shortTermPath, "utf-8");
          this.shortTermStore = JSON.parse(raw) as ShortTermStore;

          // 最大IDを算出してカウンターを設定
          let maxId = 0;
          for (const entries of Object.values(this.shortTermStore)) {
            for (const entry of entries) {
              if (entry.id > maxId) maxId = entry.id;
            }
          }
          nextShortTermId = maxId + 1;
        } catch {
          this.shortTermStore = {};
        }
      }

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

  /** リソースを解放する（JSONベースのため特に必要な処理はない） */
  close(): void {
    // 短期メモリを最終保存
    this.saveShortTermStore();
    console.log("[MemoryManager] メモリを保存して終了しました");
  }

  // ========================================
  // 短期メモリ操作
  // ========================================

  /**
   * 短期メモリに要約を保存する
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
    try {
      if (!this.shortTermStore[channelId]) {
        this.shortTermStore[channelId] = [];
      }

      const entry: ShortTermMemory = {
        id: nextShortTermId++,
        channel_id: channelId,
        summary,
        created_at: new Date().toISOString(),
        message_count: messageCount,
      };

      this.shortTermStore[channelId].push(entry);
      this.saveShortTermStore();

      console.log(
        `[MemoryManager] 短期メモリ保存: channel=${channelId}, messages=${messageCount}`
      );
    } catch (error) {
      console.error("[MemoryManager] 短期メモリ保存エラー:", error);
      throw error;
    }
  }

  /**
   * 指定チャンネルの短期メモリを取得する（新しい順）
   *
   * @param channelId チャンネル ID
   * @param limit     最大取得件数（デフォルト: 10）
   * @returns 短期メモリの配列
   */
  getShortTermMemories(
    channelId: string,
    limit: number = 10
  ): ShortTermMemory[] {
    try {
      const entries = this.shortTermStore[channelId] || [];
      // 新しい順にソートしてlimit件返す
      return [...entries]
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        .slice(0, limit);
    } catch (error) {
      console.error("[MemoryManager] 短期メモリ取得エラー:", error);
      return [];
    }
  }

  /**
   * 短期メモリをクリアする
   *
   * @param channelId 対象チャンネルID（省略時は全削除）
   */
  clearShortTermMemory(channelId?: string): void {
    try {
      if (channelId) {
        const count = (this.shortTermStore[channelId] || []).length;
        delete this.shortTermStore[channelId];
        this.saveShortTermStore();
        console.log(
          `[MemoryManager] 短期メモリクリア: channel=${channelId}, 削除件数=${count}`
        );
      } else {
        this.shortTermStore = {};
        this.saveShortTermStore();
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
   * ユーザーノートを追加する（重複チェックあり）
   */
  addUserNote(note: string): void {
    try {
      const memory = this.getLongTermMemory();

      if (memory.user_notes.includes(note)) {
        console.log(
          `[MemoryManager] ユーザーノート重複のためスキップ: ${note}`
        );
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

    if (results.length === 0) {
      return `「${query}」に関連するメモリは見つかりませんでした。`;
    }

    return results.join("\n");
  }

  // ========================================
  // プライベートメソッド
  // ========================================

  /** 短期メモリをJSONファイルに保存する */
  private saveShortTermStore(): void {
    try {
      const dir = path.dirname(this.shortTermPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.shortTermPath,
        JSON.stringify(this.shortTermStore, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error("[MemoryManager] 短期メモリ保存エラー:", error);
    }
  }

  /** 長期メモリをJSONファイルに保存する */
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
