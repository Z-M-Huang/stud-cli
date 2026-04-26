import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempFile(name: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stud-fs-fixture-"));
  const filePath = join(root, name);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

export async function cleanupTempFile(path: string): Promise<void> {
  const root = join(path, "..");
  await rm(root, { recursive: true, force: true });
}
