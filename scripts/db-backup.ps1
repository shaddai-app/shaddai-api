# Backup completo de la base local (desarrollo o un servidor propio). En Azure SQL los backups son
# automáticos: ver docs/deploy.md.
# Por defecto va a la carpeta de backups de la instancia (SQL Server tiene permiso de escritura ahí);
# otra carpeta: -Dir <ruta>, a la que la cuenta de servicio de SQL Server tenga acceso.
param([string]$Dir)
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
$vars = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $vars[$Matches[1]] = $Matches[2].Trim('"') }

$db = if ($vars.DB_NAME) { $vars.DB_NAME } else { 'Shaddai' }
$server = if ($vars.SQL_ADMIN_SERVER) { $vars.SQL_ADMIN_SERVER } else { 'localhost,1433' }
if (-not $Dir) {
  $Dir = (sqlcmd -S $server -E -C -b -h -1 -W -Q "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(400))" | Select-Object -First 1).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $Dir) { throw 'No se pudo leer la carpeta de backups de la instancia.' }
}
$file = Join-Path $Dir ("{0}_{1}.bak" -f $db, (Get-Date -Format 'yyyyMMdd_HHmmss'))

sqlcmd -S $server -E -C -b -Q "BACKUP DATABASE [$db] TO DISK = N'$file' WITH INIT, COMPRESSION, CHECKSUM"
if ($LASTEXITCODE -ne 0) { throw "El backup falló (sqlcmd salió con $LASTEXITCODE)." }
sqlcmd -S $server -E -C -b -Q "RESTORE VERIFYONLY FROM DISK = N'$file' WITH CHECKSUM"
if ($LASTEXITCODE -ne 0) { throw 'El backup se generó pero no pasó la verificación.' }
Write-Host "Backup generado y verificado: $file"
