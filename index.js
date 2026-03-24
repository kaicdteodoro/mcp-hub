import pino from 'pino';
import { pathToFileURL } from 'node:url';
import { loadHubConfig } from './config/load-config.js';
import { Registry } from './registry/registry.js';
import { ProcessManager } from './process-manager/process-manager.js';
import { Router } from './router/router.js';
import { HealthChecker } from './health/health.js';
import { buildTransport } from './transport/transport.js';

/**
 * @param {import('./config/load-config.js').HubConfigFile} hubConfig
 */
function createLogger(hubConfig) {
  const level = hubConfig.hub?.logLevel ?? process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV !== 'production';

  return pino({
    level,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true }
          }
        }
      : {})
  });
}

export async function main() {
  const hubConfig = await loadHubConfig();
  const logger = createLogger(hubConfig);

  const registry = new Registry(hubConfig.servers);
  const processManager = new ProcessManager(registry, logger, {
    requestTimeoutMs: hubConfig.hub?.requestTimeoutMs
  });
  const router = new Router(registry, processManager);
  const healthChecker = new HealthChecker(router, registry, logger);

  const app = await buildTransport({
    router,
    registry,
    processManager,
    healthChecker,
    logger,
    hub: hubConfig.hub ?? {}
  });

  await processManager.startAll();
  healthChecker.startAll();

  const host = hubConfig.hub?.host ?? '0.0.0.0';
  const port = Number(process.env.PORT) || hubConfig.hub?.port || 3333;

  try {
    await app.listen({ host, port });
  } catch (e) {
    healthChecker.stopAll();
    await processManager.stopAll();
    throw e;
  }
  logger.info({ host, port }, 'mcp-hub listening');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutdown');
    healthChecker.stopAll();
    await app.close();
    await processManager.stopAll();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

export { createLogger };

const isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
