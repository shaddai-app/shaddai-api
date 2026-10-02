BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Notification] ADD [dedupeKey] VARCHAR(150),
[inApp] BIT NOT NULL CONSTRAINT [Notification_inApp_df] DEFAULT 1;

-- CreateTable
CREATE TABLE [dbo].[DailyJobRun] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [job] VARCHAR(40) NOT NULL,
    [runDate] DATE NOT NULL,
    [startedAt] DATETIME2 NOT NULL CONSTRAINT [DailyJobRun_startedAt_df] DEFAULT CURRENT_TIMESTAMP,
    [finishedAt] DATETIME2,
    [notices] INT,
    [error] NVARCHAR(1000),
    CONSTRAINT [DailyJobRun_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DailyJobRun_accountId_job_runDate_key] UNIQUE NONCLUSTERED ([accountId],[job],[runDate])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_userId_dedupeKey_idx] ON [dbo].[Notification]([userId], [dedupeKey]);

-- AddForeignKey
ALTER TABLE [dbo].[DailyJobRun] ADD CONSTRAINT [DailyJobRun_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
