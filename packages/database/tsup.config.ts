// Bundles the `orc-db` CLI to dist/orc-db.js (contract §1.1, §16.5; ADR-0003). The bundle sits next to
// migrations/ and seed/, so src/paths.ts resolves them the same way in source and bundled form.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'orc-db': 'src/cli/orc-db.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Workspace libraries are source-first TypeScript and are bundled; every other
  // node_modules dependency stays external.
  noExternal: [/^@orc\//],
  skipNodeModulesBundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
