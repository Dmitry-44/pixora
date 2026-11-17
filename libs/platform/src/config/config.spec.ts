import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const DATABASE_URL = 'postgres://pixora:s3cret-password@postgres:5432/pixora';

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('returns typed config for a valid env', () => {
    expect(loadConfig({ DATABASE_URL, LOG_LEVEL: 'debug' })).toEqual({
      DATABASE_URL,
      LOG_LEVEL: 'debug',
    });
  });

  it('defaults LOG_LEVEL to info', () => {
    expect(loadConfig({ DATABASE_URL }).LOG_LEVEL).toBe('info');
  });

  it('rejects a missing DATABASE_URL by name', () => {
    expect(errorOf(() => loadConfig({ LOG_LEVEL: 'info' })).message).toContain('DATABASE_URL');
  });

  it('rejects a non-postgres DATABASE_URL by name', () => {
    expect(
      errorOf(() => loadConfig({ DATABASE_URL: 'https://example.com' })).message,
    ).toContain('DATABASE_URL');
  });

  it('rejects an invalid LOG_LEVEL by name', () => {
    const error = errorOf(() => loadConfig({ DATABASE_URL, LOG_LEVEL: 'verbose' }));
    expect(error.message).toContain('LOG_LEVEL');
    expect(error.message).not.toContain('DATABASE_URL');
  });

  it('does not leak values into the error', () => {
    const badUrl = 'mysql://pixora:s3cret-password@db/pixora';
    const error = errorOf(() => loadConfig({ DATABASE_URL: badUrl, LOG_LEVEL: 'verbose' }));
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('LOG_LEVEL');
    expect(error.message).not.toContain('s3cret-password');
    expect(error.message).not.toContain('mysql');
    expect(error.message).not.toContain('verbose');
    expect(error.cause).toBeUndefined();
  });
});
