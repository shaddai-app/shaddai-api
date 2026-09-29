BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Setlist] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [eventId] INT,
    [occurrenceStart] DATETIME2 NOT NULL,
    [title] NVARCHAR(150),
    [notes] NVARCHAR(1000),
    [status] VARCHAR(10) NOT NULL CONSTRAINT [Setlist_status_df] DEFAULT 'draft',
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Setlist_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Setlist_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[SetlistItem] (
    [id] INT NOT NULL IDENTITY(1,1),
    [setlistId] INT NOT NULL,
    [songId] INT NOT NULL,
    [position] INT NOT NULL,
    [key] VARCHAR(4),
    [notes] NVARCHAR(300),
    CONSTRAINT [SetlistItem_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Setlist_accountId_occurrenceStart_idx] ON [dbo].[Setlist]([accountId], [occurrenceStart]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Setlist_eventId_occurrenceStart_idx] ON [dbo].[Setlist]([eventId], [occurrenceStart]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SetlistItem_setlistId_position_idx] ON [dbo].[SetlistItem]([setlistId], [position]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SetlistItem_songId_idx] ON [dbo].[SetlistItem]([songId]);

-- AddForeignKey
ALTER TABLE [dbo].[Setlist] ADD CONSTRAINT [Setlist_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Setlist] ADD CONSTRAINT [Setlist_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[SetlistItem] ADD CONSTRAINT [SetlistItem_setlistId_fkey] FOREIGN KEY ([setlistId]) REFERENCES [dbo].[Setlist]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[SetlistItem] ADD CONSTRAINT [SetlistItem_songId_fkey] FOREIGN KEY ([songId]) REFERENCES [dbo].[Song]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Valores permitidos (a mano; EXEC porque las tablas son de este lote).
EXEC('ALTER TABLE [dbo].[Setlist] ADD CONSTRAINT [Setlist_status_ck] CHECK ([status] IN (''draft'',''published''))');
EXEC('ALTER TABLE [dbo].[SetlistItem] ADD CONSTRAINT [SetlistItem_position_ck] CHECK ([position] >= 1)');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
