BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[CellReport] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [cellId] INT NOT NULL,
    [meetingDate] DATE NOT NULL,
    [held] BIT NOT NULL,
    [notHeldReason] NVARCHAR(300),
    [topic] NVARCHAR(200),
    [anonymousVisitors] INT NOT NULL CONSTRAINT [CellReport_anonymousVisitors_df] DEFAULT 0,
    [childrenCount] INT NOT NULL CONSTRAINT [CellReport_childrenCount_df] DEFAULT 0,
    [offeringAmount] DECIMAL(18,2),
    [notes] NVARCHAR(1000),
    [submittedById] INT NOT NULL,
    [submittedAt] DATETIME2 NOT NULL CONSTRAINT [CellReport_submittedAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CellReport_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CellReport_cellId_meetingDate_key] UNIQUE NONCLUSTERED ([cellId],[meetingDate])
);

-- CreateTable
CREATE TABLE [dbo].[CellReportAttendance] (
    [reportId] INT NOT NULL,
    [personId] INT NOT NULL,
    [isVisitor] BIT NOT NULL CONSTRAINT [CellReportAttendance_isVisitor_df] DEFAULT 0,
    CONSTRAINT [CellReportAttendance_pkey] PRIMARY KEY CLUSTERED ([reportId],[personId])
);

-- CreateTable
CREATE TABLE [dbo].[CellMultiplication] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [motherCellId] INT NOT NULL,
    [childCellId] INT NOT NULL,
    [date] DATE NOT NULL,
    [notes] NVARCHAR(500),
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CellMultiplication_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CellMultiplication_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CellReport_accountId_meetingDate_idx] ON [dbo].[CellReport]([accountId], [meetingDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CellReportAttendance_personId_idx] ON [dbo].[CellReportAttendance]([personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CellMultiplication_accountId_date_idx] ON [dbo].[CellMultiplication]([accountId], [date]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CellMultiplication_accountId_motherCellId_idx] ON [dbo].[CellMultiplication]([accountId], [motherCellId]);

-- AddForeignKey
ALTER TABLE [dbo].[CellReport] ADD CONSTRAINT [CellReport_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CellReport] ADD CONSTRAINT [CellReport_cellId_fkey] FOREIGN KEY ([cellId]) REFERENCES [dbo].[Cell]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CellReportAttendance] ADD CONSTRAINT [CellReportAttendance_reportId_fkey] FOREIGN KEY ([reportId]) REFERENCES [dbo].[CellReport]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CellReportAttendance] ADD CONSTRAINT [CellReportAttendance_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CellMultiplication] ADD CONSTRAINT [CellMultiplication_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CellMultiplication] ADD CONSTRAINT [CellMultiplication_motherCellId_fkey] FOREIGN KEY ([motherCellId]) REFERENCES [dbo].[Cell]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CellMultiplication] ADD CONSTRAINT [CellMultiplication_childCellId_fkey] FOREIGN KEY ([childCellId]) REFERENCES [dbo].[Cell]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
