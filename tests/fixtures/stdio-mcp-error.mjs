#!/usr/bin/env node
import readline from 'node:readline';

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
    error: { code: -32001, message: 'boom', data: { reason: 'fixture' } }
  };
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

