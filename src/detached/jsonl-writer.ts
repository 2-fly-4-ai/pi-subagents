import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface JsonlWriter {
  readonly path: string;
  append(value: unknown): Promise<void>;
  close(): Promise<void>;
}

export function createJsonlWriter(path: string): JsonlWriter {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
  let queue = Promise.resolve();

  function writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        stream.off("error", onError);
        stream.off("drain", onDrain);
      };
      stream.once("error", onError);
      if (stream.write(line)) {
        cleanup();
        resolve();
      } else {
        stream.once("drain", onDrain);
      }
    });
  }

  return {
    path,
    append(value: unknown) {
      queue = queue.then(() => writeLine(`${JSON.stringify(value)}\n`));
      return queue;
    },
    async close() {
      await queue.catch(() => undefined);
      await closeStream(stream);
    },
  };
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("finish", onFinish);
    };
    stream.once("error", onError);
    stream.once("finish", onFinish);
    stream.end();
  });
}
