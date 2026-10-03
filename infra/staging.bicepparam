// Parámetros del entorno staging. Los valores con TU-DOMINIO se completan cuando esté comprado el
// dominio; los secretos NO van acá: se leen de variables de entorno al aplicar (ver docs/deploy.md).
using 'main.bicep'

param environment = 'staging'

param apiImage = readEnvironmentVariable('API_IMAGE', 'ghcr.io/shaddai-app/shaddai-api:main')
param migratorImage = readEnvironmentVariable('MIGRATOR_IMAGE', 'ghcr.io/shaddai-app/shaddai-api-migrator:main')
param registryUsername = readEnvironmentVariable('GHCR_USERNAME')
param registryPassword = readEnvironmentVariable('GHCR_TOKEN')

param appUrl = 'https://app-staging.TU-DOMINIO.com'
param corsOrigins = 'https://app-staging.TU-DOMINIO.com'

param sqlAdminPassword = readEnvironmentVariable('SQL_ADMIN_PASSWORD')
param dbAppPassword = readEnvironmentVariable('DB_APP_PASSWORD')
param dbMigratorPassword = readEnvironmentVariable('DB_MIGRATOR_PASSWORD')

param jwtAccessSecret = readEnvironmentVariable('JWT_ACCESS_SECRET')
param totpEncKey = readEnvironmentVariable('TOTP_ENC_KEY')
param seedSuperadminEmail = readEnvironmentVariable('SEED_SUPERADMIN_EMAIL')

param smtpUser = readEnvironmentVariable('SMTP_USER')
param smtpPassword = readEnvironmentVariable('SMTP_PASSWORD')
param mailFrom = 'Shaddai <no-reply@TU-DOMINIO.com>'
param supportEmail = 'soporte@TU-DOMINIO.com'

param s3Endpoint = readEnvironmentVariable('S3_ENDPOINT')
param s3Bucket = 'shaddai-staging'
param s3AccessKeyId = readEnvironmentVariable('S3_ACCESS_KEY_ID')
param s3SecretAccessKey = readEnvironmentVariable('S3_SECRET_ACCESS_KEY')

param turnstileSecret = readEnvironmentVariable('TURNSTILE_SECRET')
param turnstileSiteKey = readEnvironmentVariable('TURNSTILE_SITE_KEY')
param sentryDsn = readEnvironmentVariable('SENTRY_DSN', '')

// Cobro con Mercado Pago: 'none' hasta tener las credenciales (los pagos se registran a mano).
param billingProvider = 'none'
param mpAccessToken = readEnvironmentVariable('MP_ACCESS_TOKEN', '')
param mpWebhookSecret = readEnvironmentVariable('MP_WEBHOOK_SECRET', '')
