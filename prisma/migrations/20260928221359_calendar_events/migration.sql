BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[CalendarEvent] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [campusId] INT,
    [type] VARCHAR(10) NOT NULL,
    [title] NVARCHAR(150) NOT NULL,
    [description] NVARCHAR(2000),
    [location] NVARCHAR(250),
    [startsAt] DATETIME2 NOT NULL,
    [endsAt] DATETIME2 NOT NULL,
    [allDay] BIT NOT NULL CONSTRAINT [CalendarEvent_allDay_df] DEFAULT 0,
    [rrule] VARCHAR(500),
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CalendarEvent_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [CalendarEvent_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[EventException] (
    [id] INT NOT NULL IDENTITY(1,1),
    [eventId] INT NOT NULL,
    [originalStart] DATETIME2 NOT NULL,
    [cancelled] BIT NOT NULL CONSTRAINT [EventException_cancelled_df] DEFAULT 0,
    [newStartsAt] DATETIME2,
    [newEndsAt] DATETIME2,
    [note] NVARCHAR(200),
    CONSTRAINT [EventException_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [EventException_eventId_originalStart_key] UNIQUE NONCLUSTERED ([eventId],[originalStart])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CalendarEvent_accountId_startsAt_idx] ON [dbo].[CalendarEvent]([accountId], [startsAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CalendarEvent_accountId_type_idx] ON [dbo].[CalendarEvent]([accountId], [type]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EventException_eventId_newStartsAt_idx] ON [dbo].[EventException]([eventId], [newStartsAt]);

-- AddForeignKey
ALTER TABLE [dbo].[CalendarEvent] ADD CONSTRAINT [CalendarEvent_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarEvent] ADD CONSTRAINT [CalendarEvent_campusId_fkey] FOREIGN KEY ([campusId]) REFERENCES [dbo].[Campus]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[EventException] ADD CONSTRAINT [EventException_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- Integridad (a mano): tipo conocido y fin no anterior al inicio.
ALTER TABLE [dbo].[CalendarEvent] ADD CONSTRAINT [CalendarEvent_type_ck] CHECK ([type] IN ('service', 'meeting', 'special', 'other'));
ALTER TABLE [dbo].[CalendarEvent] ADD CONSTRAINT [CalendarEvent_range_ck] CHECK ([endsAt] >= [startsAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
