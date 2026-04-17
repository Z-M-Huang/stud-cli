#!/usr/bin/env node
"use strict";

const pkg = require("../package.json");

const args = process.argv.slice(2);

if (args.includes("-v") || args.includes("--version")) {
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

process.stdout.write(
  "stud-cli v" + pkg.version + "\n" +
  "Placeholder release. A bare-bones, fully customizable coding CLI is in design.\n" +
  "Track progress: " + pkg.homepage + "\n"
);
