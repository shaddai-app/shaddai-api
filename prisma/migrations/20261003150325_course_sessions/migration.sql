BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[CourseLevel] ADD [minAttendancePct] INT;

-- CreateTable
CREATE TABLE [dbo].[CourseSession] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [levelId] INT NOT NULL,
    [date] DATE NOT NULL,
    [topic] NVARCHAR(200),
    [notes] NVARCHAR(1000),
    [createdById] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CourseSession_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CourseSession_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CourseSession_levelId_date_key] UNIQUE NONCLUSTERED ([levelId],[date])
);

-- CreateTable
CREATE TABLE [dbo].[CourseAttendance] (
    [sessionId] INT NOT NULL,
    [enrollmentId] INT NOT NULL,
    [present] BIT NOT NULL,
    CONSTRAINT [CourseAttendance_pkey] PRIMARY KEY CLUSTERED ([sessionId],[enrollmentId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CourseSession_accountId_levelId_date_idx] ON [dbo].[CourseSession]([accountId], [levelId], [date]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CourseAttendance_enrollmentId_idx] ON [dbo].[CourseAttendance]([enrollmentId]);

-- AddForeignKey
ALTER TABLE [dbo].[CourseSession] ADD CONSTRAINT [CourseSession_levelId_fkey] FOREIGN KEY ([levelId]) REFERENCES [dbo].[CourseLevel]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CourseAttendance] ADD CONSTRAINT [CourseAttendance_sessionId_fkey] FOREIGN KEY ([sessionId]) REFERENCES [dbo].[CourseSession]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CourseAttendance] ADD CONSTRAINT [CourseAttendance_enrollmentId_fkey] FOREIGN KEY ([enrollmentId]) REFERENCES [dbo].[CourseEnrollment]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
