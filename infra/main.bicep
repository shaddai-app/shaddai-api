// Infraestructura de un entorno de Shaddai (staging o producción) en Azure. Idempotente: se vuelve a
// aplicar con el mismo comando y solo cambia lo que difiere. Uso y pasos previos: docs/deploy.md.
//
//   az deployment group create -g shaddai-<entorno> -f infra/main.bicep -p infra/<entorno>.bicepparam
//
// Crea: Log Analytics, entorno de Container Apps, la API (Container App, mínimo 1 réplica), el job de
// migraciones (manual, lo dispara el deploy), Azure SQL (oferta gratuita serverless) y la web
// (Static Web Apps). Archivos (R2), mail (Brevo), DNS y Sentry se configuran fuera de Azure.

targetScope = 'resourceGroup'

@allowed(['staging', 'production'])
param environment string

@description('Región de todo salvo la web estática (Static Web Apps solo existe en algunas regiones).')
param location string = 'brazilsouth'
param staticWebAppLocation string = 'eastus2'

@description('Imágenes de la API y del job de migraciones (GHCR), con el tag del commit.')
param apiImage string
param migratorImage string

@description('Registro de las imágenes y un token de solo lectura de paquetes (GitHub: read:packages).')
param registryServer string = 'ghcr.io'
param registryUsername string
@secure()
param registryPassword string

@description('URL pública de la web (https://app.<dominio>) y orígenes permitidos por CORS (separados por coma).')
param appUrl string
param corsOrigins string

@description('Administrador SQL del servidor (solo para crear los usuarios de la base; la app no lo usa).')
param sqlAdminLogin string = 'shaddai_admin'
@secure()
param sqlAdminPassword string
@secure()
param dbAppPassword string
@secure()
param dbMigratorPassword string

@secure()
param jwtAccessSecret string
@secure()
param totpEncKey string
param seedSuperadminEmail string

param smtpHost string = 'smtp-relay.brevo.com'
param smtpPort int = 587
param smtpUser string
@secure()
param smtpPassword string
param mailFrom string
param supportEmail string

param s3Endpoint string
param s3Bucket string
@secure()
param s3AccessKeyId string
@secure()
param s3SecretAccessKey string

@secure()
param turnstileSecret string
param turnstileSiteKey string

@secure()
param sentryDsn string = ''

param geocodingProvider string = 'none'
@secure()
param geocodingApiKey string = ''

@description('Días de restauración a cualquier momento (point-in-time) de la base.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 14

var prefix = 'shaddai-${environment}'
var tags = { app: 'shaddai', environment: environment }
var dbName = 'shaddai'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: '${prefix}-sql'
  location: location
  tags: tags
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

// Container Apps (plan de consumo) no tiene IP de salida fija: se permite el tráfico desde Azure.
resource allowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: dbName
  location: location
  tags: tags
  sku: {
    name: 'GP_S_Gen5_2'
    tier: 'GeneralPurpose'
  }
  properties: {
    // Oferta gratuita: al agotar la cuota del mes sigue andando y cobra el excedente (no se pausa).
    useFreeLimit: true
    freeLimitExhaustionBehavior: 'BillOverUsage'
    autoPauseDelay: 60
    minCapacity: json('0.5')
    maxSizeBytes: 34359738368
    requestedBackupStorageRedundancy: 'Local'
    zoneRedundant: false
  }
}

resource backupPolicy 'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies@2023-08-01-preview' = {
  parent: database
  name: 'default'
  properties: {
    retentionDays: backupRetentionDays
  }
}

var dbHost = sqlServer.properties.fullyQualifiedDomainName

// Configuración común de la API y del job de migraciones (cambia solo el usuario de la base).
var commonEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'LOG_LEVEL', value: 'info' }
  { name: 'APP_URL', value: appUrl }
  { name: 'CORS_ORIGINS', value: corsOrigins }
  { name: 'DB_HOST', value: dbHost }
  { name: 'DB_PORT', value: '1433' }
  { name: 'DB_NAME', value: dbName }
  { name: 'DB_ENCRYPT', value: 'true' }
  { name: 'DB_TRUST_SERVER_CERTIFICATE', value: 'false' }
  { name: 'JWT_ACCESS_SECRET', secretRef: 'jwt-access-secret' }
  { name: 'TOTP_ENC_KEY', secretRef: 'totp-enc-key' }
  { name: 'RATE_LIMIT_STORE', value: 'db' }
  { name: 'SEED_SUPERADMIN_EMAIL', value: seedSuperadminEmail }
  { name: 'STORAGE_DRIVER', value: 's3' }
  { name: 'S3_ENDPOINT', value: s3Endpoint }
  { name: 'S3_REGION', value: 'auto' }
  { name: 'S3_BUCKET', value: s3Bucket }
  { name: 'S3_ACCESS_KEY_ID', secretRef: 's3-access-key-id' }
  { name: 'S3_SECRET_ACCESS_KEY', secretRef: 's3-secret-access-key' }
  { name: 'MAIL_TRANSPORT', value: 'smtp' }
  { name: 'SMTP_HOST', value: smtpHost }
  { name: 'SMTP_PORT', value: string(smtpPort) }
  { name: 'SMTP_USER', value: smtpUser }
  { name: 'SMTP_PASSWORD', secretRef: 'smtp-password' }
  { name: 'MAIL_FROM', value: mailFrom }
  { name: 'SUPPORT_EMAIL', value: supportEmail }
  { name: 'TURNSTILE_SECRET', secretRef: 'turnstile-secret' }
  { name: 'TURNSTILE_SITE_KEY', value: turnstileSiteKey }
  { name: 'SENTRY_DSN', secretRef: 'sentry-dsn' }
  { name: 'SENTRY_ENVIRONMENT', value: environment }
  { name: 'GEOCODING_PROVIDER', value: geocodingProvider }
  { name: 'GEOCODING_API_KEY', secretRef: 'geocoding-api-key' }
]

var commonSecrets = [
  { name: 'registry-password', value: registryPassword }
  { name: 'jwt-access-secret', value: jwtAccessSecret }
  { name: 'totp-enc-key', value: totpEncKey }
  { name: 's3-access-key-id', value: s3AccessKeyId }
  { name: 's3-secret-access-key', value: s3SecretAccessKey }
  { name: 'smtp-password', value: smtpPassword }
  { name: 'turnstile-secret', value: turnstileSecret }
  // Container Apps no acepta secretos vacíos: sin Sentry o geocodificador se guarda un espacio.
  { name: 'sentry-dsn', value: empty(sentryDsn) ? ' ' : sentryDsn }
  { name: 'geocoding-api-key', value: empty(geocodingApiKey) ? ' ' : geocodingApiKey }
]

var registries = [
  { server: registryServer, username: registryUsername, passwordSecretRef: 'registry-password' }
]

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-api'
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: registries
      secrets: concat(commonSecrets, [{ name: 'db-password', value: dbAppPassword }])
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, [
            { name: 'DB_USER', value: 'shaddai_app' }
            { name: 'DB_PASSWORD', secretRef: 'db-password' }
            { name: 'JOBS_ENABLED', value: 'true' }
          ])
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/v1/health', port: 3000 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/v1/health/ready', port: 3000 }
              periodSeconds: 15
              failureThreshold: 3
            }
          ]
        }
      ]
      // Mínimo 1: el aviso diario y la purga de cuentas corren dentro de la API.
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '50' } } }
        ]
      }
    }
  }
}

resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-migrate'
  location: location
  tags: tags
  properties: {
    environmentId: containerEnv.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: registries
      secrets: concat(commonSecrets, [{ name: 'db-password', value: dbMigratorPassword }])
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: migratorImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, [
            { name: 'DB_USER', value: 'shaddai_migrator' }
            { name: 'DB_PASSWORD', secretRef: 'db-password' }
            { name: 'JOBS_ENABLED', value: 'false' }
          ])
        }
      ]
    }
  }
}

resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web'
  location: staticWebAppLocation
  tags: tags
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

output apiFqdn string = api.properties.configuration.ingress.fqdn
output webHostname string = web.properties.defaultHostname
output sqlServerFqdn string = dbHost
output databaseName string = dbName
