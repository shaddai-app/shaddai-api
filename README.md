# shaddai-api

API del SaaS **Shaddai** de administración de iglesias. Node.js 24 LTS · TypeScript · Express 5 · Prisma 7 · SQL Server.

## Requisitos

| Herramienta        | Versión                   | Instalación (Windows)                      |
| ------------------ | ------------------------- | ------------------------------------------ |
| Node.js            | 24 LTS                    | `winget install --id OpenJS.NodeJS.LTS -e` |
| Git                | 2.x                       | `winget install --id Git.Git -e`           |
| sqlcmd (go-sqlcmd) | 1.x                       | `winget install --id Microsoft.Sqlcmd -e`  |
| SQL Server         | 2022/2025 (Express sirve) | o Docker: `docker/compose.sqlserver.yml`   |

> El adapter `@prisma/adapter-mssql` **no soporta autenticación integrada de Windows**: la app usa un login SQL dedicado (`shaddai_app`).

## Puesta en marcha (PC nueva)

### 1. Configurar SQL Server (una sola vez por PC)

Necesitamos **modo de autenticación mixto** y **TCP/IP en el puerto 1433**. En una PowerShell **como administrador**:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-sqlserver.ps1 -Instance SQLEXPRESS -Port 1433
```

O manualmente:

1. SSMS → clic derecho en el servidor → Propiedades → Seguridad → _Modo de autenticación de SQL Server y Windows_.
2. SQL Server Configuration Manager (`SQLServerManager17.msc` para SQL 2025, `SQLServerManager16.msc` para 2022) → Configuración de red → Protocolos de SQLEXPRESS → **TCP/IP: Habilitado** → Direcciones IP → **IPAll**: _Puertos dinámicos TCP_ vacío, _Puerto TCP_ `1433`.
3. Reiniciar el servicio: `Restart-Service 'MSSQL$SQLEXPRESS'`.

### 2. Variables de entorno

```powershell
npm ci
npm run env:init -- --email tu-email@dominio.com   # crea .env con contraseñas/secretos aleatorios
```

`.env` nunca se commitea; `.env.example` documenta todas las variables.

### 3. Login SQL de la aplicación

```powershell
npm run db:sql-login    # usa tu usuario de Windows para crear shaddai_app con la contraseña de .env
```

### 4. Base de datos, migraciones y seed

```powershell
npm run db:setup        # prisma migrate deploy + generate + seed
```

Crea la base `Shaddai`, aplica todas las migraciones y siembra permisos, planes y el **superadmin (Id=1)**. La contraseña temporal del superadmin se imprime **una sola vez** en consola; en el primer login se exige cambiarla.

### 5. Levantar

```powershell
npm run dev             # http://localhost:3000/api/v1/health
```

## Scripts

| Script                                | Descripción                                                   |
| ------------------------------------- | ------------------------------------------------------------- |
| `dev`                                 | API con recarga (tsx watch)                                   |
| `build` / `start`                     | Compila a `dist/` / ejecuta build                             |
| `lint`, `typecheck`, `format`, `test` | Calidad                                                       |
| `env:init`                            | Genera `.env` desde `.env.example`                            |
| `db:sql-login`                        | Crea/actualiza el login SQL `shaddai_app`                     |
| `db:migrate`                          | `prisma migrate dev` — crear una migración nueva (desarrollo) |
| `db:deploy`                           | Aplica migraciones pendientes                                 |
| `db:seed`                             | Seed idempotente                                              |
| `db:setup`                            | deploy + generate + seed (PC nueva)                           |
| `db:reset`                            | Borra y recrea la base (solo desarrollo)                      |
| `db:studio`                           | Prisma Studio                                                 |
| `db:backup`                           | Backup `.bak` en `backups/`                                   |

## Estructura

```
prisma/schema/*.prisma   schema multi-archivo por módulo
prisma/migrations/       migraciones versionadas
prisma/seed/             seed idempotente
src/config/              validación de entorno (zod)
src/core/                db, auth, rbac, http, middleware, logger
src/modules/<módulo>/    routes, service, schemas, tests
scripts/                 setup SQL Server, login, backup, env
```

## Seguridad y multi-tenant

Toda tabla de negocio lleva `accountId`; el aislamiento se aplica en la API, nunca confiando en el front.

**Cómo se escribe un módulo de negocio:**

```ts
const t = tenantRouter(); // no se puede registrar una ruta sin permiso
t.get('/campuses', 'account-user', handler); // cualquier usuario de la cuenta
t.post('/campuses', 'estructura.gestionar', handler); // permiso requerido (o array = cualquiera)

// dentro del handler: SIEMPRE tenantDb(), que filtra por la cuenta de la sesión
await tenantDb().campus.findMany();
await tenantDb().campus.create({ data: { ...data, accountId: currentAccountId() } });
```

- `tenantRouter()` encadena autenticación → usuario de cuenta → (escrituras) cuenta no en solo lectura → permiso.
- `tenantDb()` agrega `accountId` a toda lectura/escritura, fuerza el `accountId` en los create, impide mover filas de cuenta y filtra tablas hijas (`UserRole`, `RolePermission`…) por su padre. Un registro de otra cuenta responde **404**, igual que uno inexistente.
- Un modelo nuevo con `accountId` debe agregarse a `TENANT_MODELS` (`src/core/db/tenant.ts`); un test unitario falla si falta.
- Lint: los módulos no pueden importar el cliente Prisma base y SQL crudo (`$queryRaw`) solo se permite en `src/core/db`.
- Tests: `test/integration/permissions.test.ts` recorre **todas** las rutas registradas (401 sin token, 403 sin permiso); cada módulo suma sus tests de aislamiento A/B.

Ver [CONTRIBUTING.md](CONTRIBUTING.md) para ramas y commits.
