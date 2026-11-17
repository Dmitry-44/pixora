import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const generationStatuses = ['accepted', 'submitted', 'completed', 'failed'] as const;

export const failureReasons = [
  'moderation',
  'insufficient_funds',
  'invalid_request',
  'misconfigured',
  'provider_failed',
  'provider_unavailable',
  'timeout',
  'internal',
] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

export const generations = pgTable(
  'generations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    status: text('status', { enum: generationStatuses }).notNull(),
    userPrompt: text('user_prompt').notNull(),
    modelPrompt: text('model_prompt').notNull(),
    modelParams: jsonb('model_params').notNull(),
    model: text('model').notNull(),
    polzaGenerationId: text('polza_generation_id'),
    resultUrl: text('result_url'),
    costRub: numeric('cost_rub'),
    failureReason: text('failure_reason', { enum: failureReasons }),
    attempts: integer('attempts').notNull().default(0),
    pollCount: integer('poll_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveryFailedAt: timestamp('delivery_failed_at', { withTimezone: true }),
  },
  (t) => [
    unique('generations_chat_id_message_id_unique').on(t.chatId, t.messageId),
    check('generations_status_check', sql`${t.status} IN (${inList(generationStatuses)})`),
    check(
      'generations_failure_reason_check',
      sql`${t.failureReason} IN (${inList(failureReasons)})`,
    ),
  ],
);
