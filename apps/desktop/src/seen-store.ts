import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_SEEN_ENTRIES = 500;

interface StoredSeenFile {
  version: 1;
  entries: Record<string, { mark: string; savedAt: number }>;
}

/**
 * Persists the user's "seen" marks for stopped/problematic tasks in the main process
 * so handled items do not resurface after window reload or desktop restart.
 */
export class SeenSessionStore {
  private readonly entries = new Map<string, { mark: string; savedAt: number }>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !parsed
        || typeof parsed !== "object"
        || !("version" in parsed)
        || parsed.version !== 1
        || !("entries" in parsed)
        || !parsed.entries
        || typeof parsed.entries !== "object"
      ) {
        return;
      }
      this.entries.clear();
      for (const [key, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
        if (
          value
          && typeof value === "object"
          && "mark" in value
          && typeof value.mark === "string"
          && "savedAt" in value
          && typeof value.savedAt === "number"
        ) {
          this.entries.set(key, { mark: value.mark, savedAt: value.savedAt });
        }
      }
      this.trim();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        // Ignore corrupted seen cache rather than blocking desktop startup.
        this.entries.clear();
      }
    }
  }

  getAll(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, entry] of this.entries) {
      out[key] = entry.mark;
    }
    return out;
  }

  async markSeen(key: string, mark: string, now = Date.now()): Promise<void> {
    if (!key || !mark) return;
    if (this.entries.get(key)?.mark === mark) return;
    this.entries.set(key, { mark, savedAt: now });
    this.trim();
    await this.save();
  }

  private trim(): void {
    if (this.entries.size <= MAX_SEEN_ENTRIES) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
    while (this.entries.size > MAX_SEEN_ENTRIES && sorted.length > 0) {
      const oldest = sorted.shift();
      if (oldest) this.entries.delete(oldest[0]);
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const data: StoredSeenFile = {
      version: 1,
      entries: Object.fromEntries(this.entries.entries()),
    };
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}
