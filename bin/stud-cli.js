#!/usr/bin/env node
import("../dist/cli/index.js")
  .then(({ main }) => {
    const code = main(process.argv.slice(2));
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
