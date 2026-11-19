#!/usr/bin/env node
// PostToolUse: after an Edit/Write to a .ts/.tsx file, typecheck that file's
// workspace. Exit 2 feeds the first errors back to Claude; exit 0 is silent.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const target = input.tool_input?.file_path;
if (!target || !/\.(ts|tsx|mts|cts)$/.test(target)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const abs = isAbsolute(target) ? target : resolve(root, target);
if (relative(root, abs).startsWith('..')) process.exit(0);

// nearest directory (up to the repo root) with a tsconfig.json
let dir = dirname(abs);
while (!existsSync(resolve(dir, 'tsconfig.json'))) {
  if (dir === root || dir === dirname(dir)) process.exit(0);
  dir = dirname(dir);
}

const r = spawnSync('npx', ['--no-install', 'tsc', '--noEmit', '-p', dir], { cwd: dir, encoding: 'utf8', timeout: 90_000 });
if (r.status === 0) process.exit(0);
const out = `${r.stdout}${r.stderr}`.trim().split('\n').slice(0, 30).join('\n');
process.stderr.write(`Typecheck failed in ${relative(root, dir) || '.'} after editing ${relative(root, abs)}:\n${out}\n`);
process.exit(2);
