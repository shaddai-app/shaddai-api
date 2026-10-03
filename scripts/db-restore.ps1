# Restaura un backup (.bak) en una base NUEVA y compara, tabla por tabla, la cantidad de filas con la
# base de origen. Sirve para probar que los backups locales sirven; nunca pisa una base existente.
#   npm run db:restore -- -File <ruta.bak> [-Target Shaddai_restore_check] [-Drop]
# -Drop borra la base restaurada al terminar la comparación.
param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$Target,
  [switch]$Drop
)
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
$vars = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $vars[$Matches[1]] = $Matches[2].Trim('"') }
$source = if ($vars.DB_NAME) { $vars.DB_NAME } else { 'Shaddai' }
$server = if ($vars.SQL_ADMIN_SERVER) { $vars.SQL_ADMIN_SERVER } else { 'localhost,1433' }
if (-not $Target) { $Target = "${source}_restore_check" }
if ($Target -eq $source) { throw 'La restauración va siempre a una base nueva, no sobre la de origen.' }

function Sql([string]$query, [string]$db = 'master') {
  $out = sqlcmd -S $server -E -C -b -d $db -h -1 -W -s '|' -Q "SET NOCOUNT ON; $query"
  if ($LASTEXITCODE -ne 0) { throw "Falló: $query`n$out" }
  return $out | Where-Object { $_ -ne '' }
}
# Primer valor de una consulta de un solo dato.
function Scalar([string]$query) { return (@(Sql $query))[0].Trim() }

if ((Scalar "SELECT DB_ID(N'$Target')") -ne 'NULL') { throw "La base $Target ya existe: borrala o elegí otro -Target." }

# Archivos lógicos del backup, movidos a la carpeta de datos de la instancia con el nombre nuevo.
$dataDir = Scalar "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400))"
$logDir = Scalar "SELECT CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(400))"
$files = sqlcmd -S $server -E -C -b -h -1 -W -s '|' -Q "RESTORE FILELISTONLY FROM DISK = N'$File'"
if ($LASTEXITCODE -ne 0) { throw "No se pudo leer el backup $File" }
$moves = foreach ($line in $files | Where-Object { $_ -match '\|' }) {
  $cols = $line.Split('|')
  $ext = if ($cols[2] -eq 'L') { '_log.ldf' } else { '.mdf' }
  $dir = if ($cols[2] -eq 'L') { $logDir } else { $dataDir }
  "MOVE N'$($cols[0])' TO N'$(Join-Path $dir "$Target$ext")'"
}
Sql "RESTORE DATABASE [$Target] FROM DISK = N'$File' WITH $($moves -join ', '), CHECKSUM, RECOVERY" | Out-Null
Write-Host "Restaurado en $Target. Comparando filas con $source..."

$countQuery = "SELECT t.name, SUM(p.rows) FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) GROUP BY t.name ORDER BY t.name"
$a = Sql $countQuery $source
$b = Sql $countQuery $Target
$diff = Compare-Object $a $b
if ($diff) {
  Write-Host 'Diferencias (normal si la base de origen cambió después del backup):'
  $diff | ForEach-Object { Write-Host "  $($_.SideIndicator) $($_.InputObject)" }
} else {
  Write-Host "OK: las $(@($a).Count) tablas tienen la misma cantidad de filas."
}
if ($Drop) {
  Sql "DROP DATABASE [$Target]" | Out-Null
  Write-Host "Base $Target borrada."
}
