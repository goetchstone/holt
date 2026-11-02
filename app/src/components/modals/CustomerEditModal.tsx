// /app/src/components/modals/CustomerEditModal.tsx

import { useState, useEffect } from "react";
import axios from "axios";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import FormSection from "@/components/form/FormSection";
import { Customer } from "@prisma/client";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { useCustomerSearch } from "@/hooks/useCustomerSearch";

/** The record as the detail page sends it, with the names behind its referral ids. */
type EditableCustomer = Customer & {
  referralSource?: { id: number; name: string; isActive: boolean } | null;
  referredBy?: { id: number; firstName: string | null; lastName: string | null } | null;
};

interface CustomerEditModalProps {
  item: EditableCustomer | null;
  onClose: () => void;
}

const nameOf = (c: { firstName: string | null; lastName: string | null; id: number }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ") || `Customer #${c.id}`;

/** Who referred them, by name where the record carries it. */
function initialReferrer(customer: EditableCustomer | null): { id: number; name: string } | null {
  if (customer?.referredBy)
    return { id: customer.referredBy.id, name: nameOf(customer.referredBy) };
  if (customer?.referredByCustomerId) {
    return {
      id: customer.referredByCustomerId,
      name: `Customer #${customer.referredByCustomerId}`,
    };
  }
  return null;
}

/** The referral fields the user changed, as the routes take them; the rest are left out. */
function referralChanges(
  touched: { source: boolean; referrer: boolean },
  sourceId: string,
  referrer: { id: number } | null,
): { referralSourceId?: number | null; referredByCustomerId?: number | null } {
  const changes: { referralSourceId?: number | null; referredByCustomerId?: number | null } = {};
  if (touched.source) changes.referralSourceId = sourceId ? Number(sourceId) : null;
  if (touched.referrer) changes.referredByCustomerId = referrer?.id ?? null;
  return changes;
}

const CustomerEditModal = ({ item: customer, onClose }: CustomerEditModalProps) => {
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [isSaving, setIsSaving] = useState(false);
  // How they heard of the store, and who sent them (GAP-08). Sent only when
  // changed here: the customer list opens this form on a list row, which may
  // not carry them, and saving must not clear what it never showed.
  const [sources, setSources] = useState<{ id: number; name: string }[]>([]);
  const [sourceId, setSourceId] = useState<string>(
    customer?.referralSourceId ? String(customer.referralSourceId) : "",
  );
  const [referrer, setReferrer] = useState(initialReferrer(customer));
  const [touched, setTouched] = useState({ source: false, referrer: false });
  const search = useCustomerSearch({ limit: 6 });

  useEffect(() => {
    let live = true;
    axios
      .get<{ id: number; name: string }[]>("/api/referral-sources")
      .then((res) => {
        if (live) setSources(res.data);
      })
      .catch(() => {
        if (live) setSources([]);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (customer && customer.id) {
      setFormData({
        firstName: customer.firstName || "",
        lastName: customer.lastName || "",
        email: customer.email || "",
        phone: customer.phone || "",
      });
    } else {
      setFormData({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
      });
    }
  }, [customer]);

  const handleSave = async () => {
    setIsSaving(true);
    const body = { ...formData, ...referralChanges(touched, sourceId, referrer) };
    try {
      if (customer?.id) {
        await axios.put(`/api/customers/${customer.id}`, body);
        toast.success("Customer updated successfully.");
      } else {
        await axios.post("/api/customers", body);
        toast.success("Customer created successfully.");
      }
      onClose();
    } catch (error) {
      // The route says what was wrong (rule 11): a duplicate email, a bad field.
      toast.error(getErrorMessage(error, "Failed to save customer."));
    } finally {
      setIsSaving(false);
    }
  };

  // A switched-off source the customer already has stays on offer for them.
  const offered =
    customer?.referralSource && !sources.some((src) => src.id === customer.referralSource?.id)
      ? [
          ...sources,
          { id: customer.referralSource.id, name: `${customer.referralSource.name} (off)` },
        ]
      : sources;

  const title = customer?.id ? "Edit Customer" : "Create New Customer";

  return (
    <Modal title={title} onClose={onClose} onSave={handleSave} saving={isSaving}>
      <FormSection title="Customer Information">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormInput
            label="First Name"
            name="firstName"
            value={formData.firstName}
            onChange={(value) => setFormData({ ...formData, firstName: value })}
          />
          <FormInput
            label="Last Name"
            name="lastName"
            value={formData.lastName}
            onChange={(value) => setFormData({ ...formData, lastName: value })}
          />
          <FormInput
            label="Email"
            name="email"
            value={formData.email}
            onChange={(value) => setFormData({ ...formData, email: value })}
          />
          <FormInput
            label="Phone"
            name="phone"
            value={formData.phone}
            onChange={(value) => setFormData({ ...formData, phone: value })}
          />
        </div>
      </FormSection>
      <FormSection title="How they found us">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="referral-source" className="mb-1 block text-sm text-brand-gray">
              Heard of us through
            </label>
            <select
              id="referral-source"
              value={sourceId}
              onChange={(e) => {
                setSourceId(e.target.value);
                setTouched((t) => ({ ...t, source: true }));
              }}
              className="w-full rounded-md border border-brand-accent-gray px-3 py-2"
            >
              <option value="">Not recorded</option>
              {offered.map((src) => (
                <option key={src.id} value={src.id}>
                  {src.name}
                </option>
              ))}
            </select>
          </div>
          <div className="relative">
            <label htmlFor="referred-by" className="mb-1 block text-sm text-brand-gray">
              Referred by
            </label>
            {referrer ? (
              <div className="flex items-center gap-2 py-2 text-sm">
                <span>{referrer.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setReferrer(null);
                    setTouched((t) => ({ ...t, referrer: true }));
                  }}
                  className="text-brand-gray underline"
                >
                  Clear
                </button>
              </div>
            ) : (
              <>
                <input
                  id="referred-by"
                  value={search.query}
                  onChange={(e) => search.setQuery(e.target.value)}
                  placeholder="Search customers..."
                  className="w-full rounded-md border border-brand-accent-gray px-3 py-2"
                />
                {search.results.length > 0 && (
                  <ul className="absolute z-10 mt-1 w-full rounded-md border border-brand-gray/30 bg-white shadow">
                    {search.results
                      .filter((r) => r.id !== customer?.id)
                      .map((r) => (
                        <li key={r.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setReferrer({ id: r.id, name: nameOf(r) });
                              setTouched((t) => ({ ...t, referrer: true }));
                              search.clear();
                            }}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-brand-linen"
                          >
                            {nameOf(r)}
                            {r.email && <span className="text-brand-gray"> · {r.email}</span>}
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      </FormSection>
    </Modal>
  );
};

export default CustomerEditModal;
