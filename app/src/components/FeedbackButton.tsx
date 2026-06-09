// /app/src/components/FeedbackButton.tsx

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { Dialog, DialogPanel, DialogTitle, DialogBackdrop } from "@headlessui/react";
import { Button } from "@/components/ui/button";
import { MessageSquarePlus } from "lucide-react";
import axios from "axios";
import { toast } from "react-toastify";

const CATEGORIES = [
  { value: "bug", label: "Something is broken" },
  { value: "data", label: "Wrong data or missing records" },
  { value: "enhancement", label: "Feature request or improvement" },
  { value: "question", label: "Question or confusion" },
];

const AREAS = [
  "Sales / POS",
  "Quotes / Orders",
  "Inventory / Warehouse",
  "Purchasing / POs",
  "Service Cases",
  "Service Dispatch",
  "House Calls",
  "Returns",
  "Reports / Dashboard",
  "Pricing / Import",
  "Products / Catalog",
  "Customers",
  "Admin / Setup",
  "Printing",
  "Delivery / Dispatch",
  "Other",
];

export default function FeedbackButton() {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [area, setArea] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Allow other components to open the feedback modal via custom event
  useEffect(() => {
    function handleOpenFeedback() {
      setArea(guessArea(router.pathname));
      setOpen(true);
    }
    globalThis.addEventListener("open-feedback", handleOpenFeedback);
    return () => globalThis.removeEventListener("open-feedback", handleOpenFeedback);
  }, [router.pathname]);

  if (!session) return null;

  const handleSubmit = async () => {
    if (!category || !description.trim()) {
      toast.error("Please select a category and describe the issue");
      return;
    }

    setSubmitting(true);
    try {
      await axios.post("/api/feedback", {
        category,
        area,
        description: description.trim(),
        pageUrl: globalThis.location.href,
        userAgent: navigator.userAgent,
      });
      toast.success("Feedback submitted -- thank you!");
      setOpen(false);
      setCategory("");
      setArea("");
      setDescription("");
    } catch {
      toast.error("Failed to submit feedback. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        onClick={() => {
          setArea(guessArea(router.pathname));
          setOpen(true);
        }}
        className="fixed bottom-6 left-6 z-40 flex items-center gap-2 rounded-lg bg-sh-navy/80 px-3 py-2 text-white text-xs font-medium shadow hover:bg-sh-navy transition-colors print:hidden"
        style={{ minHeight: 44 }}
        aria-label="Report an issue or give feedback"
      >
        <MessageSquarePlus size={16} />
        <span>Feedback</span>
      </button>

      {open && (
        <Dialog open={true} onClose={handleClose} className="relative z-50">
          <DialogBackdrop
            transition
            className="fixed inset-0 bg-black/50 duration-300 ease-out data-closed:opacity-0"
          />
          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4">
              <DialogPanel
                transition
                className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white p-6 text-left shadow-xl font-serif duration-300 ease-out data-closed:scale-95 data-closed:opacity-0"
              >
                <DialogTitle as="h3" className="text-xl font-semibold text-sh-blue mb-4">
                  Report an Issue
                </DialogTitle>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-sh-gray mb-1">
                      What kind of issue?
                    </label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="w-full rounded-lg border border-sh-gray/30 px-3 py-2.5 text-sm focus:border-sh-blue focus:outline-none"
                    >
                      <option value="">Select...</option>
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-sh-gray mb-1">Area</label>
                    <select
                      value={area}
                      onChange={(e) => setArea(e.target.value)}
                      className="w-full rounded-lg border border-sh-gray/30 px-3 py-2.5 text-sm focus:border-sh-blue focus:outline-none"
                    >
                      <option value="">Select...</option>
                      {AREAS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-sh-gray mb-1">
                      Describe the issue
                    </label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={4}
                      placeholder="What happened? What did you expect?"
                      className="w-full rounded-lg border border-sh-gray/30 px-3 py-2.5 text-sm focus:border-sh-blue focus:outline-none resize-none"
                    />
                  </div>

                  <p className="text-xs text-sh-gray">
                    Submitted by {session.user?.email} from {router.pathname}
                  </p>
                </div>

                <div className="mt-6 flex justify-end gap-2">
                  <Button variant="secondary" onClick={handleClose} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Submitting..." : "Submit"}
                  </Button>
                </div>
              </DialogPanel>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function guessArea(pathname: string): string {
  if (pathname.startsWith("/app/sales/pos")) return "Sales / POS";
  if (pathname.startsWith("/app/sales/quotes")) return "Quotes / Orders";
  if (pathname.startsWith("/app/sales/orders")) return "Quotes / Orders";
  if (pathname.startsWith("/app/sales/returns")) return "Returns";
  if (pathname.startsWith("/app/sales")) return "Sales / POS";
  if (pathname.startsWith("/app/warehouse")) return "Inventory / Warehouse";
  if (pathname.startsWith("/app/inventory")) return "Inventory / Warehouse";
  if (pathname.startsWith("/app/purchasing")) return "Purchasing / POs";
  if (pathname.startsWith("/app/service/dispatch")) return "Service Dispatch";
  if (pathname.startsWith("/app/service/house")) return "House Calls";
  if (pathname.startsWith("/app/service")) return "Service Cases";
  if (pathname.startsWith("/app/reports")) return "Reports / Dashboard";
  if (pathname.startsWith("/app/admin/pricing")) return "Pricing / Import";
  if (pathname.startsWith("/app/admin")) return "Admin / Setup";
  if (pathname.startsWith("/print")) return "Printing";
  return "";
}
