#!/usr/bin/env node
// `agor init` only bootstraps SQLite installs, so a PostgreSQL install creates its
// config.yaml (deployment id, JWT and master secrets) here, once. An existing file
// is validated and never rewritten. Needs the built @agor/core (run after build.sh).
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  ensureInitialDeploymentConfig,
  getConfigPath,
  getDefaultConfig,
  prepareInitialDeploymentConfig,
} = await import(pathToFileURL(join(repoRoot, 'packages/core/dist/config/index.js')).href);

const defaults = getDefaultConfig();
const port = process.env.DAEMON_PORT ? Number(process.env.DAEMON_PORT) : defaults.daemon?.port;
if (!Number.isInteger(port) || port <= 0) {
  console.error(`DAEMON_PORT must be a port number, got "${process.env.DAEMON_PORT}"`);
  process.exit(1);
}

const result = await ensureInitialDeploymentConfig(
  prepareInitialDeploymentConfig({
    ...defaults,
    daemon: { ...defaults.daemon, port, host: process.env.DAEMON_HOST || defaults.daemon?.host },
    agentic_tools: { installed: ['claude-code'] },
  })
);

console.log(
  `${result.created ? 'Created' : 'Kept existing'} ${getConfigPath()} (deployment ${result.deploymentId})`
);
