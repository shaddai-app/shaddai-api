// Crea .env a partir de .env.example generando secretos aleatorios.
// Uso: npm run env:init -- [--email superadmin@dominio.com] [--force]
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : '';

if (existsSync('.env') && !force) {
  console.error('.env ya existe. Usá --force para regenerarlo (se pierden los valores actuales).');
  process.exit(1);
}

// Alfanumérica con mayúscula, minúscula y dígito: cumple la política de SQL Server y no requiere escape.
function dbPassword(length = 24) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  return chars.sort(() => randomInt(3) - 1).join('');
}

const generated = {
  DB_PASSWORD: dbPassword(),
  JWT_ACCESS_SECRET: randomBytes(64).toString('base64url'),
  TOTP_ENC_KEY: randomBytes(32).toString('base64'),
  SEED_DEMO_PASSWORD: dbPassword(20),
  ...(email ? { SEED_SUPERADMIN_EMAIL: email } : {}),
};

const content = readFileSync('.env.example', 'utf8')
  .split(/\r?\n/)
  .map((line) => {
    const key = line.split('=')[0];
    return key in generated ? `${key}=${generated[key]}` : line;
  })
  .join('\n');

writeFileSync('.env', content, { encoding: 'utf8', flag: 'w' });
console.log('✔ .env creado con DB_PASSWORD, JWT_ACCESS_SECRET y TOTP_ENC_KEY aleatorios.');
if (!email) console.log('  Completá SEED_SUPERADMIN_EMAIL antes de correr db:setup.');
