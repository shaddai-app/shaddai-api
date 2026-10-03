BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Account] ADD [paidUntil] DATETIME2;

-- AlterTable
ALTER TABLE [dbo].[Plan] ADD [priceArs] DECIMAL(12,2);

-- CreateTable
CREATE TABLE [dbo].[Subscription] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [planId] INT NOT NULL,
    [provider] VARCHAR(20) NOT NULL,
    [providerRef] VARCHAR(100) NOT NULL,
    [externalRef] VARCHAR(64) NOT NULL,
    [status] VARCHAR(15) NOT NULL CONSTRAINT [Subscription_status_df] DEFAULT 'pending',
    [amount] DECIMAL(12,2) NOT NULL,
    [currency] CHAR(3) NOT NULL,
    [payerEmail] NVARCHAR(150) NOT NULL,
    [checkoutUrl] NVARCHAR(500),
    [nextPaymentAt] DATETIME2,
    [createdById] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Subscription_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [cancelledAt] DATETIME2,
    CONSTRAINT [Subscription_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Subscription_externalRef_key] UNIQUE NONCLUSTERED ([externalRef]),
    CONSTRAINT [Subscription_provider_providerRef_key] UNIQUE NONCLUSTERED ([provider],[providerRef])
);

-- CreateTable
CREATE TABLE [dbo].[Invoice] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [subscriptionId] INT,
    [provider] VARCHAR(20) NOT NULL,
    [providerRef] VARCHAR(100) NOT NULL,
    [status] VARCHAR(15) NOT NULL,
    [amount] DECIMAL(12,2) NOT NULL,
    [currency] CHAR(3) NOT NULL,
    [periodStart] DATETIME2,
    [periodEnd] DATETIME2,
    [paidAt] DATETIME2,
    [note] NVARCHAR(300),
    [createdById] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Invoice_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Invoice_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Invoice_provider_providerRef_key] UNIQUE NONCLUSTERED ([provider],[providerRef])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Subscription_accountId_status_idx] ON [dbo].[Subscription]([accountId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Invoice_accountId_createdAt_idx] ON [dbo].[Invoice]([accountId], [createdAt]);

-- AddForeignKey
ALTER TABLE [dbo].[Subscription] ADD CONSTRAINT [Subscription_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Subscription] ADD CONSTRAINT [Subscription_planId_fkey] FOREIGN KEY ([planId]) REFERENCES [dbo].[Plan]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Invoice] ADD CONSTRAINT [Invoice_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Invoice] ADD CONSTRAINT [Invoice_subscriptionId_fkey] FOREIGN KEY ([subscriptionId]) REFERENCES [dbo].[Subscription]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
