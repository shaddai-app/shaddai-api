BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Notification] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [userId] INT NOT NULL,
    [type] VARCHAR(40) NOT NULL,
    [params] NVARCHAR(max),
    [link] VARCHAR(300),
    [readAt] DATETIME2,
    [emailedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Notification_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Notification_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_accountId_userId_readAt_idx] ON [dbo].[Notification]([accountId], [userId], [readAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_userId_createdAt_idx] ON [dbo].[Notification]([userId], [createdAt]);

-- AddForeignKey
ALTER TABLE [dbo].[Notification] ADD CONSTRAINT [Notification_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Notification] ADD CONSTRAINT [Notification_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
