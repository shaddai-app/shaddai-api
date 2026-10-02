BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[InventoryLoan] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [itemId] INT NOT NULL,
    [borrowerPersonId] INT NOT NULL,
    [borrowedAt] DATE NOT NULL,
    [dueAt] DATE NOT NULL,
    [returnedAt] DATETIME2,
    [conditionOut] NVARCHAR(200),
    [conditionIn] NVARCHAR(200),
    [notes] NVARCHAR(500),
    [createdById] INT NOT NULL,
    [returnedById] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [InventoryLoan_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [InventoryLoan_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryLoan_accountId_returnedAt_dueAt_idx] ON [dbo].[InventoryLoan]([accountId], [returnedAt], [dueAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryLoan_accountId_itemId_idx] ON [dbo].[InventoryLoan]([accountId], [itemId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryLoan_accountId_borrowerPersonId_idx] ON [dbo].[InventoryLoan]([accountId], [borrowerPersonId]);

-- AddForeignKey
ALTER TABLE [dbo].[InventoryLoan] ADD CONSTRAINT [InventoryLoan_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryLoan] ADD CONSTRAINT [InventoryLoan_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[InventoryItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryLoan] ADD CONSTRAINT [InventoryLoan_borrowerPersonId_fkey] FOREIGN KEY ([borrowerPersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Valores permitidos (a mano; EXEC porque la tabla es de este lote).
EXEC('ALTER TABLE [dbo].[InventoryLoan] ADD CONSTRAINT [InventoryLoan_dates_ck] CHECK ([dueAt] >= [borrowedAt])');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
