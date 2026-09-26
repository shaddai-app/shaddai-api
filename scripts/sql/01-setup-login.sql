-- Crea (o actualiza) el login SQL de la aplicación. Idempotente.
-- Se ejecuta con tu usuario de Windows (sqlcmd -E) vía `npm run db:sql-login`.
-- Variables sqlcmd: APP_LOGIN, APP_PASSWORD
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'$(APP_LOGIN)')
BEGIN
    CREATE LOGIN [$(APP_LOGIN)] WITH PASSWORD = N'$(APP_PASSWORD)', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = [master];
    PRINT 'Login $(APP_LOGIN) creado.';
END
ELSE
BEGIN
    ALTER LOGIN [$(APP_LOGIN)] WITH PASSWORD = N'$(APP_PASSWORD)';
    ALTER LOGIN [$(APP_LOGIN)] ENABLE;
    PRINT 'Login $(APP_LOGIN) ya existía: contraseña actualizada.';
END

-- SOLO DESARROLLO: permite a Prisma crear la base Shaddai y la base shadow temporal de `migrate dev`.
-- Al crearlas queda como dbo de ambas. En producción se usan logins migrator/app sin este rol.
IF IS_SRVROLEMEMBER('dbcreator', N'$(APP_LOGIN)') = 0
BEGIN
    ALTER SERVER ROLE [dbcreator] ADD MEMBER [$(APP_LOGIN)];
    PRINT 'Rol dbcreator asignado.';
END

SELECT
    CAST(SERVERPROPERTY('IsIntegratedSecurityOnly') AS int) AS SoloWindowsAuth, -- debe ser 0 (modo mixto)
    CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(30)) AS Version;
