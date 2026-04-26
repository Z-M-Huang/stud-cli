import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { IntegrityToken } from "./signature.js";

type IntegrityAlgorithm = IntegrityToken["algorithm"];

export async function computeToken(
  extensionRoot: string,
  fileSet: readonly string[],
  algorithm: IntegrityAlgorithm,
): Promise<string> {
  const hash = createHash(algorithm);

  for (const relativePath of fileSet) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(join(extensionRoot, relativePath)));
    hash.update("\0");
  }

  return hash.digest("hex");
}
