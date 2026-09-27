BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[User] ADD [personId] INT;

-- CreateTable
CREATE TABLE [dbo].[Household] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [name] NVARCHAR(120) NOT NULL,
    [address] NVARCHAR(250),
    [city] NVARCHAR(100),
    [province] NVARCHAR(100),
    [postalCode] VARCHAR(10),
    [lat] DECIMAL(9,6),
    [lng] DECIMAL(9,6),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Household_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Household_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Person] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [campusId] INT,
    [householdId] INT,
    [householdRole] VARCHAR(10),
    [firstName] NVARCHAR(80) NOT NULL,
    [lastName] NVARCHAR(80) NOT NULL,
    [preferredName] NVARCHAR(80),
    [gender] VARCHAR(1),
    [birthDate] DATE,
    [documentNumber] VARCHAR(20),
    [maritalStatus] VARCHAR(15),
    [email] NVARCHAR(150),
    [phone] VARCHAR(30),
    [address] NVARCHAR(250),
    [city] NVARCHAR(100),
    [province] NVARCHAR(100),
    [lat] DECIMAL(9,6),
    [lng] DECIMAL(9,6),
    [photoFileId] INT,
    [statusId] INT NOT NULL,
    [source] VARCHAR(10) NOT NULL CONSTRAINT [Person_source_df] DEFAULT 'manual',
    [firstVisitAt] DATE,
    [consentAt] DATETIME2,
    [consentVersion] VARCHAR(10),
    [pastoralNotes] NVARCHAR(max),
    [notes] NVARCHAR(max),
    [mergedIntoId] INT,
    [createdById] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Person_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [Person_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PersonStatusHistory] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [personId] INT NOT NULL,
    [fromStatusId] INT,
    [toStatusId] INT NOT NULL,
    [changedById] INT,
    [note] NVARCHAR(300),
    [changedAt] DATETIME2 NOT NULL CONSTRAINT [PersonStatusHistory_changedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PersonStatusHistory_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PersonMilestone] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [personId] INT NOT NULL,
    [milestoneTypeId] INT NOT NULL,
    [date] DATE NOT NULL,
    [notes] NVARCHAR(500),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PersonMilestone_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PersonMilestone_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PersonPosition] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [personId] INT NOT NULL,
    [positionId] INT NOT NULL,
    [since] DATE,
    [until] DATE,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PersonPosition_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PersonPosition_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PersonTag] (
    [personId] INT NOT NULL,
    [tagId] INT NOT NULL,
    CONSTRAINT [PersonTag_pkey] PRIMARY KEY CLUSTERED ([personId],[tagId])
);

-- CreateTable
CREATE TABLE [dbo].[Tag] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [name] NVARCHAR(60) NOT NULL,
    [color] VARCHAR(20),
    CONSTRAINT [Tag_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Tag_accountId_name_key] UNIQUE NONCLUSTERED ([accountId],[name])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Household_accountId_name_idx] ON [dbo].[Household]([accountId], [name]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Person_accountId_deletedAt_lastName_firstName_idx] ON [dbo].[Person]([accountId], [deletedAt], [lastName], [firstName]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Person_accountId_statusId_idx] ON [dbo].[Person]([accountId], [statusId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Person_accountId_phone_idx] ON [dbo].[Person]([accountId], [phone]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Person_accountId_email_idx] ON [dbo].[Person]([accountId], [email]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Person_accountId_householdId_idx] ON [dbo].[Person]([accountId], [householdId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Person_accountId_createdById_idx] ON [dbo].[Person]([accountId], [createdById]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PersonStatusHistory_accountId_personId_idx] ON [dbo].[PersonStatusHistory]([accountId], [personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PersonMilestone_accountId_personId_idx] ON [dbo].[PersonMilestone]([accountId], [personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PersonMilestone_accountId_milestoneTypeId_date_idx] ON [dbo].[PersonMilestone]([accountId], [milestoneTypeId], [date]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PersonPosition_accountId_personId_idx] ON [dbo].[PersonPosition]([accountId], [personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PersonPosition_accountId_positionId_idx] ON [dbo].[PersonPosition]([accountId], [positionId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PersonTag_tagId_idx] ON [dbo].[PersonTag]([tagId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [User_personId_idx] ON [dbo].[User]([personId]);

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Household] ADD CONSTRAINT [Household_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Person] ADD CONSTRAINT [Person_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Person] ADD CONSTRAINT [Person_campusId_fkey] FOREIGN KEY ([campusId]) REFERENCES [dbo].[Campus]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Person] ADD CONSTRAINT [Person_householdId_fkey] FOREIGN KEY ([householdId]) REFERENCES [dbo].[Household]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Person] ADD CONSTRAINT [Person_statusId_fkey] FOREIGN KEY ([statusId]) REFERENCES [dbo].[CatalogItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PersonStatusHistory] ADD CONSTRAINT [PersonStatusHistory_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PersonStatusHistory] ADD CONSTRAINT [PersonStatusHistory_fromStatusId_fkey] FOREIGN KEY ([fromStatusId]) REFERENCES [dbo].[CatalogItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PersonStatusHistory] ADD CONSTRAINT [PersonStatusHistory_toStatusId_fkey] FOREIGN KEY ([toStatusId]) REFERENCES [dbo].[CatalogItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PersonMilestone] ADD CONSTRAINT [PersonMilestone_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PersonMilestone] ADD CONSTRAINT [PersonMilestone_milestoneTypeId_fkey] FOREIGN KEY ([milestoneTypeId]) REFERENCES [dbo].[CatalogItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PersonPosition] ADD CONSTRAINT [PersonPosition_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PersonPosition] ADD CONSTRAINT [PersonPosition_positionId_fkey] FOREIGN KEY ([positionId]) REFERENCES [dbo].[CatalogItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PersonTag] ADD CONSTRAINT [PersonTag_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[PersonTag] ADD CONSTRAINT [PersonTag_tagId_fkey] FOREIGN KEY ([tagId]) REFERENCES [dbo].[Tag]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Tag] ADD CONSTRAINT [Tag_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
