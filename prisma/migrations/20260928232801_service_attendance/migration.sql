BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[ServiceAttendance] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [eventId] INT NOT NULL,
    [occurrenceStart] DATETIME2 NOT NULL,
    [adults] INT NOT NULL CONSTRAINT [ServiceAttendance_adults_df] DEFAULT 0,
    [children] INT NOT NULL CONSTRAINT [ServiceAttendance_children_df] DEFAULT 0,
    [newcomers] INT NOT NULL CONSTRAINT [ServiceAttendance_newcomers_df] DEFAULT 0,
    [online] INT NOT NULL CONSTRAINT [ServiceAttendance_online_df] DEFAULT 0,
    [notes] NVARCHAR(500),
    [recordedById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ServiceAttendance_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ServiceAttendance_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ServiceAttendance_eventId_occurrenceStart_key] UNIQUE NONCLUSTERED ([eventId],[occurrenceStart])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ServiceAttendance_accountId_occurrenceStart_idx] ON [dbo].[ServiceAttendance]([accountId], [occurrenceStart]);

-- AddForeignKey
ALTER TABLE [dbo].[ServiceAttendance] ADD CONSTRAINT [ServiceAttendance_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ServiceAttendance] ADD CONSTRAINT [ServiceAttendance_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Conteos no negativos y nuevos incluidos en los presenciales (a mano; EXEC porque la tabla es de este lote).
EXEC('ALTER TABLE [dbo].[ServiceAttendance] ADD CONSTRAINT [ServiceAttendance_counts_ck] CHECK ([adults] >= 0 AND [children] >= 0 AND [newcomers] >= 0 AND [online] >= 0 AND [newcomers] <= [adults] + [children])');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
