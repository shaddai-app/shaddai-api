BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[CalendarEvent] ADD [capacity] INT,
[isPublic] BIT NOT NULL CONSTRAINT [CalendarEvent_isPublic_df] DEFAULT 0,
[price] DECIMAL(18,2),
[registrationEnabled] BIT NOT NULL CONSTRAINT [CalendarEvent_registrationEnabled_df] DEFAULT 0,
[waitlistEnabled] BIT NOT NULL CONSTRAINT [CalendarEvent_waitlistEnabled_df] DEFAULT 0;

-- CreateTable
CREATE TABLE [dbo].[EventRegistration] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [eventId] INT NOT NULL,
    [occurrenceStart] DATETIME2 NOT NULL,
    [personId] INT,
    [name] NVARCHAR(150) NOT NULL,
    [email] NVARCHAR(150),
    [phone] VARCHAR(30),
    [notes] NVARCHAR(500),
    [status] VARCHAR(10) NOT NULL CONSTRAINT [EventRegistration_status_df] DEFAULT 'confirmed',
    [source] VARCHAR(6) NOT NULL CONSTRAINT [EventRegistration_source_df] DEFAULT 'staff',
    [paidAmount] DECIMAL(18,2),
    [paymentMovementId] INT,
    [createdById] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [EventRegistration_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [cancelledAt] DATETIME2,
    CONSTRAINT [EventRegistration_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EventRegistration_accountId_eventId_occurrenceStart_status_idx] ON [dbo].[EventRegistration]([accountId], [eventId], [occurrenceStart], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EventRegistration_accountId_personId_idx] ON [dbo].[EventRegistration]([accountId], [personId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EventRegistration_paymentMovementId_idx] ON [dbo].[EventRegistration]([paymentMovementId]);

-- AddForeignKey
ALTER TABLE [dbo].[EventRegistration] ADD CONSTRAINT [EventRegistration_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[EventRegistration] ADD CONSTRAINT [EventRegistration_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[EventRegistration] ADD CONSTRAINT [EventRegistration_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[EventRegistration] ADD CONSTRAINT [EventRegistration_paymentMovementId_fkey] FOREIGN KEY ([paymentMovementId]) REFERENCES [dbo].[FinanceMovement]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Integridad (a mano): estados conocidos, cupo y precio positivos.
ALTER TABLE [dbo].[EventRegistration] ADD CONSTRAINT [EventRegistration_status_ck] CHECK ([status] IN ('confirmed', 'waitlist', 'cancelled'));
-- Con EXEC: las columnas se agregan en este mismo lote y SQL Server lo compila entero antes de correrlo.
EXEC('ALTER TABLE [dbo].[CalendarEvent] ADD CONSTRAINT [CalendarEvent_capacity_ck] CHECK ([capacity] IS NULL OR [capacity] > 0)');
EXEC('ALTER TABLE [dbo].[CalendarEvent] ADD CONSTRAINT [CalendarEvent_price_ck] CHECK ([price] IS NULL OR [price] >= 0)');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
