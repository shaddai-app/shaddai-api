BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Song] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [title] NVARCHAR(150) NOT NULL,
    [author] NVARCHAR(150),
    [ccliNumber] VARCHAR(15),
    [originalKey] VARCHAR(4),
    [bpm] SMALLINT,
    [timeSignature] VARCHAR(5),
    [chordPro] NVARCHAR(max),
    [tags] NVARCHAR(300),
    [notes] NVARCHAR(1000),
    [searchText] NVARCHAR(450) NOT NULL CONSTRAINT [Song_searchText_df] DEFAULT '',
    [isActive] BIT NOT NULL CONSTRAINT [Song_isActive_df] DEFAULT 1,
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Song_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [Song_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[SongLink] (
    [id] INT NOT NULL IDENTITY(1,1),
    [songId] INT NOT NULL,
    [type] VARCHAR(12) NOT NULL,
    [url] NVARCHAR(500) NOT NULL,
    [label] NVARCHAR(100),
    CONSTRAINT [SongLink_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Song_accountId_title_idx] ON [dbo].[Song]([accountId], [title]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SongLink_songId_idx] ON [dbo].[SongLink]([songId]);

-- AddForeignKey
ALTER TABLE [dbo].[Song] ADD CONSTRAINT [Song_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[SongLink] ADD CONSTRAINT [SongLink_songId_fkey] FOREIGN KEY ([songId]) REFERENCES [dbo].[Song]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- Valores permitidos (a mano; EXEC porque las tablas son de este lote).
EXEC('ALTER TABLE [dbo].[Song] ADD CONSTRAINT [Song_bpm_ck] CHECK ([bpm] IS NULL OR [bpm] BETWEEN 20 AND 300)');
EXEC('ALTER TABLE [dbo].[SongLink] ADD CONSTRAINT [SongLink_type_ck] CHECK ([type] IN (''youtube'',''spotify'',''multitrack'',''sheet'',''other''))');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
