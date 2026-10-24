import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message } from '../../types/index.js';
import type { PersistedSession, SessionMeta, SessionState, SessionSummary } from './types.js';

/**
 * Persists sessions under `<baseDir>/<sessionId>/` as:
 *   - messages.jsonl : one JSON message per line, append-only, in order
 *   - meta.json      : session config + counters
 *
 * The default base directory is `~/.agent-v2/sessions`. Tests inject a
 * tmpdir base via the constructor.
 */
export class SessionStore {
  private readonly baseDir: string;
  /** sessionId -> number of message lines already on disk */
  private readonly savedCounts = new Map<string, number>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.agent-v2', 'sessions');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /** Directory for one session's files. */
  sessionDir(sessionId: string): string {
    return path.join(this.baseDir, sessionId);
  }

  // --------------------------------------------------------------------------
  // Save
  // --------------------------------------------------------------------------

  /**
   * Persist a session state. Messages are appended incrementally: only
   * messages beyond the already-persisted count are written to the JSONL
  * file, so save-on-mutation stays cheap. If the history shrank (compaction
   * or deletion), the file is rewritten from scratch.
   */
  saveSession(state: SessionState): void {
    const dir = this.sessionDir(state.config.id);
    fs.mkdirSync(dir, { recursive: true });

    const previous = this.savedCounts.get(state.config.id) ?? this.countLines(state.config.id);
    const total = state.messages.length;

    if (total < previous) {
      this.writeAllMessages(dir, state.messages);
      this.savedCounts.set(state.config.id, total);
    } else if (total > previous) {
      const fd = fs.openSync(path.join(dir, 'messages.jsonl'), 'a');
      try {
        for (let i = previous; i < total; i++) {
          const msg = state.messages[i];
          if (msg) fs.appendFileSync(fd, `${JSON.stringify(this.serializeMessage(msg))}\n`);
        }
      } finally {
        fs.closeSync(fd);
      }
      this.savedCounts.set(state.config.id, total);
    }

    this.saveMeta(state);
  }

  private saveMeta(state: SessionState): void {
    const meta: SessionMeta = {
      config: state.config,
      status: state.status,
      turnCount: state.turnCount,
      totalCostUsd: state.totalCostUsd,
      totalUsage: state.totalUsage,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(this.sessionDir(state.config.id), 'meta.json'), JSON.stringify(meta, null, 2));
  }

  private writeAllMessages(dir: string, messages: Message[]): void {
    const file = path.join(dir, 'messages.jsonl');
    const fd = fs.openSync(file, 'w');
    try {
      for (const msg of messages) {
        fs.appendFileSync(fd, `${JSON.stringify(this.serializeMessage(msg))}\n`);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private serializeMessage(msg: Message): unknown {
    return { ...msg, timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp };
  }

  // --------------------------------------------------------------------------
  // Load
  // --------------------------------------------------------------------------

  /** Load a persisted session. Returns null when it does not exist. */
  loadSession(sessionId: string): PersistedSession | null {
    const dir = this.sessionDir(sessionId);
    if (!fs.existsSync(dir)) return null;

    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta;
    } catch {
      return null;
    }

    const messages = this.readMessages(sessionId);
    this.savedCounts.set(sessionId, messages.length);
    return { meta, messages };
  }

  private readMessages(sessionId: string): Message[] {
    const file = path.join(this.sessionDir(sessionId), 'messages.jsonl');
    if (!fs.existsSync(file)) return [];

    const messages: Message[] = [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Message & { timestamp: string };
        messages.push({ ...parsed, timestamp: new Date(parsed.timestamp) });
      } catch {
        // Corrupt line: skip rather than fail the whole load.
      }
    }
    return messages;
  }

  // --------------------------------------------------------------------------
  // List / delete
  // --------------------------------------------------------------------------

  listSessions(): string[] {
    if (!fs.existsSync(this.baseDir)) return [];
    return fs
      .readdirSync(this.baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  sessionExists(sessionId: string): boolean {
    return fs.existsSync(path.join(this.sessionDir(sessionId), 'meta.json'));
  }

  getSummary(sessionId: string): SessionSummary | null {
    const persisted = this.loadSession(sessionId);
    if (!persisted) return null;
    const { meta, messages } = persisted;
    return {
      id: meta.config.id,
      title: meta.config.title,
      status: meta.status,
      messageCount: messages.length,
      turnCount: meta.turnCount,
      totalCostUsd: meta.totalCostUsd,
      createdAt: meta.config.createdAt,
      updatedAt: meta.config.updatedAt,
    };
  }

  deleteSession(sessionId: string): boolean {
    const dir = this.sessionDir(sessionId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    this.savedCounts.delete(sessionId);
    return true;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private countLines(sessionId: string): number {
    const file = path.join(this.sessionDir(sessionId), 'messages.jsonl');
    if (!fs.existsSync(file)) return 0;
    let count = 0;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (line.trim()) count++;
    }
    return count;
  }
}
