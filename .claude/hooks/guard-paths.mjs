#!/usr/bin/env node
// PreToolUse guard for Edit/Write/MultiEdit/NotebookEdit.
// Enforces docs/OWNERSHIP.md: blocks .env, frozen contract paths (except on
// contracts/* branches) and, on session/* branches, anything the branch
// doesn't own. Exit 2 = block; stderr is shown to Claude.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const FROZEN = ['packages/contracts/', 'docs/contracts/', 'apps/traceops/src/seams.ts'];
const SESSION_COMMON = ['docs/proposals/', 'docs/build-log/', 'docs/handoff/'];

function block(msg) {
  process.stderr.write(`Blocked by .claude/hooks/guard-paths.mjs: ${msg}\n`);
  process.exit(2);
}

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const ti = input.tool_input ?? {};
const target = ti.file_path ?? ti.notebook_path;
if (!target) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const abs = isAbsolute(target) ? target : resolve(input.cwd || root, target);
const rel = relative(root, abs).split('\\').join('/');
if (rel.startsWith('..') || isAbsolute(rel)) process.exit(0); // outside the repo (scratchpad, memory)

const name = basename(rel);
if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
  block(`${rel} holds secrets and is never edited by an agent.`);
}

let branch = '';
try { branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}

const under = (p, list) => list.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));

if (under(rel, FROZEN) && !branch.startsWith('contracts/')) {
  block(`${rel} is frozen (contracts or seams). Write docs/proposals/<topic>.md explaining the problem and stop; the main session decides.`);
}

if (branch.startsWith('session/')) {
  let owned = null;
  try {
    const md = readFileSync(resolve(root, 'docs/OWNERSHIP.md'), 'utf8');
    for (const line of md.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length > 3 && cells[1] === `\`${branch}\``) {
        owned = [...cells[3].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      }
    }
  } catch {}
  if (!owned) block(`branch ${branch} has no row in docs/OWNERSHIP.md, so it owns nothing. Ask the main session.`);
  if (!under(rel, [...owned, ...SESSION_COMMON])) {
    block(`${rel} is not owned by ${branch} (owns: ${owned.join(', ')}). If you need a change there, write docs/proposals/<topic>.md and stop.`);
  }
}

process.exit(0);
