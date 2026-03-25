#!/usr/bin/env node

// Delay writing so the parent has time to attach stderr listeners.
setTimeout(() => {
  process.stderr.write('line1\nline2\nline3\n');
}, 50);

setInterval(() => {}, 1000);

