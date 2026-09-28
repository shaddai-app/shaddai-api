BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[FinanceAccount] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [campusId] INT,
    [name] NVARCHAR(100) NOT NULL,
    [type] VARCHAR(6) NOT NULL,
    [currency] CHAR(3) NOT NULL,
    [openingBalance] DECIMAL(18,2) NOT NULL CONSTRAINT [FinanceAccount_openingBalance_df] DEFAULT 0,
    [openingDate] DATE NOT NULL,
    [responsibleUserId] INT,
    [isActive] BIT NOT NULL CONSTRAINT [FinanceAccount_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FinanceAccount_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [FinanceAccount_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[FinanceCategory] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [kind] VARCHAR(7) NOT NULL,
    [systemKey] VARCHAR(40),
    [name] NVARCHAR(100),
    [sortOrder] INT NOT NULL,
    [isActive] BIT NOT NULL CONSTRAINT [FinanceCategory_isActive_df] DEFAULT 1,
    CONSTRAINT [FinanceCategory_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[FinanceMovement] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [financeAccountId] INT NOT NULL,
    [categoryId] INT,
    [kind] VARCHAR(12) NOT NULL,
    [date] DATE NOT NULL,
    [amount] DECIMAL(18,2) NOT NULL,
    [description] NVARCHAR(300),
    [personId] INT,
    [isAnonymous] BIT NOT NULL CONSTRAINT [FinanceMovement_isAnonymous_df] DEFAULT 0,
    [paymentMethod] VARCHAR(10),
    [reference] NVARCHAR(100),
    [status] VARCHAR(10) NOT NULL CONSTRAINT [FinanceMovement_status_df] DEFAULT 'confirmed',
    [transferPairId] INT,
    [voidedAt] DATETIME2,
    [voidedById] INT,
    [voidReason] NVARCHAR(300),
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FinanceMovement_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [FinanceMovement_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- Montos siempre positivos (el signo lo da el tipo de movimiento). No lo modela Prisma: defensa en la base.
ALTER TABLE [dbo].[FinanceMovement] ADD CONSTRAINT [FinanceMovement_amount_positive_ck] CHECK ([amount] > 0);

-- CreateTable
CREATE TABLE [dbo].[MovementAttachment] (
    [movementId] INT NOT NULL,
    [fileId] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [MovementAttachment_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [MovementAttachment_pkey] PRIMARY KEY CLUSTERED ([movementId],[fileId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceAccount_accountId_idx] ON [dbo].[FinanceAccount]([accountId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceCategory_accountId_kind_idx] ON [dbo].[FinanceCategory]([accountId], [kind]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceMovement_accountId_date_idx] ON [dbo].[FinanceMovement]([accountId], [date]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceMovement_accountId_financeAccountId_date_idx] ON [dbo].[FinanceMovement]([accountId], [financeAccountId], [date]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceMovement_accountId_categoryId_date_idx] ON [dbo].[FinanceMovement]([accountId], [categoryId], [date]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceMovement_accountId_personId_idx] ON [dbo].[FinanceMovement]([accountId], [personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceMovement_accountId_status_idx] ON [dbo].[FinanceMovement]([accountId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FinanceMovement_transferPairId_idx] ON [dbo].[FinanceMovement]([transferPairId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [MovementAttachment_fileId_idx] ON [dbo].[MovementAttachment]([fileId]);

-- AddForeignKey
ALTER TABLE [dbo].[FinanceAccount] ADD CONSTRAINT [FinanceAccount_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinanceAccount] ADD CONSTRAINT [FinanceAccount_campusId_fkey] FOREIGN KEY ([campusId]) REFERENCES [dbo].[Campus]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinanceAccount] ADD CONSTRAINT [FinanceAccount_responsibleUserId_fkey] FOREIGN KEY ([responsibleUserId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinanceCategory] ADD CONSTRAINT [FinanceCategory_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinanceMovement] ADD CONSTRAINT [FinanceMovement_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinanceMovement] ADD CONSTRAINT [FinanceMovement_financeAccountId_fkey] FOREIGN KEY ([financeAccountId]) REFERENCES [dbo].[FinanceAccount]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinanceMovement] ADD CONSTRAINT [FinanceMovement_categoryId_fkey] FOREIGN KEY ([categoryId]) REFERENCES [dbo].[FinanceCategory]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FinanceMovement] ADD CONSTRAINT [FinanceMovement_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[MovementAttachment] ADD CONSTRAINT [MovementAttachment_movementId_fkey] FOREIGN KEY ([movementId]) REFERENCES [dbo].[FinanceMovement]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[MovementAttachment] ADD CONSTRAINT [MovementAttachment_fileId_fkey] FOREIGN KEY ([fileId]) REFERENCES [dbo].[FileObject]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
