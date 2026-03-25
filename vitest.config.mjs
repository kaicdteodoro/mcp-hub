import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      all: true,
      include: [
        'config/**/*.js',
        'registry/**/*.js',
        'router/**/*.js',
        'health/**/*.js'
      ],
      exclude: [
        'tests/**',
        'node_modules/**',
        'fixtures/**',
        'docs/**',
        'index.js',
        'process-manager/**',
        'transport/**'
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100
      }
    }
  }
});
