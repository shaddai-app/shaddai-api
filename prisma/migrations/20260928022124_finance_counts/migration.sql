BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[FinanceMovement] ALTER COLUMN [financeAccountId] INT NULL;
ALTER TABLE [dbo].[FinanceMovement] ADD [cellReportId] INT,
[confirmedAt] DATETIME2,
[confirmedById] INT,
[offeringCountId] INT;

-- CreateTable
CREATE TABLE [dbo].[OfferingCount] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [financeAccountId] INT NOT NULL,
    [date] DATE NOT NULL,
    [title] NVARCHAR(100),
    [counter1PersonId] INT NOT NULL,
    [counter2PersonId] INT NOT NULL,
    [status] VARCHAR(10) NOT NULL CONSTRAINT [OfferingCount_status_df] DEFAULT 'draft',
    [notes] NVARCHAR(500),
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OfferingCount_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [confirmedAt] DATETIME2,
    [confirmedById] INT,
    [voidedAt] DATETIME2,
    [voidedById] INT,
    [voidReason] NVARCHAR(300),
    CONSTRAINT [OfferingCount_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[OfferingCountLine] (
    [id] INT NOT NULL IDENTITY(1,1),
    [countId] INT NOT NULL,
    [categoryId] INT NOT NULL,
    [paymentMethod] VARCHAR(10) NOT NULL,
    [denomination] DECIMAL(10,2),
    [quantity] INT,
    [amount] DECIMAL(18,2) NOT NULL,
    [personId] INT,
    [sortOrder] INT NOT NULL,
    CONSTRAINT [OfferingCountLine_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OfferingCount_accountId_date_idx] ON [dbo].[OfferingCount]([accountId], [date]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OfferingCount_accountId_status_idx] ON [dbo].[OfferingCount]([accountId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OfferingCountLine_countId_idx] ON [dbo].[OfferingCountLine]([countId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OfferingCountLine_personId_idx] ON [dbo].[OfferingCountLine]([personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceMovement_cellReportId_idx] ON [dbo].[FinanceMovement]([cellReportId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceMovement_offeringCountId_idx] ON [dbo].[FinanceMovement]([offeringCountId]);

-- AddForeignKey
ALTER TABLE [dbo].[FinanceMovement] ADD CONSTRAINT [FinanceMovement_cellReportId_fkey] FOREIGN KEY ([cellReportId]) REFERENCES [dbo].[CellReport]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinanceMovement] ADD CONSTRAINT [FinanceMovement_offeringCountId_fkey] FOREIGN KEY ([offeringCountId]) REFERENCES [dbo].[OfferingCount]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OfferingCount] ADD CONSTRAINT [OfferingCount_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OfferingCount] ADD CONSTRAINT [OfferingCount_financeAccountId_fkey] FOREIGN KEY ([financeAccountId]) REFERENCES [dbo].[FinanceAccount]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OfferingCount] ADD CONSTRAINT [OfferingCount_counter1PersonId_fkey] FOREIGN KEY ([counter1PersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OfferingCount] ADD CONSTRAINT [OfferingCount_counter2PersonId_fkey] FOREIGN KEY ([counter2PersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OfferingCountLine] ADD CONSTRAINT [OfferingCountLine_countId_fkey] FOREIGN KEY ([countId]) REFERENCES [dbo].[OfferingCount]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[OfferingCountLine] ADD CONSTRAINT [OfferingCountLine_categoryId_fkey] FOREIGN KEY ([categoryId]) REFERENCES [dbo].[FinanceCategory]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OfferingCountLine] ADD CONSTRAINT [OfferingCountLine_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Integridad (a mano): solo pendientes y rechazados pueden no tener caja; montos positivos.
ALTER TABLE [dbo].[FinanceMovement] ADD CONSTRAINT [FinanceMovement_account_required_ck] CHECK ([financeAccountId] IS NOT NULL OR [status] IN ('pending', 'rejected'));
ALTER TABLE [dbo].[OfferingCountLine] ADD CONSTRAINT [OfferingCountLine_amount_positive_ck] CHECK ([amount] > 0);
ALTER TABLE [dbo].[OfferingCount] ADD CONSTRAINT [OfferingCount_counters_ck] CHECK ([counter1PersonId] <> [counter2PersonId]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
