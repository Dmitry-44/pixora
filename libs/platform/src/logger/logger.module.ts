import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { CONFIG, type Config } from '../config/config.js';

@Module({})
export class LoggerModule {
  static forRoot(app: string): DynamicModule {
    return {
      module: LoggerModule,
      imports: [
        PinoLoggerModule.forRootAsync({
          inject: [CONFIG],
          useFactory: (config: Config) => ({
            pinoHttp: { level: config.LOG_LEVEL, base: { app } },
          }),
        }),
      ],
    };
  }
}
