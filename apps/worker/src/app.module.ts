import { Module } from '@nestjs/common';
import { ConfigModule, DbModule, LoggerModule } from '@pixora/platform';

@Module({
  imports: [ConfigModule, LoggerModule.forRoot('worker'), DbModule],
})
export class AppModule {}
