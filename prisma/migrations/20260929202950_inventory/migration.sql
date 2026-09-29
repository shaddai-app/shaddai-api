BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[InventoryItem] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [campusId] INT,
    [code] VARCHAR(20) NOT NULL,
    [name] NVARCHAR(150) NOT NULL,
    [categoryId] INT NOT NULL,
    [brand] NVARCHAR(80),
    [model] NVARCHAR(80),
    [serialNumber] NVARCHAR(80),
    [status] VARCHAR(12) NOT NULL CONSTRAINT [InventoryItem_status_df] DEFAULT 'ok',
    [location] NVARCHAR(150),
    [purchaseDate] DATE,
    [purchaseValue] DECIMAL(18,2),
    [photoFileId] INT,
    [qrToken] CHAR(22) NOT NULL,
    [notes] NVARCHAR(1000),
    [searchText] NVARCHAR(500) NOT NULL CONSTRAINT [InventoryItem_searchText_df] DEFAULT '',
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [InventoryItem_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [InventoryItem_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [InventoryItem_qrToken_key] UNIQUE NONCLUSTERED ([qrToken]),
    CONSTRAINT [InventoryItem_accountId_code_key] UNIQUE NONCLUSTERED ([accountId],[code])
);

-- CreateTable
CREATE TABLE [dbo].[InventoryMaintenance] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [itemId] INT NOT NULL,
    [date] DATE NOT NULL,
    [type] VARCHAR(12) NOT NULL,
    [description] NVARCHAR(1000) NOT NULL,
    [cost] DECIMAL(18,2),
    [vendor] NVARCHAR(150),
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [InventoryMaintenance_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [InventoryMaintenance_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryItem_accountId_status_idx] ON [dbo].[InventoryItem]([accountId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryItem_accountId_categoryId_idx] ON [dbo].[InventoryItem]([accountId], [categoryId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryMaintenance_accountId_itemId_idx] ON [dbo].[InventoryMaintenance]([accountId], [itemId]);

-- AddForeignKey
ALTER TABLE [dbo].[InventoryItem] ADD CONSTRAINT [InventoryItem_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryItem] ADD CONSTRAINT [InventoryItem_campusId_fkey] FOREIGN KEY ([campusId]) REFERENCES [dbo].[Campus]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryItem] ADD CONSTRAINT [InventoryItem_categoryId_fkey] FOREIGN KEY ([categoryId]) REFERENCES [dbo].[CatalogItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryMaintenance] ADD CONSTRAINT [InventoryMaintenance_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryMaintenance] ADD CONSTRAINT [InventoryMaintenance_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[InventoryItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Valores permitidos (a mano; EXEC porque las tablas son de este lote).
EXEC('ALTER TABLE [dbo].[InventoryItem] ADD CONSTRAINT [InventoryItem_status_ck] CHECK ([status] IN (''ok'',''faulty'',''repair'',''retired''))');
EXEC('ALTER TABLE [dbo].[InventoryItem] ADD CONSTRAINT [InventoryItem_purchaseValue_ck] CHECK ([purchaseValue] IS NULL OR [purchaseValue] >= 0)');
EXEC('ALTER TABLE [dbo].[InventoryMaintenance] ADD CONSTRAINT [InventoryMaintenance_type_ck] CHECK ([type] IN (''preventive'',''repair'',''check''))');
EXEC('ALTER TABLE [dbo].[InventoryMaintenance] ADD CONSTRAINT [InventoryMaintenance_cost_ck] CHECK ([cost] IS NULL OR [cost] >= 0)');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
