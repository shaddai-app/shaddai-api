# Seguridad: revisión OWASP ASVS nivel 1

Revisión hecha el **2 de octubre de 2026** (Fase 8, tramo 2) sobre la API y la web. Cada fila dice cómo se cumple el control y dónde mirarlo. Si se cambia algo de esto, se actualiza acá en el mismo PR.

Estados: ✅ cumple · ⏳ pendiente con fecha o tramo · ➖ no aplica.

## V2 Autenticación

| Control                                                                                         | Estado | Cómo                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contraseñas de 10 a 128 caracteres, sin reglas de composición, rechazo de las comunes o fáciles | ✅     | `core/auth/password-policy.ts` (zxcvbn con diccionarios es/en/pt)                                                                                                                                                                                                                                                |
| Hash fuerte                                                                                     | ✅     | argon2id (`core/auth/password.ts`)                                                                                                                                                                                                                                                                               |
| Anti fuerza bruta                                                                               | ✅     | Rate limit por IP (`core/middleware/rate-limit.ts`, compartido entre instancias) + bloqueo progresivo por usuario (`core/auth/lockout.ts`)                                                                                                                                                                       |
| Mensajes que no revelan si el email existe                                                      | ✅     | Login y "olvidé mi contraseña" responden igual                                                                                                                                                                                                                                                                   |
| Recuperación con token de un solo uso y vencimiento                                             | ✅     | 30 minutos, se invalida al usarse y al pedir otro (`modules/auth/auth.service.ts`)                                                                                                                                                                                                                               |
| Segundo factor                                                                                  | ✅     | TOTP con secreto cifrado (`TOTP_ENC_KEY`): obligatorio para el superadmin, optativo para el resto. 10 códigos de recuperación hasheados, de un solo uso; desactivar o regenerar pide la contraseña; un admin con `usuarios.resetear` lo restablece; aviso por mail de cada cambio (`modules/auth/two-factor.ts`) |
| Sin credenciales por defecto                                                                    | ✅     | El seed genera una contraseña temporal aleatoria y obliga a cambiarla                                                                                                                                                                                                                                            |

## V3 Sesiones

| Control                                                        | Estado | Cómo                                                                                 |
| -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| Token de acceso corto y fuera del almacenamiento del navegador | ✅     | JWT de 15 minutos, solo en memoria                                                   |
| Refresh en cookie `HttpOnly`, `Secure`, `SameSite=Strict`      | ✅     | `modules/auth/auth.routes.ts`                                                        |
| Rotación del refresh y detección de reúso                      | ✅     | Un refresh reusado revoca toda la familia y queda auditado (`session.service.ts`)    |
| Vencimiento absoluto                                           | ✅     | La familia no se extiende más allá del login original (7 o 30 días)                  |
| Purga de sesiones vencidas                                     | ✅     | El programador borra las familias vencidas hace más de 7 días (`purgeRefreshTokens`) |
| Cerrar sesión y cambio de contraseña invalidan sesiones        | ✅     | Revocación de la familia; versión de contraseña dentro del JWT                       |
| CSRF                                                           | ✅     | `SameSite=Strict` + header propio + control de `Origin` (`core/middleware/csrf.ts`)  |

## V4 Control de acceso

| Control                                               | Estado | Cómo                                                                                                     |
| ----------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| Toda ruta exige permiso explícito                     | ✅     | `tenantRouter()` no deja registrar una ruta sin permiso; `permissions.test.ts` recorre todas (401 y 403) |
| Aislamiento entre iglesias                            | ✅     | `tenantDb()` filtra por cuenta; lint impide el cliente base en los módulos; tests A/B por módulo         |
| Lo de otra iglesia responde 404, no 403               | ✅     | No revela que el registro existe                                                                         |
| Datos sensibles por permiso de campo                  | ✅     | `personas.ver_sensibles`, diezmos nominales separados de totales                                         |
| Sesión de soporte (impersonación) limitada y auditada | ✅     | `forbidImpersonation` en acciones personales                                                             |

## V5 Validación y codificación

| Control                                   | Estado | Cómo                                                                             |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| Validación de toda entrada en el servidor | ✅     | zod en cada ruta (`core/http/validate.ts`)                                       |
| Sin inyección SQL                         | ✅     | Prisma parametrizado; SQL crudo solo en `core/db`, con plantillas parametrizadas |
| Sin XSS                                   | ✅     | React escapa; mails con `escapeHtml`; CSP sin `unsafe-inline` para scripts       |
| Inyección de fórmulas en CSV              | ✅     | `writeCsv` antepone `'` a celdas que empiezan con `= + - @`                      |

## V7 Errores y registros

| Control                                 | Estado | Cómo                                                                                                                                                          |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sin detalles internos en las respuestas | ✅     | 500 genérico con código; el detalle va al log con `requestId`                                                                                                 |
| Logs sin secretos                       | ✅     | pino con `redact` de headers de auth, cookies, contraseñas y tokens                                                                                           |
| Auditoría de acciones sensibles         | ✅     | `AuditLog` (login, permisos, finanzas, cambios de personas)                                                                                                   |
| Errores no previstos visibles           | ✅     | Sentry en API y web, sin datos personales: sin cuerpos, cookies, headers ni parámetros de URL (`core/observability/sentry.ts`, `src/app/sentry.ts` en la web) |
| Registro de lectura de fichas sensibles | ⏳     | Pedido en el plan maestro; queda para después de la beta                                                                                                      |

## V8 Protección de datos

| Control                                       | Estado | Cómo                                                                                                                                             |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Respuestas con datos personales no se cachean | ✅     | `Cache-Control: no-store` en toda la API                                                                                                         |
| Fotos sin metadatos                           | ✅     | Se recodifican a webp sin EXIF ni GPS (`core/files/files.service.ts`)                                                                            |
| Archivos privados                             | ✅     | Bucket privado; se sirven por la API con permiso por tipo de archivo                                                                             |
| Exportación y baja de cuenta con purga        | ✅     | ZIP completo sin credenciales (`/account/export`, auditado); baja solo del dueño con contraseña; purga a los 90 días (`core/db/account-data.ts`) |

## V9 Comunicaciones

| Control                           | Estado | Cómo                                                                                 |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| HTTPS en todo y HSTS              | ✅     | Azure termina TLS; HSTS de un año en API (helmet) y web (`staticwebapp.config.json`) |
| Base de datos cifrada en tránsito | ✅     | `DB_ENCRYPT=true`                                                                    |

## V10 Código malicioso y dependencias

| Control                         | Estado | Cómo                                                                                    |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| Versiones fijadas y lockfile    | ✅     | `--save-exact`; se eligen versiones con al menos una semana publicadas                  |
| Auditoría de dependencias en CI | ✅     | `npm audit --omit=dev --audit-level=high` en API y web                                  |
| Actualizaciones controladas     | ✅     | Dependabot mensual, agrupado, con 7 días de espera (`.github/dependabot.yml`)           |
| Secretos fuera del repo         | ✅     | gitleaks sobre todo el historial en CI; falsos positivos revisados en `.gitleaksignore` |

## V12 Archivos

| Control                                     | Estado | Cómo                                                                             |
| ------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| Tamaño máximo por subida                    | ✅     | multer con límites de 5 a 10 MB según el tipo                                    |
| Tipo real del archivo, no el declarado      | ✅     | `file-type` (magic bytes); SVG rechazado                                         |
| Archivos servidos sin poder ejecutar código | ✅     | `nosniff` + `Content-Security-Policy: sandbox` en `/files/:id` y el logo público |
| Rutas de almacenamiento seguras             | ✅     | Claves generadas por el servidor; el driver local impide salir de su carpeta     |

## V13 API

| Control                          | Estado | Cómo                                                          |
| -------------------------------- | ------ | ------------------------------------------------------------- |
| CORS con lista de orígenes       | ✅     | `CORS_ORIGINS`                                                |
| Límite de tamaño del cuerpo      | ✅     | `express.json({ limit: '1mb' })`                              |
| Formularios públicos contra bots | ✅     | Cloudflare Turnstile (obligatorio en producción) + rate limit |

## V14 Configuración

| Control                                          | Estado | Cómo                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headers de seguridad en la API                   | ✅     | helmet: CSP, HSTS, `nosniff`, `frame-ancestors`, sin `X-Powered-By`                                                                                                                                                                         |
| Headers de seguridad en la web                   | ✅     | CSP con hash del único script inline, `frame-ancestors 'none'`, `Permissions-Policy` (cámara y ubicación solo propias), `Referrer-Policy`. Se generan en el build (`build/security-headers.ts` en la web) y `vite preview` sirve los mismos |
| Configuración de producción validada al arrancar | ✅     | `config/env.ts`: SMTP obligatorio, Turnstile obligatorio, claves de S3 completas                                                                                                                                                            |
| Secretos solo por variables de entorno           | ✅     | `.env` fuera del repo; en Azure, secretos de Container Apps                                                                                                                                                                                 |

## Pendientes

- ⏳ **Escaneo dinámico** (OWASP ZAP baseline): el workflow `zap.yml` está listo; se corre contra staging apenas esté publicado (deploy.md, sección 7).
- ⏳ **Registro de lectura de fichas sensibles**: después de la beta.
- ⏳ **Texto legal** de la política de privacidad y los términos: borrador en la web, pendiente de revisión por un abogado (Ley 25.326).
