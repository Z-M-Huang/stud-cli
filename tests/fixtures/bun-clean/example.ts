// This file uses Node only. Canonical runtime for src/ is Node.
import { readFile } from "node:fs/promises";
export const loader = readFile;
