# Producción: decisiones e infraestructura

Este documento registra **qué se eligió para producción, por qué y qué falta hacer**. Es la fuente de verdad: si cambia una decisión o un paso, se actualiza acá en el mismo PR.

Decidido el **2 de octubre de 2026** (Fase 8). Los precios son aproximados a esa fecha: confirmarlos en cada proveedor antes de contratar.

## Resumen

| Pieza                | Elegido                                                                     | Alternativa descartada      |
| -------------------- | --------------------------------------------------------------------------- | --------------------------- |
| Base de datos        | **Azure SQL Database**, oferta gratuita serverless, región **Brazil South** | SQL Server en un VPS propio |
| API                  | **Azure Container Apps**, Brazil South, **mínimo 1 réplica**                | VPS con Docker              |
| Web (front)          | **Azure Static Web Apps**, plan gratuito                                    | Cloudflare Pages            |
| Archivos             | **Cloudflare R2** (`STORAGE_DRIVER=s3`)                                     | Disco del servidor          |
| Dominio              | **`.com` comprado en Cloudflare Registrar**. El nombre está _pendiente_     | `.com.ar` solo              |
| Mail (SMTP)          | **Brevo**, plan gratuito de 300 mails por día                               | Resend                      |
| Errores              | **Sentry**, plan gratuito                                                   | Solo logs                   |
| Formularios públicos | **Cloudflare Turnstile**, ya integrado                                      | —                           |

## Por qué

### Azure en vez de un VPS

- La base guarda datos sensibles (notas pastorales, diezmos con nombre; Ley 25.326). Azure SQL hace **backups automáticos con restauración a cualquier momento** (7 a 35 días) y aplica los parches. En un VPS todo eso queda a cargo nuestro.
- **Costo en la beta casi nulo**:
  - la oferta gratuita de Azure SQL (serverless) cubre una base chica;
  - Container Apps tiene una cuota gratuita mensual;
  - con varias iglesias se estima entre USD 30 y 80 por mes.
- **Brazil South (São Paulo)** es la región más cercana a Argentina.
- Contra: más caro que un VPS de USD 8–15 por mes cuando crece, y más atado al proveedor. Igual la API es un contenedor Docker estándar, así que mudarla es posible.

### Cloudflare para el dominio

- Cloudflare Registrar cobra **precio de costo** (un `.com` ronda USD 10 por año) y no sube la renovación.
- Se gestionan juntos el DNS, R2 y Turnstile.
- `.com` y no `.com.ar`, porque la app está en es/en/pt. Si se quiere el `.com.ar`, se registra aparte en NIC Argentina (pide CUIT) y se redirige; Cloudflare no lo vende.

### Brevo en vez de Resend

- **300 mails por día gratis**, contra los 100 por día de Resend. El aviso diario, los turnos y las recuperaciones de contraseña de pocas iglesias superan rápido los 100.
- Empresa europea, con buen manejo de datos personales.
- La API usa **SMTP común**: cambiar de proveedor es cambiar cuatro variables, sin tocar código.

## Arquitectura

```
                 Cloudflare DNS (<dominio>.com)
                 ├─ app.<dominio>  → Azure Static Web Apps  (front React)
                 └─ api.<dominio>  → Azure Container Apps   (API Node, ≥1 réplica)
                                       ├─ Azure SQL Database (Brazil South)
                                       ├─ Cloudflare R2      (archivos, bucket privado)
                                       ├─ Brevo SMTP         (mails desde no-reply@<dominio>)
                                       └─ Sentry             (errores)
```

- Hay dos entornos, **staging** y **producción**, cada uno con su base, su bucket y sus secretos. El deploy sale desde GitHub Actions (tramo 4 de la Fase 8).

## Detalles que no hay que olvidar

- **Container Apps con `minReplicas: 1`.**
  - El aviso diario de vencidos corre _dentro_ de la API (`src/jobs/scheduler.ts`). Si escala a cero, no sale.
  - Con varias réplicas no hay problema: el aviso se traba por iglesia y día en la base (`DailyJobRun`), y el rate limit se cuenta en la base (`RATE_LIMIT_STORE=db`, por defecto en producción).
- **Oferta gratuita de Azure SQL**: al crear la base, elegir que **siga funcionando y cobre el excedente** cuando se termine la cuota del mes. La otra opción pausa la base y la app queda caída hasta el mes siguiente.
- **Bucket de R2 privado**, sin acceso público: los archivos se sirven siempre por la API, que controla permisos.
- **Logins SQL separados**: uno para migrar (crea tablas) y otro para la app (solo lee y escribe datos). Se arma en el tramo 4.
- **Mail**: en producción `MAIL_TRANSPORT` tiene que ser `smtp`; la API no arranca con `console`.
- **Contacto de soporte**: `SUPPORT_EMAIL` (API, mail de baja) y `VITE_SUPPORT_EMAIL` (web, política de privacidad y términos) tienen que ser una casilla real que alguien lea.
- **Baja de una iglesia**: la pide el dueño de la cuenta desde Configuración → Datos de la iglesia. La cuenta queda cerrada (nadie entra) y el programador la **borra definitivamente a los 90 días**: datos, archivos del bucket y auditoría. Para revertirla antes, el superadmin la reactiva desde el panel de plataforma (vuelve a `active` y se cancela la purga).
- **Backups y purga**: los backups de Azure SQL conservan datos hasta 35 días después de la purga. Así lo tiene que decir la política de privacidad.
- **Turnstile**: `TURNSTILE_SECRET` es obligatorio en producción.
- **Sentry**: un proyecto para la API (`SENTRY_DSN`) y otro para la web (`VITE_SENTRY_DSN`, se fija al compilar). `SENTRY_RELEASE` / `VITE_SENTRY_RELEASE` = commit desplegado. No se mandan datos personales; ver [seguridad.md](seguridad.md).
- **Headers de la web**: el build genera `dist/staticwebapp.config.json` con la CSP. La CSP permite conectarse solo a la API y a Sentry configurados _al compilar_: si cambia el dominio de la API, hay que recompilar.
- **Dependabot**: abre PRs una vez por mes. Revisarlas como cualquier otra (CI completo antes de mergear).
- **Secretos**: nunca en el repo. Van en los secretos de Container Apps y de GitHub Actions. Las variables están documentadas en `.env.example`.

## Registros DNS (cuando haya dominio)

| Registro                                                                  | Para qué                                                        |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `app` CNAME → Static Web Apps                                             | Front                                                           |
| `api` CNAME → Container Apps (+ TXT `asuid.api` de verificación)          | API                                                             |
| TXT SPF `v=spf1 include:spf.brevo.com ~all` (confirmar el valor en Brevo) | Que Brevo pueda mandar por el dominio                           |
| CNAME/TXT DKIM que da Brevo                                               | Firma de los mails                                              |
| TXT `_dmarc` `v=DMARC1; p=quarantine; rua=mailto:<casilla>`               | Política anti-suplantación (arrancar con `p=none` unas semanas) |
| TXT de verificación de Brevo                                              | Validar el dominio remitente                                    |

Los CNAME hacia Azure van con el proxy de Cloudflare **apagado** (nube gris), así Azure puede emitir y renovar los certificados.

## Checklist: qué hace quién

### Lo hace el dueño (requiere tarjeta, datos fiscales o cuentas personales)

- [ ] Elegir el nombre del dominio y comprarlo en Cloudflare Registrar.
- [ ] Crear la cuenta de Azure (suscripción de pago por uso; la oferta gratuita de SQL se activa al crear la base).
- [ ] Crear la cuenta de Brevo y validar el dominio remitente (los registros DNS los puede cargar Claude).
- [ ] Crear la cuenta de Sentry (plan Developer gratuito).
- [ ] Activar R2 en la cuenta de Cloudflare (pide medio de pago aunque el uso chico sea gratis).
- [ ] Revisar con un abogado la política de privacidad y los términos (Ley 25.326) antes de abrir la beta.
- [ ] Definir precios de los planes Básico, Estándar y Pro.

### Lo hace Claude en el código (Fase 8)

- [x] Tramo 1: rate limit compartido en la base y driver S3/R2 (shaddai-app/shaddai-api#27).
- [x] Tramo 2: Sentry en la API y la web, headers de seguridad y CSP, revisión OWASP ASVS L1 ([seguridad.md](seguridad.md)), gitleaks, `npm audit` y Dependabot en CI.
- [x] Tramo 3: páginas de privacidad y términos (borrador), exportación de datos de la iglesia, baja de cuenta con purga a los 90 días.
- [ ] Tramo 4: Dockerfile, deploy desde CI a staging y producción, logins SQL de migración y de app, backup y restauración probada, configuración de DNS y mail.

## Pendientes de decidir

- **Nombre del dominio**: chequear disponibilidad de algunas variantes (por ejemplo `shaddaiapp.com`) antes de comprar.
- **Precios** de los planes y límites por defecto (propuesta: 5/15/40 usuarios; 1/5/20 GB).
