BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[ConsolidationStep] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [systemKey] VARCHAR(40),
    [name] NVARCHAR(100),
    [sortOrder] INT NOT NULL,
    [dueDays] INT NOT NULL CONSTRAINT [ConsolidationStep_dueDays_df] DEFAULT 7,
    [isActive] BIT NOT NULL CONSTRAINT [ConsolidationStep_isActive_df] DEFAULT 1,
    CONSTRAINT [ConsolidationStep_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ConsolidationCase] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [personId] INT NOT NULL,
    [consolidatorUserId] INT,
    [currentStepId] INT,
    [status] VARCHAR(10) NOT NULL CONSTRAINT [ConsolidationCase_status_df] DEFAULT 'open',
    [source] VARCHAR(10) NOT NULL CONSTRAINT [ConsolidationCase_source_df] DEFAULT 'manual',
    [closeReason] NVARCHAR(300),
    [openedAt] DATE NOT NULL,
    [closedAt] DATE,
    [createdById] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ConsolidationCase_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ConsolidationCase_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ConsolidationCaseStep] (
    [id] INT NOT NULL IDENTITY(1,1),
    [caseId] INT NOT NULL,
    [stepId] INT NOT NULL,
    [dueAt] DATE NOT NULL,
    [completedAt] DATE,
    [completedById] INT,
    [notes] NVARCHAR(1000),
    CONSTRAINT [ConsolidationCaseStep_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ConsolidationCaseStep_caseId_stepId_key] UNIQUE NONCLUSTERED ([caseId],[stepId])
);

-- CreateTable
CREATE TABLE [dbo].[FollowUp] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [personId] INT NOT NULL,
    [caseId] INT,
    [type] VARCHAR(10) NOT NULL,
    [date] DATE NOT NULL,
    [notes] NVARCHAR(2000),
    [nextAction] NVARCHAR(200),
    [nextActionAt] DATE,
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FollowUp_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [FollowUp_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ConsolidationStep_accountId_sortOrder_idx] ON [dbo].[ConsolidationStep]([accountId], [sortOrder]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ConsolidationCase_accountId_status_consolidatorUserId_idx] ON [dbo].[ConsolidationCase]([accountId], [status], [consolidatorUserId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ConsolidationCase_accountId_personId_idx] ON [dbo].[ConsolidationCase]([accountId], [personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ConsolidationCaseStep_stepId_idx] ON [dbo].[ConsolidationCaseStep]([stepId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FollowUp_accountId_personId_idx] ON [dbo].[FollowUp]([accountId], [personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FollowUp_accountId_createdById_nextActionAt_idx] ON [dbo].[FollowUp]([accountId], [createdById], [nextActionAt]);

-- AddForeignKey
ALTER TABLE [dbo].[ConsolidationStep] ADD CONSTRAINT [ConsolidationStep_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ConsolidationCase] ADD CONSTRAINT [ConsolidationCase_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ConsolidationCase] ADD CONSTRAINT [ConsolidationCase_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ConsolidationCase] ADD CONSTRAINT [ConsolidationCase_consolidatorUserId_fkey] FOREIGN KEY ([consolidatorUserId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ConsolidationCase] ADD CONSTRAINT [ConsolidationCase_currentStepId_fkey] FOREIGN KEY ([currentStepId]) REFERENCES [dbo].[ConsolidationStep]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ConsolidationCaseStep] ADD CONSTRAINT [ConsolidationCaseStep_caseId_fkey] FOREIGN KEY ([caseId]) REFERENCES [dbo].[ConsolidationCase]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ConsolidationCaseStep] ADD CONSTRAINT [ConsolidationCaseStep_stepId_fkey] FOREIGN KEY ([stepId]) REFERENCES [dbo].[ConsolidationStep]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FollowUp] ADD CONSTRAINT [FollowUp_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FollowUp] ADD CONSTRAINT [FollowUp_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FollowUp] ADD CONSTRAINT [FollowUp_caseId_fkey] FOREIGN KEY ([caseId]) REFERENCES [dbo].[ConsolidationCase]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
