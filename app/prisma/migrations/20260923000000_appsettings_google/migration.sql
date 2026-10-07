-- AppSettings.google: Google Drive/Slides project-creation config, shape
--   { "drive": { "projectsRootFolderId": ..., "projectSubfolders": [...] },
--     "slides": { "templatePresentationId": ... } }.
-- Nullable and unset by default: with no folder + template configured, the
-- Create Project route (api/google/create-project) refuses (503) rather than
-- writing customer project folders into whatever Drive a hardcoded id once
-- pointed at (VAL-04). Set at Admin -> Settings -> Integrations.
ALTER TABLE "AppSettings" ADD COLUMN "google" JSONB;
