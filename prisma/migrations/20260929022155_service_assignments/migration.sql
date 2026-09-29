BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[ServiceAssignment] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [eventId] INT NOT NULL,
    [occurrenceStart] DATETIME2 NOT NULL,
    [ministryId] INT NOT NULL,
    [serviceRoleId] INT NOT NULL,
    [personId] INT NOT NULL,
    [status] VARCHAR(10) NOT NULL CONSTRAINT [ServiceAssignment_status_df] DEFAULT 'pending',
    [respondedAt] DATETIME2,
    [declineReason] NVARCHAR(300),
    [notes] NVARCHAR(300),
    [assignedById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ServiceAssignment_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [ServiceAssignment_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ServiceAssignment_eventId_occurrenceStart_serviceRoleId_personId_key] UNIQUE NONCLUSTERED ([eventId],[occurrenceStart],[serviceRoleId],[personId])
);

-- CreateTable
CREATE TABLE [dbo].[Unavailability] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [personId] INT NOT NULL,
    [fromDate] DATE NOT NULL,
    [toDate] DATE NOT NULL,
    [reason] NVARCHAR(200),
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Unavailability_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Unavailability_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ServiceAssignment_accountId_ministryId_occurrenceStart_idx] ON [dbo].[ServiceAssignment]([accountId], [ministryId], [occurrenceStart]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ServiceAssignment_accountId_personId_occurrenceStart_idx] ON [dbo].[ServiceAssignment]([accountId], [personId], [occurrenceStart]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Unavailability_accountId_personId_fromDate_idx] ON [dbo].[Unavailability]([accountId], [personId], [fromDate]);

-- AddForeignKey
ALTER TABLE [dbo].[ServiceAssignment] ADD CONSTRAINT [ServiceAssignment_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ServiceAssignment] ADD CONSTRAINT [ServiceAssignment_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ServiceAssignment] ADD CONSTRAINT [ServiceAssignment_ministryId_fkey] FOREIGN KEY ([ministryId]) REFERENCES [dbo].[Ministry]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ServiceAssignment] ADD CONSTRAINT [ServiceAssignment_serviceRoleId_fkey] FOREIGN KEY ([serviceRoleId]) REFERENCES [dbo].[ServiceRole]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ServiceAssignment] ADD CONSTRAINT [ServiceAssignment_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Unavailability] ADD CONSTRAINT [Unavailability_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Unavailability] ADD CONSTRAINT [Unavailability_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Valores permitidos (a mano; EXEC porque las tablas son de este lote).
EXEC('ALTER TABLE [dbo].[ServiceAssignment] ADD CONSTRAINT [ServiceAssignment_status_ck] CHECK ([status] IN (''pending'',''accepted'',''declined''))');
EXEC('ALTER TABLE [dbo].[Unavailability] ADD CONSTRAINT [Unavailability_dates_ck] CHECK ([toDate] >= [fromDate])');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
