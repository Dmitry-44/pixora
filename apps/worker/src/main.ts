import { NestFactory } from '@nestjs/core';
import { Logger } from '@pixora/platform';
import { AppModule } from './app.module.js';

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
  abortOnError: false,
});
const logger = app.get(Logger);
app.useLogger(logger);
app.enableShutdownHooks();

// An application context opens no sockets; keep the event loop alive until a shutdown signal.
setInterval(() => {}, 1 << 30);

logger.log('worker started');
