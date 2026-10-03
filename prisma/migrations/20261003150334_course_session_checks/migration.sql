-- Restricción que Prisma no expresa: la asistencia mínima es un porcentaje.
EXEC('ALTER TABLE [dbo].[CourseLevel] ADD CONSTRAINT [CourseLevel_minAttendance_ck] CHECK ([minAttendancePct] IS NULL OR [minAttendancePct] BETWEEN 1 AND 100)');
