"use client";

// /app/src/app/(dashboard)/app/admin/setup/database/DatabaseBackupView.tsx
//
// Database Backup & Restore body. App Router port of the legacy
// admin/setup/database body (minus MainLayout chrome, which the (dashboard)
// layout supplies). Downloads a .sql dump and restores from one against the
// shared /api/admin/database REST endpoints.

import { useRef, useState } from "react";
import { toast } from "react-toastify";
import { Download, Upload, AlertTriangle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface RestoreResult {
  success: boolean;
  message: string;
  errors?: string | null;
}

function RestoreResultCard({ result }: Readonly<{ result: RestoreResult }>) {
  const wrapClass = result.success ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200";
  const textClass = result.success ? "text-green-800" : "text-red-800";

  return (
    <div className={`border rounded-xl p-6 ${wrapClass}`}>
      <div className="flex items-start gap-3">
        {result.success ? (
          <CheckCircle className="w-6 h-6 text-green-700 flex-shrink-0" />
        ) : (
          <AlertTriangle className="w-6 h-6 text-red-700 flex-shrink-0" />
        )}
        <div>
          <p className={`font-serif font-semibold ${textClass}`}>{result.message}</p>
          {result.errors && (
            <pre className="mt-2 text-xs font-mono text-red-700 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {result.errors}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function DatabaseBackupView() {
  const [downloading, setDownloading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleBackup = async () => {
    setDownloading(true);
    try {
      const res = await fetch("/api/admin/database/backup");
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(err?.error || "Backup failed");
        return;
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="(.+)"/);
      const filename = match ? match[1] : "holt-backup.sql";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setLastBackup(new Date().toLocaleString());
      toast.success("Backup downloaded");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error downloading backup"));
    } finally {
      setDownloading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".sql")) {
      toast.error("File must be a .sql dump");
      return;
    }

    setRestoreFile(file);
    setShowRestoreConfirm(true);
    setConfirmText("");
    setRestoreResult(null);
  };

  const handleRestore = async () => {
    if (!restoreFile) return;
    if (confirmText !== "RESTORE") {
      toast.error('Type "RESTORE" to confirm');
      return;
    }

    setRestoring(true);
    try {
      const res = await fetch("/api/admin/database/restore", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: restoreFile,
      });

      const data = (await res.json()) as RestoreResult & { error?: string };
      setRestoreResult(data);

      if (data.success) {
        toast.success("Database restored successfully");
      } else {
        toast.error(data.error || "Restore failed");
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error during restore"));
    } finally {
      setRestoring(false);
      setShowRestoreConfirm(false);
      setRestoreFile(null);
      setConfirmText("");
    }
  };

  const cancelRestore = () => {
    setShowRestoreConfirm(false);
    setRestoreFile(null);
    setConfirmText("");
  };

  return (
    <div className="space-y-6">
      {/* Backup section */}
      <div className="bg-white border border-sh-gray/20 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <Download className="w-8 h-8 text-sh-blue flex-shrink-0 mt-1" />
          <div className="flex-1">
            <h2 className="text-lg font-serif font-semibold text-sh-blue mb-1">Download Backup</h2>
            <p className="text-sh-gray font-serif mb-4">
              Downloads a complete database dump as a .sql file. This includes all data, schema, and
              sequences. Store the file somewhere safe.
            </p>
            <div className="flex items-center gap-4">
              <Button onClick={handleBackup} disabled={downloading}>
                {downloading ? "Downloading..." : "Download Backup"}
              </Button>
              {lastBackup && (
                <span className="text-sm text-sh-gray font-serif">Last backup: {lastBackup}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Restore section */}
      <div className="bg-white border border-red-200 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <Upload className="w-8 h-8 text-red-700 flex-shrink-0 mt-1" />
          <div className="flex-1">
            <h2 className="text-lg font-serif font-semibold text-red-700 mb-1">
              Restore from Backup
            </h2>
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-red-700 flex-shrink-0 mt-0.5" />
                <p className="text-sm font-serif text-red-800">
                  Restoring a backup will replace all current data with the contents of the backup
                  file. This cannot be undone. Always download a fresh backup before restoring.
                </p>
              </div>
            </div>

            <label htmlFor="restore-file" className="sr-only">
              Backup file
            </label>
            <input
              id="restore-file"
              ref={fileRef}
              type="file"
              accept=".sql"
              onChange={handleFileSelect}
              className="hidden"
            />

            {!showRestoreConfirm ? (
              <Button
                variant="secondary"
                onClick={() => fileRef.current?.click()}
                className="!text-red-700 !border-red-300 hover:!bg-red-50"
              >
                Select Backup File
              </Button>
            ) : (
              <div className="border border-red-200 rounded-lg p-4 bg-red-50/50">
                <p className="font-serif text-sh-black mb-2">
                  File: <span className="font-semibold">{restoreFile?.name}</span>
                  <span className="text-sh-gray text-sm ml-2">
                    ({((restoreFile?.size || 0) / 1024 / 1024).toFixed(1)} MB)
                  </span>
                </p>
                <p className="font-serif text-sm text-red-800 mb-3">
                  Type <span className="font-mono font-semibold">RESTORE</span> to confirm:
                </p>
                <label htmlFor="restore-confirm" className="sr-only">
                  Type RESTORE to confirm
                </label>
                <input
                  id="restore-confirm"
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="Type RESTORE"
                  className="w-full max-w-xs border border-red-300 rounded-lg px-3 py-2 font-mono text-sh-black mb-3"
                  autoComplete="off"
                />
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={cancelRestore}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleRestore}
                    disabled={restoring || confirmText !== "RESTORE"}
                    className="!bg-red-700 hover:!bg-red-800"
                  >
                    {restoring ? "Restoring..." : "Restore Database"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {restoreResult && <RestoreResultCard result={restoreResult} />}
    </div>
  );
}
