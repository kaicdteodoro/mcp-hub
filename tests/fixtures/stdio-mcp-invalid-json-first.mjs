#!/usr/bin/env node
import readline from 'node:readline';

process.stdout.write('not json\n');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    continue;
  }
  const id = req.id;
  if (id === undefined) continue;
  const res = {
    jsonrpc: '2.0',
    id,
    result: { ok: true }
  };
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

