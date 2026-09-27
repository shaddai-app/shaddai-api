BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Network] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [campusId] INT,
    [name] NVARCHAR(100) NOT NULL,
    [color] VARCHAR(20),
    [leaderPersonId] INT,
    [isActive] BIT NOT NULL CONSTRAINT [Network_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Network_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Network_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Zone] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [networkId] INT NOT NULL,
    [name] NVARCHAR(100) NOT NULL,
    [supervisorPersonId] INT,
    [isActive] BIT NOT NULL CONSTRAINT [Zone_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Zone_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Zone_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Cell] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [campusId] INT,
    [zoneId] INT NOT NULL,
    [parentCellId] INT,
    [code] VARCHAR(20),
    [name] NVARCHAR(100) NOT NULL,
    [meetingDay] TINYINT NOT NULL,
    [meetingTime] CHAR(5) NOT NULL,
    [address] NVARCHAR(250) NOT NULL,
    [city] NVARCHAR(100),
    [neighborhood] NVARCHAR(100),
    [lat] DECIMAL(9,6),
    [lng] DECIMAL(9,6),
    [leaderPersonId] INT NOT NULL,
    [coLeaderPersonId] INT,
    [hostPersonId] INT,
    [status] VARCHAR(10) NOT NULL CONSTRAINT [Cell_status_df] DEFAULT 'active',
    [startedAt] DATE,
    [closedAt] DATE,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Cell_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Cell_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CellMember] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [cellId] INT NOT NULL,
    [personId] INT NOT NULL,
    [joinedAt] DATE NOT NULL,
    [leftAt] DATE,
    CONSTRAINT [CellMember_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Network_accountId_idx] ON [dbo].[Network]([accountId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Network_accountId_leaderPersonId_idx] ON [dbo].[Network]([accountId], [leaderPersonId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Zone_accountId_networkId_idx] ON [dbo].[Zone]([accountId], [networkId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Zone_accountId_supervisorPersonId_idx] ON [dbo].[Zone]([accountId], [supervisorPersonId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Cell_accountId_zoneId_status_idx] ON [dbo].[Cell]([accountId], [zoneId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Cell_accountId_leaderPersonId_idx] ON [dbo].[Cell]([accountId], [leaderPersonId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Cell_accountId_coLeaderPersonId_idx] ON [dbo].[Cell]([accountId], [coLeaderPersonId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Cell_accountId_hostPersonId_idx] ON [dbo].[Cell]([accountId], [hostPersonId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Cell_accountId_parentCellId_idx] ON [dbo].[Cell]([accountId], [parentCellId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CellMember_accountId_cellId_leftAt_idx] ON [dbo].[CellMember]([accountId], [cellId], [leftAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CellMember_accountId_personId_leftAt_idx] ON [dbo].[CellMember]([accountId], [personId], [leftAt]);

-- AddForeignKey
ALTER TABLE [dbo].[Network] ADD CONSTRAINT [Network_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Network] ADD CONSTRAINT [Network_campusId_fkey] FOREIGN KEY ([campusId]) REFERENCES [dbo].[Campus]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Network] ADD CONSTRAINT [Network_leaderPersonId_fkey] FOREIGN KEY ([leaderPersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Zone] ADD CONSTRAINT [Zone_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Zone] ADD CONSTRAINT [Zone_networkId_fkey] FOREIGN KEY ([networkId]) REFERENCES [dbo].[Network]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Zone] ADD CONSTRAINT [Zone_supervisorPersonId_fkey] FOREIGN KEY ([supervisorPersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Cell] ADD CONSTRAINT [Cell_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Cell] ADD CONSTRAINT [Cell_campusId_fkey] FOREIGN KEY ([campusId]) REFERENCES [dbo].[Campus]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Cell] ADD CONSTRAINT [Cell_zoneId_fkey] FOREIGN KEY ([zoneId]) REFERENCES [dbo].[Zone]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Cell] ADD CONSTRAINT [Cell_parentCellId_fkey] FOREIGN KEY ([parentCellId]) REFERENCES [dbo].[Cell]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Cell] ADD CONSTRAINT [Cell_leaderPersonId_fkey] FOREIGN KEY ([leaderPersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Cell] ADD CONSTRAINT [Cell_coLeaderPersonId_fkey] FOREIGN KEY ([coLeaderPersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Cell] ADD CONSTRAINT [Cell_hostPersonId_fkey] FOREIGN KEY ([hostPersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CellMember] ADD CONSTRAINT [CellMember_cellId_fkey] FOREIGN KEY ([cellId]) REFERENCES [dbo].[Cell]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CellMember] ADD CONSTRAINT [CellMember_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
