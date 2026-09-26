// Valores mínimos para que env.ts valide en tests unitarios (sin DB real).
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:5173',
  CORS_ORIGINS: 'http://localhost:5173',
  DB_HOST: 'localhost',
  DB_NAME: 'Shaddai_test',
  DB_USER: 'test',
  DB_PASSWORD: 'test',
  JWT_ACCESS_SECRET: 'x'.repeat(64),
  TOTP_ENC_KEY: Buffer.alloc(32).toString('base64'),
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
