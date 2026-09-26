# Configura una instancia local de SQL Server para Shaddai (desarrollo):
#   1) autenticacion en modo mixto   2) TCP/IP habilitado en puerto fijo   3) reinicio del servicio
# Ejecutar en PowerShell COMO ADMINISTRADOR:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-sqlserver.ps1 [-Instance SQLEXPRESS] [-Port 1433]
param(
  [string]$Instance = 'SQLEXPRESS',
  [int]$Port = 1433
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Ejecuta este script en una PowerShell abierta como Administrador.'
}

$instanceId = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').$Instance
if (-not $instanceId) { throw "No se encontro la instancia '$Instance'." }
$base = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$instanceId\MSSQLServer"
Write-Host "Instancia: $Instance ($instanceId)"

# 1) Modo mixto (LoginMode 2 = SQL Server y Windows)
Set-ItemProperty -Path $base -Name LoginMode -Value 2 -Type DWord
Write-Host '[OK] Autenticacion en modo mixto'

# 2) TCP/IP habilitado, puerto fijo en IPAll, sin puertos dinamicos
Set-ItemProperty -Path "$base\SuperSocketNetLib\Tcp" -Name Enabled -Value 1 -Type DWord
Set-ItemProperty -Path "$base\SuperSocketNetLib\Tcp\IPAll" -Name TcpDynamicPorts -Value ''
Set-ItemProperty -Path "$base\SuperSocketNetLib\Tcp\IPAll" -Name TcpPort -Value "$Port"
Write-Host "[OK] TCP/IP habilitado en el puerto $Port"

# 3) Reinicio
$service = if ($Instance -eq 'MSSQLSERVER') { 'MSSQLSERVER' } else { "MSSQL`$$Instance" }
Restart-Service -Name $service -Force
Write-Host "[OK] Servicio $service reiniciado"

Start-Sleep -Seconds 3
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) { Write-Host "[OK] SQL Server escuchando en el puerto $Port" } else { Write-Warning "No se detecta escucha en $Port todavia; revisa el log de errores de SQL Server." }
Write-Host 'No se abre el firewall: el acceso es solo local (localhost).'
