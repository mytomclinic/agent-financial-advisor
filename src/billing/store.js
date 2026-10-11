// Key-value store behind billing. MemoryStore for tests, FileStore for a single
// Node host. A Cloudflare KV / D1 adapter only needs get/set/append/list.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export class MemoryStore {
  constructor() {
    this.data = new Map();
    this.logs = new Map();
  }
  async get(k) { return this.data.has(k) ? structuredClone(this.data.get(k)) : null; }
  async set(k, v) { this.data.set(k, structuredClone(v)); }
  async append(log, entry) {
    if (!this.logs.has(log)) this.logs.set(log, []);
    this.logs.get(log).push(entry);
  }
  async list(log) { return [...(this.logs.get(log) || [])]; }
}

export class FileStore extends MemoryStore {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = `${dir}/state.json`;
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.file)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.file, "utf8")))) this.data.set(k, v);
    }
    this.timer = null;
  }
  async set(k, v) {
    await super.set(k, v);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data), null, 1));
    renameSync(tmp, this.file);
  }
  async append(log, entry) {
    const path = `${this.dir}/${log}.jsonl`;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  }
  async list(log) {
    const path = `${this.dir}/${log}.jsonl`;
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}
