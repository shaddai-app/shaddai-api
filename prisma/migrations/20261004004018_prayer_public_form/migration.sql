BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[PrayerRequest] ALTER COLUMN [createdById] INT NULL;
ALTER TABLE [dbo].[PrayerRequest] ADD [accessTokenEnc] VARCHAR(200),
[accessTokenHash] CHAR(64),
[consentVersion] VARCHAR(10),
[contactedAt] DATETIME2,
[contactedById] INT,
[requesterEmail] NVARCHAR(150),
[requesterLocale] VARCHAR(5),
[requesterName] NVARCHAR(150),
[requesterPhone] VARCHAR(30),
[source] VARCHAR(10) NOT NULL CONSTRAINT [PrayerRequest_source_df] DEFAULT 'app',
[wallShare] VARCHAR(10),
[wantsContact] BIT NOT NULL CONSTRAINT [PrayerRequest_wantsContact_df] DEFAULT 0;

-- CreateTable
CREATE TABLE [dbo].[PrayerReply] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [requestId] INT NOT NULL,
    [body] NVARCHAR(1000) NOT NULL,
    [authorId] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PrayerReply_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PrayerReply_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PrayerReply_accountId_requestId_createdAt_idx] ON [dbo].[PrayerReply]([accountId], [requestId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PrayerReply_authorId_idx] ON [dbo].[PrayerReply]([authorId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PrayerRequest_accountId_source_createdAt_idx] ON [dbo].[PrayerRequest]([accountId], [source], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PrayerRequest_accessTokenHash_idx] ON [dbo].[PrayerRequest]([accessTokenHash]);

-- AddForeignKey
ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_contactedById_fkey] FOREIGN KEY ([contactedById]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PrayerReply] ADD CONSTRAINT [PrayerReply_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PrayerReply] ADD CONSTRAINT [PrayerReply_requestId_fkey] FOREIGN KEY ([requestId]) REFERENCES [dbo].[PrayerRequest]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PrayerReply] ADD CONSTRAINT [PrayerReply_authorId_fkey] FOREIGN KEY ([authorId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
