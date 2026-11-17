import { Module } from '@nestjs/common';
import { ConfigModule, DbModule, LoggerModule } from '@pixora/platform';

@Module({
  imports: [ConfigModule, LoggerModule.forRoot('bot'), DbModule],
})
export class AppModule {}
