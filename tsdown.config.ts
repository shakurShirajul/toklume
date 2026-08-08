import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  outExtensions: () => ({ js: '.js' }),
  clean: true,
  dts: false,
  // better-sqlite3 is a native module and must stay external.
  deps: { neverBundle: ['better-sqlite3'] },
})
