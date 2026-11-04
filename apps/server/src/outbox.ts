import pg from "pg";
import type { ChangeEvent } from "@maybe/api";
import { stringify } from "@maybe/api";
import type { Queryable } from "./jobs.ts";
import { log } from "./log.ts";

export type Topic = ChangeEvent["topics"][number];
const CHANNEL = "maybe_changes";

/**
 * Transactional outbox: the change record is written in the same transaction
 * as the state change, and NOTIFY is delivered only when that transaction
 * commits, so a client is never told about a change that rolled back.
 */
export async function publish(q: Queryable, topics: Topic[], payload: Record<string, unknown> = {}): Promise<void> {
  await q.query("INSERT INTO outbox (topics, payload) VALUES ($1::text[], $2)", [topics, JSON.stringify(payload)]);
  await q.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ topics })]);
}

export interface SseClient {
  id: number;
  send(data: string): void;
}

/** Fans committed changes out to connected Server-Sent-Event clients. */
export class Hub {
  private clients = new Map<number, SseClient>();
  private listener: pg.Client | null = null;
  private seq = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly now: () => number,
  ) {}

  async start(): Promise<void> {
    const c = new pg.Client({ connectionString: this.url });
    c.on("error", (e) => {
      log.warn({ err: e.message }, "outbox listener error; reconnecting");
      this.listener = null;
      setTimeout(() => void this.start().catch(() => undefined), 1000);
    });
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    c.on("notification", (n) => {
      try {
        const { topics } = JSON.parse(n.payload ?? "{}") as { topics: Topic[] };
        this.broadcast(topics);
      } catch {
        /* ignore malformed */
      }
    });
    this.listener = c;
    this.heartbeat ??= setInterval(() => this.broadcast(["clock"]), 15_000);
  }

  add(send: (data: string) => void): () => void {
    const id = ++this.seq;
    this.clients.set(id, { id, send });
    send(stringify({ topics: ["clock"], now: this.now() }));
    return () => this.clients.delete(id);
  }

  broadcast(topics: Topic[]): void {
    const data = stringify({ topics, now: this.now() });
    for (const c of this.clients.values()) {
      try {
        c.send(data);
      } catch {
        this.clients.delete(c.id);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.listener?.end().catch(() => undefined);
    this.listener = null;
  }
}
