// Bundles the `orc-db` CLI (contract §1.1, §16.5) for the db-cli image. Run from the repository
// root: `npx tsup --config docker/db-cli/tsup.config.mjs`. The bundle lands next to the package's
// migrations/ and seed/ directories so relative lookups behave as in the repository.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'orc-db': 'packages/database/src/cli/orc-db.ts' },
  outDir: 'packages/database/dist',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Workspace libraries are source-first TypeScript and are bundled; every other
  // node_modules dependency stays external and is installed in the image.
  noExternal: [/^@orc\//],
  skipNodeModulesBundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
