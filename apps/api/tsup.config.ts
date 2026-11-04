import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Workspace libraries are source-first TypeScript, so they are bundled;
  // every other node_modules dependency stays external.
  noExternal: [/^@orc\//],
  skipNodeModulesBundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
