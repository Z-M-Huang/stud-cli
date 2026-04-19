import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly homepage: string;
}

function readPackageManifest(): PackageManifest {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = resolve(here, "..", "..", "package.json");
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw) as PackageManifest;
}

export function main(argv: readonly string[]): number {
  const pkg = readPackageManifest();
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  process.stdout.write(
    `stud-cli v${pkg.version}\n` +
      `Placeholder release. A bare-bones, fully customizable coding CLI is in design.\n` +
      `Track progress: ${pkg.homepage}\n`,
  );
  return 0;
}
