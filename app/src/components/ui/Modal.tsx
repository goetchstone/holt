// /app/src/components/ui/Modal.tsx

import { ReactNode } from "react";
import { Dialog, DialogPanel, DialogTitle, DialogBackdrop } from "@headlessui/react";
import { Button } from "@/components/ui/button";

interface Props {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave: () => void;
  saving?: boolean;
  saveLabel?: string;
}

export default function Modal({
  title,
  children,
  onClose,
  onSave,
  saving = false,
  saveLabel,
}: Props) {
  return (
    <Dialog open={true} onClose={onClose} className="relative z-50">
      {/* Overlay */}
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-black/50 duration-300 ease-out data-closed:opacity-0"
      />

      {/* Modal content container - fixed, centered */}
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4 text-center">
          <DialogPanel
            transition
            className="w-full max-w-xl transform overflow-hidden rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all font-serif duration-300 ease-out data-closed:scale-95 data-closed:opacity-0"
          >
            <DialogTitle as="h3" className="text-xl font-semibold text-sh-blue mb-4">
              {title}
            </DialogTitle>
            <div className="mt-2 space-y-4">{children}</div>
            <div className="mt-6 flex justify-end space-x-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={onSave} disabled={saving}>
                {saving ? "Saving..." : saveLabel || "Save"}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
