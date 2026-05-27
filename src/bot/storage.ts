import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export class SlackConversationStore {
  private readonly database: Database.Database;
  private readonly upsertThreadStatement: Database.Statement;
  private readonly findThreadStatement: Database.Statement;
  private readonly insertRepliedMessageStatement: Database.Statement;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });

    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS active_threads (
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, thread_ts)
      );

      CREATE TABLE IF NOT EXISTS replied_messages (
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, message_ts)
      );
    `);

    this.upsertThreadStatement = this.database.prepare(`
      INSERT INTO active_threads (channel_id, thread_ts, created_at, updated_at)
      VALUES (@channelId, @threadTs, @now, @now)
      ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
        updated_at = excluded.updated_at
    `);

    this.findThreadStatement = this.database.prepare(`
      SELECT 1
      FROM active_threads
      WHERE channel_id = ? AND thread_ts = ?
      LIMIT 1
    `);

    this.insertRepliedMessageStatement = this.database.prepare(`
      INSERT OR IGNORE INTO replied_messages (channel_id, message_ts, created_at)
      VALUES (?, ?, ?)
    `);
  }

  saveActiveThread(channelId: string, threadTs: string): void {
    const now = new Date().toISOString();

    this.upsertThreadStatement.run({
      channelId,
      threadTs,
      now,
    });
  }

  hasActiveThread(channelId: string, threadTs: string): boolean {
    return this.findThreadStatement.get(channelId, threadTs) !== undefined;
  }

  markMessageForReply(channelId: string, messageTs: string): boolean {
    const result = this.insertRepliedMessageStatement.run(
      channelId,
      messageTs,
      new Date().toISOString(),
    );

    return result.changes === 1;
  }

  close(): void {
    this.database.close();
  }
}
