BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[PrayerRequest] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [body] NVARCHAR(1000) NOT NULL,
    [visibility] VARCHAR(10) NOT NULL,
    [anonymous] BIT NOT NULL CONSTRAINT [PrayerRequest_anonymous_df] DEFAULT 0,
    [status] VARCHAR(10) NOT NULL CONSTRAINT [PrayerRequest_status_df] DEFAULT 'open',
    [answeredAt] DATETIME2,
    [testimony] NVARCHAR(1000),
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PrayerRequest_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [PrayerRequest_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PrayerRequestPrayer] (
    [requestId] INT NOT NULL,
    [userId] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PrayerRequestPrayer_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PrayerRequestPrayer_pkey] PRIMARY KEY CLUSTERED ([requestId],[userId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PrayerRequest_accountId_status_createdAt_idx] ON [dbo].[PrayerRequest]([accountId], [status], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PrayerRequest_accountId_createdById_idx] ON [dbo].[PrayerRequest]([accountId], [createdById]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PrayerRequestPrayer_userId_idx] ON [dbo].[PrayerRequestPrayer]([userId]);

-- AddForeignKey
ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_createdById_fkey] FOREIGN KEY ([createdById]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PrayerRequestPrayer] ADD CONSTRAINT [PrayerRequestPrayer_requestId_fkey] FOREIGN KEY ([requestId]) REFERENCES [dbo].[PrayerRequest]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PrayerRequestPrayer] ADD CONSTRAINT [PrayerRequestPrayer_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
