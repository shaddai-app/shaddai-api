BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[FileObject] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [storageKey] VARCHAR(300) NOT NULL,
    [originalName] NVARCHAR(250) NOT NULL,
    [mimeType] VARCHAR(100) NOT NULL,
    [sizeBytes] INT NOT NULL,
    [purpose] VARCHAR(30) NOT NULL,
    [uploadedById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FileObject_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [deletedAt] DATETIME2,
    CONSTRAINT [FileObject_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [FileObject_storageKey_key] UNIQUE NONCLUSTERED ([storageKey])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FileObject_accountId_purpose_idx] ON [dbo].[FileObject]([accountId], [purpose]);

-- AddForeignKey
ALTER TABLE [dbo].[FileObject] ADD CONSTRAINT [FileObject_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
