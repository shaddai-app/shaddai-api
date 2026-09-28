BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[FinancePeriod] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [year] SMALLINT NOT NULL,
    [month] TINYINT NOT NULL,
    [status] VARCHAR(6) NOT NULL CONSTRAINT [FinancePeriod_status_df] DEFAULT 'open',
    [closedAt] DATETIME2,
    [closedById] INT,
    [notes] NVARCHAR(500),
    [reopenedAt] DATETIME2,
    [reopenedById] INT,
    [reopenReason] NVARCHAR(300),
    CONSTRAINT [FinancePeriod_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [FinancePeriod_accountId_year_month_key] UNIQUE NONCLUSTERED ([accountId],[year],[month])
);

-- CreateTable
CREATE TABLE [dbo].[FinancePeriodBalance] (
    [periodId] INT NOT NULL,
    [financeAccountId] INT NOT NULL,
    [opening] DECIMAL(18,2) NOT NULL,
    [income] DECIMAL(18,2) NOT NULL,
    [expense] DECIMAL(18,2) NOT NULL,
    [transfersIn] DECIMAL(18,2) NOT NULL,
    [transfersOut] DECIMAL(18,2) NOT NULL,
    [closing] DECIMAL(18,2) NOT NULL,
    CONSTRAINT [FinancePeriodBalance_pkey] PRIMARY KEY CLUSTERED ([periodId],[financeAccountId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinancePeriodBalance_financeAccountId_idx] ON [dbo].[FinancePeriodBalance]([financeAccountId]);

-- AddForeignKey
ALTER TABLE [dbo].[FinancePeriod] ADD CONSTRAINT [FinancePeriod_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinancePeriodBalance] ADD CONSTRAINT [FinancePeriodBalance_periodId_fkey] FOREIGN KEY ([periodId]) REFERENCES [dbo].[FinancePeriod]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FinancePeriodBalance] ADD CONSTRAINT [FinancePeriodBalance_financeAccountId_fkey] FOREIGN KEY ([financeAccountId]) REFERENCES [dbo].[FinanceAccount]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Integridad (a mano): mes válido y estado conocido.
ALTER TABLE [dbo].[FinancePeriod] ADD CONSTRAINT [FinancePeriod_month_ck] CHECK ([month] BETWEEN 1 AND 12);
ALTER TABLE [dbo].[FinancePeriod] ADD CONSTRAINT [FinancePeriod_status_ck] CHECK ([status] IN ('open', 'closed'));

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
