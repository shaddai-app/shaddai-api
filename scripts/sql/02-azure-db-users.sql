-- Producción (Azure SQL Database): usuarios contenidos de la base, sin logins de servidor. Idempotente.
-- Se ejecuta UNA vez por entorno (staging, producción) conectado a la base de la app como administrador
-- del servidor (ver docs/deploy.md):
--   sqlcmd -S <servidor>.database.windows.net -d <base> -G -i scripts/sql/02-azure-db-users.sql \
--     -v MIGRATOR_PASSWORD="<generada>" APP_PASSWORD="<generada>"
--
-- shaddai_migrator: aplica migraciones y seed (job previo a cada deploy). Dueño de la base.
-- shaddai_app:      la API. Solo lee y escribe datos: no puede crear, cambiar ni borrar tablas.
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'shaddai_migrator')
BEGIN
    CREATE USER [shaddai_migrator] WITH PASSWORD = N'$(MIGRATOR_PASSWORD)';
    PRINT 'Usuario shaddai_migrator creado.';
END
ELSE
    ALTER USER [shaddai_migrator] WITH PASSWORD = N'$(MIGRATOR_PASSWORD)';
ALTER ROLE [db_owner] ADD MEMBER [shaddai_migrator];

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'shaddai_app')
BEGIN
    CREATE USER [shaddai_app] WITH PASSWORD = N'$(APP_PASSWORD)';
    PRINT 'Usuario shaddai_app creado.';
END
ELSE
    ALTER USER [shaddai_app] WITH PASSWORD = N'$(APP_PASSWORD)';
ALTER ROLE [db_datareader] ADD MEMBER [shaddai_app];
ALTER ROLE [db_datawriter] ADD MEMBER [shaddai_app];
-- Por si quedó de una versión anterior con más permisos.
IF IS_ROLEMEMBER('db_owner', 'shaddai_app') = 1 ALTER ROLE [db_owner] DROP MEMBER [shaddai_app];
IF IS_ROLEMEMBER('db_ddladmin', 'shaddai_app') = 1 ALTER ROLE [db_ddladmin] DROP MEMBER [shaddai_app];

SELECT dp.name AS usuario, r.name AS rol
FROM sys.database_role_members m
JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
JOIN sys.database_principals dp ON dp.principal_id = m.member_principal_id
WHERE dp.name IN (N'shaddai_migrator', N'shaddai_app')
ORDER BY dp.name, r.name;
