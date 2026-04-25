#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcEntry = resolve(root, "src", "cli.ts");
const distEntry = resolve(root, "dist", "cli.js");
const tsxBin = resolve(root, "node_modules", ".bin", "tsx");

let command;
let args;
if (existsSync(srcEntry) && existsSync(tsxBin)) {
  command = tsxBin;
  args = [srcEntry, ...process.argv.slice(2)];
} else if (existsSync(distEntry)) {
  command = process.execPath;
  args = [distEntry, ...process.argv.slice(2)];
} else {
  console.error(
    "mill: could not find src/cli.ts (with tsx) or dist/cli.js. " +
      "Run `npm install` and either keep the repo linked or `npm run build`."
  );
  process.exit(1);
}

const child = spawn(command, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
