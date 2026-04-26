import { createWriteStream, fsync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { Session } from "../../../core/errors/index.js";

function fsyncStream(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsync(fd, (err) => {
      if (err != null) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export interface NDJSONWriter {
  readonly path: string;
  sizeBytes(): number;
  write(line: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

class StreamWriter implements NDJSONWriter {
  readonly path: string;
  #stream: ReturnType<typeof createWriteStream> | null = null;
  #size = 0;
  #closed = false;

  private constructor(path: string, size: number) {
    this.path = path;
    this.#size = size;
  }

  static async open(path: string): Promise<StreamWriter> {
    await mkdir(dirname(path), { recursive: true });
    const size = await stat(path)
      .then((entry) => entry.size)
      .catch(() => 0);
    const writer = new StreamWriter(path, size);
    writer.#stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
    await new Promise<void>((resolve, reject) => {
      writer.#stream?.once("open", () => resolve());
      writer.#stream?.once("error", (err) => reject(err));
    }).catch((err: unknown) => {
      throw new Session("file logger cannot open target path", err, {
        code: "StoreUnavailable",
        path,
      });
    });
    return writer;
  }

  sizeBytes(): number {
    return this.#size;
  }

  async write(line: string): Promise<void> {
    if (this.#closed || this.#stream == null) {
      throw new Session("file logger writer is closed", undefined, {
        code: "StoreUnavailable",
        path: this.path,
      });
    }
    await new Promise<void>((resolve, reject) => {
      this.#stream?.write(line, "utf8", (err) => {
        if (err != null) {
          reject(err);
          return;
        }
        resolve();
      });
    }).catch((err: unknown) => {
      throw new Session("file logger failed to append record", err, {
        code: "StoreUnavailable",
        path: this.path,
      });
    });
    this.#size += Buffer.byteLength(line, "utf8");
  }

  async flush(): Promise<void> {
    if (this.#closed || this.#stream == null) {
      return Promise.resolve();
    }
    const fd = (this.#stream as unknown as { readonly fd?: number }).fd;
    if (typeof fd === "number") {
      try {
        await fsyncStream(fd);
      } catch (err) {
        throw new Session("file logger failed to flush data", err, {
          code: "StoreUnavailable",
          path: this.path,
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed || this.#stream == null) {
      this.#closed = true;
      return Promise.resolve();
    }
    await this.flush();
    const stream = this.#stream;
    this.#stream = null;
    this.#closed = true;
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => {
        if (err != null) {
          reject(err);
          return;
        }
        resolve();
      });
    }).catch((err: unknown) => {
      throw new Session("file logger failed to close stream", err, {
        code: "StoreUnavailable",
        path: this.path,
      });
    });
  }
}

export async function openWriter(path: string): Promise<NDJSONWriter> {
  return StreamWriter.open(path);
}
