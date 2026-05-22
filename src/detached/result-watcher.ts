import { existsSync, type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";

export interface DetachedResultRecord {
  readonly id: string;
  readonly resultPath: string;
  readonly data: unknown;
}

export interface DetachedResultWatcher {
  start(): void;
  stop(): void;
  scan(): void;
  readonly mode: "watch" | "poll" | "stopped";
}

export interface DetachedResultWatcherOptions {
  readonly pollIntervalMs?: number;
  readonly onResult: (record: DetachedResultRecord) => void;
  readonly onError?: (error: unknown) => void;
}

function readResult(root: string, id: string): DetachedResultRecord | undefined {
  const resultPath = join(root, id, "result.json");
  if (!existsSync(resultPath)) return undefined;
  return { id, resultPath, data: JSON.parse(readFileSync(resultPath, "utf8")) };
}

export function createDetachedResultWatcher(root: string, options: DetachedResultWatcherOptions): DetachedResultWatcher {
  const seen = new Set<string>();
  let watcher: FSWatcher | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let mode: "watch" | "poll" | "stopped" = "stopped";

  const handle = (id: string) => {
    if (seen.has(id)) return;
    try {
      const record = readResult(root, id);
      if (!record) return;
      seen.add(id);
      options.onResult(record);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const scan = () => {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) handle(entry.name);
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  const startPoll = () => {
    if (poll) return;
    mode = "poll";
    scan();
    poll = setInterval(scan, options.pollIntervalMs ?? 3_000);
    poll.unref?.();
  };

  return {
    get mode() { return mode; },
    scan,
    start() {
      if (watcher || poll) return;
      try {
        scan();
        watcher = watch(root, { persistent: false }, (_event, filename) => {
          if (filename) handle(String(filename));
          else scan();
        });
        watcher.on("error", (error) => {
          options.onError?.(error);
          watcher?.close();
          watcher = undefined;
          startPoll();
        });
        mode = "watch";
      } catch (error) {
        options.onError?.(error);
        startPoll();
      }
    },
    stop() {
      watcher?.close();
      watcher = undefined;
      if (poll) clearInterval(poll);
      poll = undefined;
      mode = "stopped";
    },
  };
}
