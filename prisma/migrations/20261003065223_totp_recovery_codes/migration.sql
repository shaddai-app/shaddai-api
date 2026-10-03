BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[TotpRecoveryCode] (
    [id] INT NOT NULL IDENTITY(1,1),
    [userId] INT NOT NULL,
    [codeHash] CHAR(64) NOT NULL,
    [usedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [TotpRecoveryCode_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [TotpRecoveryCode_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TotpRecoveryCode_userId_idx] ON [dbo].[TotpRecoveryCode]([userId]);

-- AddForeignKey
ALTER TABLE [dbo].[TotpRecoveryCode] ADD CONSTRAINT [TotpRecoveryCode_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
