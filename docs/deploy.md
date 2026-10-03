# Deploy: guía paso a paso

Cómo se arma un entorno de Shaddai (**staging** o **producción**) desde cero en Azure, cómo se publica cada versión y cómo se restaura la base. Las decisiones y el porqué están en [produccion.md](produccion.md); acá van los pasos.

Todo lo que se puede automatizar ya está en el repo:

| Qué                                       | Dónde                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| Imagen de la API y del job de migraciones | `Dockerfile` (targets `runtime` y `migrator`)                                   |
| Infraestructura de Azure                  | `infra/main.bicep` + `infra/staging.bicepparam` / `infra/production.bicepparam` |
| Usuarios de la base (migración y app)     | `scripts/sql/02-azure-db-users.sql`                                             |
| Publicación (imágenes, migraciones, API)  | `.github/workflows/deploy.yml` (API) y el de la web en shaddai-web              |
| Escaneo de seguridad                      | `.github/workflows/zap.yml`                                                     |
| Backup y restauración local               | `npm run db:backup`, `npm run db:restore`                                       |

El CI de cada PR ya prueba la imagen de punta a punta: crea una base vacía con el job de migraciones (en modo producción, dos veces) y levanta la API contra ella hasta que responde `/health/ready`.

## 0. Antes de empezar

En la PC (PowerShell; la instalación de Azure CLI pide administrador):

```powershell
winget install --id Microsoft.AzureCLI -e
az bicep install
az login
```

Para guardar los secretos de cada entorno hace falta un **gestor de contraseñas** (Bitwarden, 1Password…). Se generan una vez y se vuelven a usar en cada actualización de la infraestructura; nunca van al repo ni al chat.

## 1. Cuentas (las crea el dueño)

- [ ] **Dominio** en Cloudflare Registrar. En los ejemplos: `TU-DOMINIO.com`.
- [ ] **Azure**: suscripción de pago por uso.
- [ ] **Cloudflare R2**: activarlo en la cuenta de Cloudflare.
- [ ] **Brevo**: cuenta gratuita.
- [ ] **Sentry**: plan Developer gratuito.

## 2. Servicios externos (una vez por entorno salvo que se indique)

### Archivos: Cloudflare R2

1. Crear un bucket **privado** por entorno: `shaddai-staging` y `shaddai-production`.
2. _R2 → Manage API tokens → Create API token_: permiso **Object Read & Write**, limitado a ese bucket.
3. Guardar en el gestor de contraseñas el **Access Key ID** y el **Secret Access Key**, y el endpoint `https://<id de cuenta>.r2.cloudflarestorage.com`.

### Mail: Brevo (una vez)

1. _Senders, domains → Domains → Add a domain_: `TU-DOMINIO.com`.
2. Cargar en el DNS de Cloudflare los registros que muestra Brevo (verificación, DKIM) y además:
   - SPF: `TXT @ "v=spf1 include:spf.brevo.com ~all"` (confirmar el valor en Brevo).
   - DMARC: `TXT _dmarc "v=DMARC1; p=none; rua=mailto:soporte@TU-DOMINIO.com"`. Después de unas semanas sin problemas, pasar a `p=quarantine`.
3. _SMTP & API → SMTP_: crear una **SMTP key**. Usuario = el login SMTP que muestra esa pantalla; servidor `smtp-relay.brevo.com`, puerto `587`.

### Errores: Sentry (una vez)

Dos proyectos: **shaddai-api** (Node.js) y **shaddai-web** (React). Copiar el DSN de cada uno.

### Formularios públicos: Cloudflare Turnstile (una vez)

_Turnstile → Add widget_, con los hostnames `app.TU-DOMINIO.com` y `app-staging.TU-DOMINIO.com`. Guardar la site key y la secret key.

### Imágenes: token de GitHub (una vez)

Azure baja las imágenes privadas de GHCR con un **token clásico** de GitHub con solo el permiso `read:packages` (_Settings → Developer settings → Personal access tokens → Tokens (classic)_). Ponerle vencimiento de un año y anotar la fecha para renovarlo: si vence, Azure no puede bajar imágenes nuevas.

## 3. Infraestructura en Azure (por entorno)

Las imágenes tienen que existir antes: se publican solas en GHCR con cada merge a `main` (workflow **Deploy**, paso _images_).

En PowerShell, cargar los secretos del entorno **en la sesión** (copiados del gestor de contraseñas; no quedan en el historial si se pegan en `Read-Host`):

```powershell
$env:GHCR_USERNAME = '<usuario de GitHub>'
$env:GHCR_TOKEN = Read-Host 'Token de GHCR'
$env:SQL_ADMIN_PASSWORD = Read-Host 'Admin SQL'
$env:DB_APP_PASSWORD = Read-Host 'Usuario de la app'
$env:DB_MIGRATOR_PASSWORD = Read-Host 'Usuario de migración'
$env:JWT_ACCESS_SECRET = Read-Host 'JWT (64+ caracteres)'
$env:TOTP_ENC_KEY = Read-Host 'TOTP (32 bytes en base64)'
$env:SEED_SUPERADMIN_EMAIL = '<mail del superadmin>'
$env:SMTP_USER = '<login SMTP de Brevo>'
$env:SMTP_PASSWORD = Read-Host 'SMTP key de Brevo'
$env:S3_ENDPOINT = 'https://<id de cuenta>.r2.cloudflarestorage.com'
$env:S3_ACCESS_KEY_ID = Read-Host 'R2 access key id'
$env:S3_SECRET_ACCESS_KEY = Read-Host 'R2 secret'
$env:TURNSTILE_SECRET = Read-Host 'Turnstile secret'
$env:TURNSTILE_SITE_KEY = '<site key de Turnstile>'
$env:SENTRY_DSN = '<DSN de shaddai-api>'
```

Para generar los secretos nuevos (una vez por entorno y guardarlos en el gestor):

```powershell
node -e "const c=require('crypto');console.log('JWT:',c.randomBytes(48).toString('base64url'));console.log('TOTP:',c.randomBytes(32).toString('base64'));for(const n of ['SQL admin','DB app','DB migrator'])console.log(n+':',c.randomBytes(18).toString('base64url')+'aA1!')"
```

Completar en `infra/<entorno>.bicepparam` los valores con `TU-DOMINIO` (por PR, no son secretos) y aplicar:

```powershell
az group create -n shaddai-staging -l brazilsouth
az deployment group create -g shaddai-staging -f infra/main.bicep -p infra/staging.bicepparam
```

Volver a correr el mismo comando aplica cualquier cambio de la plantilla; no borra datos.

> **Al crear la base**: la plantilla ya pide la oferta gratuita con `BillOverUsage` (cuando se termina la cuota del mes, sigue andando y cobra el excedente). Revisar en el portal (_SQL database → Compute + storage_) que figure así.

### Usuarios de la base

La primera vez, con una regla temporal de firewall para la IP propia:

```powershell
$ip = (Invoke-RestMethod https://api.ipify.org)
az sql server firewall-rule create -g shaddai-staging -s shaddai-staging-sql -n setup-temporal --start-ip-address $ip --end-ip-address $ip
sqlcmd -S shaddai-staging-sql.database.windows.net -d shaddai -U shaddai_admin -P $env:SQL_ADMIN_PASSWORD -C `
  -i scripts/sql/02-azure-db-users.sql -v MIGRATOR_PASSWORD="$env:DB_MIGRATOR_PASSWORD" APP_PASSWORD="$env:DB_APP_PASSWORD"
az sql server firewall-rule delete -g shaddai-staging -s shaddai-staging-sql -n setup-temporal
```

La app entra como `shaddai_app` (solo lee y escribe datos) y el job de migraciones como `shaddai_migrator`. El admin SQL queda solo para emergencias.

### Primera migración y superadmin

```powershell
az containerapp job start -g shaddai-staging -n shaddai-staging-migrate
```

El seed crea el superadmin con `SEED_SUPERADMIN_EMAIL` **sin imprimir contraseña** (los logs del job quedan guardados). Para entrar: `https://app-staging.TU-DOMINIO.com/olvide-contrasena` → llega el enlace por mail → definir la contraseña → enrolar la verificación en dos pasos.

## 4. Dominios

### API (Container Apps)

1. En Cloudflare DNS, con el proxy **apagado** (nube gris):
   - `CNAME api-staging → <apiFqdn>` (sale en la salida del deployment).
   - `TXT asuid.api-staging → <id de verificación>`: `az containerapp show -g shaddai-staging -n shaddai-staging-api --query properties.customDomainVerificationId -o tsv`.
2. Agregar el dominio con certificado administrado:
   ```powershell
   az containerapp hostname add -g shaddai-staging -n shaddai-staging-api --hostname api-staging.TU-DOMINIO.com
   az containerapp hostname bind -g shaddai-staging -n shaddai-staging-api --hostname api-staging.TU-DOMINIO.com --environment shaddai-staging-env --validation-method CNAME
   ```

### Web (Static Web Apps)

1. `CNAME app-staging → <webHostname>` (proxy apagado).
2. `az staticwebapp hostname set -g shaddai-staging -n shaddai-staging-web --hostname app-staging.TU-DOMINIO.com`

En producción: `api` y `app` en lugar de `api-staging` y `app-staging`.

## 5. Publicación automática (GitHub Actions)

### Identidad de GitHub en Azure (sin secretos, con OIDC)

Una identidad por entorno, con permiso solo sobre su grupo de recursos:

```powershell
$rg = 'shaddai-staging'; $envName = 'staging'
az identity create -g $rg -n "github-$envName"
$clientId = az identity show -g $rg -n "github-$envName" --query clientId -o tsv
$principal = az identity show -g $rg -n "github-$envName" --query principalId -o tsv
az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal --role Contributor --scope (az group show -n $rg --query id -o tsv)
foreach ($repo in 'shaddai-api','shaddai-web') {
  az identity federated-credential create -g $rg --identity-name "github-$envName" -n "$repo-$envName" `
    --issuer https://token.actions.githubusercontent.com --subject "repo:shaddai-app/${repo}:environment:$envName" `
    --audiences api://AzureADTokenExchange
}
```

### Entornos de GitHub

En cada repo, _Settings → Environments_: `staging` y `production`. En **production**, activar _Required reviewers_ (uno mismo): así nada sale a producción sin un clic de aprobación.

**shaddai-api**, variables de cada entorno:

| Variable                | Valor                                                               |
| ----------------------- | ------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`       | `clientId` de la identidad del entorno                              |
| `AZURE_TENANT_ID`       | `az account show --query tenantId -o tsv`                           |
| `AZURE_SUBSCRIPTION_ID` | `az account show --query id -o tsv`                                 |
| `AZURE_RESOURCE_GROUP`  | `shaddai-staging` / `shaddai-production`                            |
| `API_URL`               | `https://api-staging.TU-DOMINIO.com` / `https://api.TU-DOMINIO.com` |

Variables del **repositorio** (no del entorno): `DEPLOY_ENABLED` = `true` (enciende la publicación) y `STAGING_APP_URL` = `https://app-staging.TU-DOMINIO.com` (lo usa el escaneo ZAP).

**shaddai-web**: ver _Deploy_ en el README de la web (token de Static Web Apps y variables `VITE_*` por entorno).

### Cómo sale cada versión

1. Merge a `main` → se publican las imágenes y **staging se actualiza solo**: corre el job de migraciones y, si termina bien, la API pasa a la imagen nueva y se verifica `/health/ready`. Si las migraciones fallan, la API sigue con la versión anterior.
2. Probar en staging.
3. _Actions → Deploy → Run workflow_ con `production` y el **sha** probado → aprobar → mismo proceso en producción.

Volver atrás una versión: correr **Deploy** con el sha anterior. Ojo: las migraciones no se deshacen; por eso siempre se escriben compatibles con la versión anterior de la API (agregar antes de quitar).

## 6. Backups y restauración

### Qué hay

- Azure SQL hace backups automáticos y permite **restaurar a cualquier momento de los últimos 14 días** (`backupRetentionDays` en la plantilla, hasta 35).
- Los archivos están en R2, que replica internamente; la purga de una iglesia los borra a propósito.

### Simulacro de restauración (una vez por mes, y antes de abrir la beta)

```powershell
$t = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('yyyy-MM-ddTHH:mm:ssZ')
az sql db restore -g shaddai-production -s shaddai-production-sql -n shaddai --dest-name shaddai-restore-check --time $t
# Con la regla temporal de firewall (sección 3), comparar filas de algunas tablas:
sqlcmd -S shaddai-production-sql.database.windows.net -d shaddai-restore-check -U shaddai_admin -P $env:SQL_ADMIN_PASSWORD -C `
  -Q "SELECT COUNT(*) FROM Person; SELECT COUNT(*) FROM FinanceMovement; SELECT TOP 1 migration_name FROM _prisma_migrations ORDER BY finished_at DESC"
az sql db delete -g shaddai-production -s shaddai-production-sql -n shaddai-restore-check --yes
```

Anotar la fecha del simulacro en el checklist de [produccion.md](produccion.md).

### Restauración real (se perdieron o dañaron datos)

1. Restaurar a una base nueva al momento anterior al problema (comando de arriba, con `--dest-name shaddai-restaurada`).
2. Revisar que estén los datos.
3. Cambiar de base: `az sql db rename -g … -s … -n shaddai --new-name shaddai-danada` y después `az sql db rename … -n shaddai-restaurada --new-name shaddai`.
4. Reiniciar la API (`az containerapp revision restart`). Los usuarios `shaddai_app` y `shaddai_migrator` son de la base, así que vienen con la copia.
5. Borrar `shaddai-danada` cuando ya no haga falta.

### Local

`npm run db:backup` genera y verifica un `.bak` en la carpeta de backups de la instancia; `npm run db:restore -- -File <ruta.bak> -Drop` lo restaura en una base nueva, compara las filas de todas las tablas con la original y la borra. Probado: 61 tablas idénticas y la API respondiendo contra la copia.

## 7. Escaneo de seguridad (ZAP)

_Actions → Escaneo de seguridad (ZAP) → Run workflow_: escanea `STAGING_APP_URL` (o la URL que se indique) en modo pasivo y deja el reporte como artefacto. Correrlo antes de cada salida a producción importante y anotar los hallazgos en [seguridad.md](seguridad.md).

## 8. Antes de abrir la beta

- [ ] Staging andando de punta a punta: login, alta de una iglesia desde el panel, un mail real (Brevo), subir una foto (R2), un error de prueba visible en Sentry.
- [ ] Escaneo ZAP sin hallazgos altos.
- [ ] Simulacro de restauración hecho.
- [ ] Textos legales revisados (`LEGAL_DRAFT = false` en la web).
- [ ] Producción creada, con dominio y aprobación obligatoria en GitHub.
- [ ] Iglesia piloto dada de alta.
