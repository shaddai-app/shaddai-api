BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Ministry] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [campusId] INT,
    [name] NVARCHAR(100) NOT NULL,
    [description] NVARCHAR(500),
    [color] VARCHAR(20),
    [kind] VARCHAR(10) NOT NULL CONSTRAINT [Ministry_kind_df] DEFAULT 'general',
    [isActive] BIT NOT NULL CONSTRAINT [Ministry_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Ministry_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [Ministry_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[MinistryMember] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [ministryId] INT NOT NULL,
    [personId] INT NOT NULL,
    [role] VARCHAR(10) NOT NULL CONSTRAINT [MinistryMember_role_df] DEFAULT 'servant',
    [joinedAt] DATE NOT NULL,
    [leftAt] DATE,
    CONSTRAINT [MinistryMember_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ServiceRole] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [ministryId] INT NOT NULL,
    [name] NVARCHAR(80) NOT NULL,
    [sortOrder] INT NOT NULL CONSTRAINT [ServiceRole_sortOrder_df] DEFAULT 0,
    [isActive] BIT NOT NULL CONSTRAINT [ServiceRole_isActive_df] DEFAULT 1,
    CONSTRAINT [ServiceRole_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Ministry_accountId_isActive_idx] ON [dbo].[Ministry]([accountId], [isActive]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [MinistryMember_accountId_ministryId_leftAt_idx] ON [dbo].[MinistryMember]([accountId], [ministryId], [leftAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [MinistryMember_accountId_personId_idx] ON [dbo].[MinistryMember]([accountId], [personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ServiceRole_accountId_ministryId_idx] ON [dbo].[ServiceRole]([accountId], [ministryId]);

-- AddForeignKey
ALTER TABLE [dbo].[Ministry] ADD CONSTRAINT [Ministry_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Ministry] ADD CONSTRAINT [Ministry_campusId_fkey] FOREIGN KEY ([campusId]) REFERENCES [dbo].[Campus]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[MinistryMember] ADD CONSTRAINT [MinistryMember_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[MinistryMember] ADD CONSTRAINT [MinistryMember_ministryId_fkey] FOREIGN KEY ([ministryId]) REFERENCES [dbo].[Ministry]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[MinistryMember] ADD CONSTRAINT [MinistryMember_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ServiceRole] ADD CONSTRAINT [ServiceRole_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ServiceRole] ADD CONSTRAINT [ServiceRole_ministryId_fkey] FOREIGN KEY ([ministryId]) REFERENCES [dbo].[Ministry]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Valores permitidos (a mano; EXEC porque las tablas son de este lote).
EXEC('ALTER TABLE [dbo].[Ministry] ADD CONSTRAINT [Ministry_kind_ck] CHECK ([kind] IN (''general'',''worship'',''tech'',''kids'',''ushers''))');
EXEC('ALTER TABLE [dbo].[MinistryMember] ADD CONSTRAINT [MinistryMember_role_ck] CHECK ([role] IN (''leader'',''coleader'',''servant''))');
EXEC('ALTER TABLE [dbo].[MinistryMember] ADD CONSTRAINT [MinistryMember_dates_ck] CHECK ([leftAt] IS NULL OR [leftAt] >= [joinedAt])');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
