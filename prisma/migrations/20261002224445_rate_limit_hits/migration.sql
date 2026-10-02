BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[RateLimitHit] (
    [key] VARCHAR(200) NOT NULL,
    [hits] INT NOT NULL,
    [resetAt] DATETIME2 NOT NULL,
    CONSTRAINT [RateLimitHit_pkey] PRIMARY KEY CLUSTERED ([key])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [RateLimitHit_resetAt_idx] ON [dbo].[RateLimitHit]([resetAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
