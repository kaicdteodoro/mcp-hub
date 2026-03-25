#!/usr/bin/env node

// Write >1MB without newline to trigger wrapper buffer cap.
process.stdout.write('a'.repeat(1024 * 1024 + 50));

setInterval(() => {}, 1000);

