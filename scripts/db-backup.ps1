# Backup completo de la base a .\backups\Shaddai_yyyyMMdd_HHmmss.bak (en la PC del servidor SQL).
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
$vars = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $vars[$Matches[1]] = $Matches[2].Trim('"') }

$db = if ($vars.DB_NAME) { $vars.DB_NAME } else { 'Shaddai' }
$server = if ($vars.SQL_ADMIN_SERVER) { $vars.SQL_ADMIN_SERVER } else { 'localhost,1433' }
$dir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir ("{0}_{1}.bak" -f $db, (Get-Date -Format 'yyyyMMdd_HHmmss'))

# La cuenta de servicio de SQL Server necesita permiso de escritura en la carpeta de destino.
sqlcmd -S $server -E -C -b -Q "BACKUP DATABASE [$db] TO DISK = N'$file' WITH INIT, COMPRESSION, CHECKSUM"
Write-Host "Backup generado: $file"
