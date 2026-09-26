BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[User] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT,
    [email] NVARCHAR(150) NOT NULL,
    [passwordHash] VARCHAR(200) NOT NULL,
    [firstName] NVARCHAR(80) NOT NULL,
    [lastName] NVARCHAR(80) NOT NULL,
    [isPlatformAdmin] BIT NOT NULL CONSTRAINT [User_isPlatformAdmin_df] DEFAULT 0,
    [isAccountOwner] BIT NOT NULL CONSTRAINT [User_isAccountOwner_df] DEFAULT 0,
    [isActive] BIT NOT NULL CONSTRAINT [User_isActive_df] DEFAULT 1,
    [mustChangePassword] BIT NOT NULL CONSTRAINT [User_mustChangePassword_df] DEFAULT 1,
    [passwordChangedAt] DATETIME2,
    [failedLoginCount] INT NOT NULL CONSTRAINT [User_failedLoginCount_df] DEFAULT 0,
    [lockoutLevel] INT NOT NULL CONSTRAINT [User_lockoutLevel_df] DEFAULT 0,
    [lockedUntil] DATETIME2,
    [lastLoginAt] DATETIME2,
    [locale] VARCHAR(5),
    [theme] VARCHAR(5) NOT NULL CONSTRAINT [User_theme_df] DEFAULT 'auto',
    [totpSecretEnc] VARCHAR(200),
    [totpEnabled] BIT NOT NULL CONSTRAINT [User_totpEnabled_df] DEFAULT 0,
    [notificationPrefs] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [User_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [User_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [User_email_key] UNIQUE NONCLUSTERED ([email])
);

-- CreateTable
CREATE TABLE [dbo].[Permission] (
    [id] INT NOT NULL IDENTITY(1,1),
    [key] VARCHAR(60) NOT NULL,
    [module] VARCHAR(30) NOT NULL,
    [action] VARCHAR(30) NOT NULL,
    [supportsScope] BIT NOT NULL CONSTRAINT [Permission_supportsScope_df] DEFAULT 0,
    [sortOrder] INT NOT NULL,
    CONSTRAINT [Permission_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Permission_key_key] UNIQUE NONCLUSTERED ([key])
);

-- CreateTable
CREATE TABLE [dbo].[Role] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [name] NVARCHAR(80) NOT NULL,
    [description] NVARCHAR(250),
    [systemKey] VARCHAR(40),
    [isLocked] BIT NOT NULL CONSTRAINT [Role_isLocked_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Role_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Role_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Role_accountId_name_key] UNIQUE NONCLUSTERED ([accountId],[name])
);

-- CreateTable
CREATE TABLE [dbo].[RolePermission] (
    [roleId] INT NOT NULL,
    [permissionId] INT NOT NULL,
    [scope] VARCHAR(3) NOT NULL CONSTRAINT [RolePermission_scope_df] DEFAULT 'all',
    CONSTRAINT [RolePermission_pkey] PRIMARY KEY CLUSTERED ([roleId],[permissionId])
);

-- CreateTable
CREATE TABLE [dbo].[UserRole] (
    [userId] INT NOT NULL,
    [roleId] INT NOT NULL,
    CONSTRAINT [UserRole_pkey] PRIMARY KEY CLUSTERED ([userId],[roleId])
);

-- CreateTable
CREATE TABLE [dbo].[RefreshToken] (
    [id] INT NOT NULL IDENTITY(1,1),
    [userId] INT NOT NULL,
    [familyId] CHAR(36) NOT NULL,
    [tokenHash] CHAR(64) NOT NULL,
    [rememberMe] BIT NOT NULL CONSTRAINT [RefreshToken_rememberMe_df] DEFAULT 0,
    [impersonatorId] INT,
    [expiresAt] DATETIME2 NOT NULL,
    [revokedAt] DATETIME2,
    [revokedReason] VARCHAR(30),
    [replacedById] INT,
    [ip] VARCHAR(45),
    [userAgent] NVARCHAR(300),
    [lastUsedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [RefreshToken_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [RefreshToken_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [RefreshToken_tokenHash_key] UNIQUE NONCLUSTERED ([tokenHash])
);

-- CreateTable
CREATE TABLE [dbo].[PasswordResetToken] (
    [id] INT NOT NULL IDENTITY(1,1),
    [userId] INT NOT NULL,
    [tokenHash] CHAR(64) NOT NULL,
    [expiresAt] DATETIME2 NOT NULL,
    [usedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PasswordResetToken_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PasswordResetToken_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [PasswordResetToken_tokenHash_key] UNIQUE NONCLUSTERED ([tokenHash])
);

-- CreateTable
CREATE TABLE [dbo].[Plan] (
    [id] INT NOT NULL IDENTITY(1,1),
    [code] VARCHAR(30) NOT NULL,
    [name] NVARCHAR(80) NOT NULL,
    [userLimit] INT NOT NULL,
    [storageLimitMb] INT NOT NULL,
    [priceUsd] DECIMAL(10,2) NOT NULL,
    [isActive] BIT NOT NULL CONSTRAINT [Plan_isActive_df] DEFAULT 1,
    CONSTRAINT [Plan_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Plan_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[Account] (
    [id] INT NOT NULL IDENTITY(1,1),
    [name] NVARCHAR(150) NOT NULL,
    [slug] VARCHAR(60) NOT NULL,
    [status] VARCHAR(15) NOT NULL CONSTRAINT [Account_status_df] DEFAULT 'trial',
    [planId] INT NOT NULL,
    [userLimit] INT NOT NULL,
    [storageLimitMb] INT NOT NULL,
    [storageUsedBytes] BIGINT NOT NULL CONSTRAINT [Account_storageUsedBytes_df] DEFAULT 0,
    [trialEndsAt] DATETIME2,
    [defaultLocale] VARCHAR(5) NOT NULL CONSTRAINT [Account_defaultLocale_df] DEFAULT 'es',
    [timezone] VARCHAR(50) NOT NULL CONSTRAINT [Account_timezone_df] DEFAULT 'America/Argentina/Buenos_Aires',
    [currency] CHAR(3) NOT NULL CONSTRAINT [Account_currency_df] DEFAULT 'ARS',
    [weekStartsOn] TINYINT NOT NULL CONSTRAINT [Account_weekStartsOn_df] DEFAULT 1,
    [primaryColor] VARCHAR(20) NOT NULL CONSTRAINT [Account_primaryColor_df] DEFAULT 'slate',
    [logoFileId] INT,
    [legalName] NVARCHAR(150),
    [taxId] VARCHAR(13),
    [taxCondition] VARCHAR(30),
    [ccliLicense] VARCHAR(20),
    [email] NVARCHAR(150),
    [phone] VARCHAR(30),
    [address] NVARCHAR(250),
    [cellMultiplyTarget] INT NOT NULL CONSTRAINT [Account_cellMultiplyTarget_df] DEFAULT 12,
    [cellReportEditDays] INT NOT NULL CONSTRAINT [Account_cellReportEditDays_df] DEFAULT 7,
    [structureLabels] NVARCHAR(max),
    [notes] NVARCHAR(max),
    [closedAt] DATETIME2,
    [purgeAfter] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Account_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Account_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Account_slug_key] UNIQUE NONCLUSTERED ([slug])
);

-- CreateTable
CREATE TABLE [dbo].[Campus] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [name] NVARCHAR(100) NOT NULL,
    [isMain] BIT NOT NULL CONSTRAINT [Campus_isMain_df] DEFAULT 0,
    [address] NVARCHAR(250),
    [lat] DECIMAL(9,6),
    [lng] DECIMAL(9,6),
    [isActive] BIT NOT NULL CONSTRAINT [Campus_isActive_df] DEFAULT 1,
    CONSTRAINT [Campus_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CatalogItem] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [type] VARCHAR(30) NOT NULL,
    [systemKey] VARCHAR(40),
    [name] NVARCHAR(100),
    [color] VARCHAR(20),
    [sortOrder] INT NOT NULL CONSTRAINT [CatalogItem_sortOrder_df] DEFAULT 0,
    [isActive] BIT NOT NULL CONSTRAINT [CatalogItem_isActive_df] DEFAULT 1,
    CONSTRAINT [CatalogItem_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AuditLog] (
    [id] BIGINT NOT NULL IDENTITY(1,1),
    [accountId] INT,
    [userId] INT,
    [impersonatorId] INT,
    [action] VARCHAR(60) NOT NULL,
    [entity] VARCHAR(40),
    [entityId] VARCHAR(40),
    [before] NVARCHAR(max),
    [after] NVARCHAR(max),
    [ip] VARCHAR(45),
    [userAgent] NVARCHAR(300),
    [requestId] VARCHAR(36),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AuditLog_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AuditLog_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [User_accountId_isActive_idx] ON [dbo].[User]([accountId], [isActive]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Role_accountId_idx] ON [dbo].[Role]([accountId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [UserRole_roleId_idx] ON [dbo].[UserRole]([roleId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [RefreshToken_userId_revokedAt_idx] ON [dbo].[RefreshToken]([userId], [revokedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [RefreshToken_familyId_idx] ON [dbo].[RefreshToken]([familyId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PasswordResetToken_userId_idx] ON [dbo].[PasswordResetToken]([userId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Account_status_idx] ON [dbo].[Account]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Campus_accountId_idx] ON [dbo].[Campus]([accountId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CatalogItem_accountId_type_idx] ON [dbo].[CatalogItem]([accountId], [type]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CatalogItem_accountId_type_systemKey_idx] ON [dbo].[CatalogItem]([accountId], [type], [systemKey]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_accountId_createdAt_idx] ON [dbo].[AuditLog]([accountId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_accountId_entity_entityId_idx] ON [dbo].[AuditLog]([accountId], [entity], [entityId]);

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Role] ADD CONSTRAINT [Role_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[RolePermission] ADD CONSTRAINT [RolePermission_roleId_fkey] FOREIGN KEY ([roleId]) REFERENCES [dbo].[Role]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[RolePermission] ADD CONSTRAINT [RolePermission_permissionId_fkey] FOREIGN KEY ([permissionId]) REFERENCES [dbo].[Permission]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[UserRole] ADD CONSTRAINT [UserRole_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[UserRole] ADD CONSTRAINT [UserRole_roleId_fkey] FOREIGN KEY ([roleId]) REFERENCES [dbo].[Role]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[RefreshToken] ADD CONSTRAINT [RefreshToken_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[PasswordResetToken] ADD CONSTRAINT [PasswordResetToken_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Account] ADD CONSTRAINT [Account_planId_fkey] FOREIGN KEY ([planId]) REFERENCES [dbo].[Plan]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Campus] ADD CONSTRAINT [Campus_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CatalogItem] ADD CONSTRAINT [CatalogItem_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
