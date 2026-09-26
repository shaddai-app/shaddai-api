// Ejecuta scripts/sql/01-setup-login.sql con autenticación de Windows usando los valores de .env.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';

const { SQL_ADMIN_SERVER = 'localhost,1433', DB_USER, DB_PASSWORD } = process.env;
if (!DB_USER || !DB_PASSWORD) {
  console.error('Faltan DB_USER / DB_PASSWORD en .env (corré npm run env:init).');
  process.exit(1);
}

const result = spawnSync(
  'sqlcmd',
  [
    '-S',
    SQL_ADMIN_SERVER,
    '-E', // tu usuario de Windows
    '-C', // confiar en el certificado local
    '-b', // cortar ante error
    '-i',
    'scripts/sql/01-setup-login.sql',
    '-v',
    `APP_LOGIN=${DB_USER}`,
    `APP_PASSWORD=${DB_PASSWORD}`,
  ],
  { stdio: 'inherit', shell: false },
);
process.exit(result.status ?? 1);
