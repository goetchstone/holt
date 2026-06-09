// /app/src/components/modals/VendorEditModal.tsx

import { useState } from "react";
import { toast } from "react-toastify";
import FormInput from "@/components/form/FormInput";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface VendorContact {
  id?: number;
  name: string;
  phone: string;
  email: string;
  role: string;
}

interface VendorRecord {
  id: number;
  name?: string;
  phone?: string;
  email?: string;
  city?: string;
  state?: string;
  contacts?: VendorContact[];
}

interface VendorEditModalProps {
  vendor: VendorRecord;
  onClose: () => void;
  onSave: () => void;
}

export default function VendorEditModal({ vendor, onClose, onSave }: VendorEditModalProps) {
  const [name, setName] = useState<string>(vendor?.name || "");
  const [phone, setPhone] = useState<string>(vendor?.phone || "");
  const [email, setEmail] = useState<string>(vendor?.email || "");
  const [city, setCity] = useState<string>(vendor?.city || "");
  const [stateValue, setStateValue] = useState<string>(vendor?.state || "");

  const [contacts, setContacts] = useState<VendorContact[]>(vendor?.contacts || []);

  const handleAddContact = () => {
    setContacts([...contacts, { name: "", phone: "", email: "", role: "" }]);
  };

  const handleRemoveContact = (index: number) => {
    const updatedContacts = [...contacts];
    updatedContacts.splice(index, 1);
    setContacts(updatedContacts);
  };

  const handleContactChange = (index: number, field: keyof VendorContact, value: string) => {
    const updatedContacts = [...contacts];
    updatedContacts[index] = { ...updatedContacts[index], [field]: value };
    setContacts(updatedContacts);
  };

  const handleSubmit = async () => {
    try {
      const res = await fetch(`/api/vendors/${vendor.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone,
          email,
          city,
          state: stateValue,
          contacts,
        }),
      });

      if (res.ok) {
        onSave();
      } else {
        toast.error("Failed to update vendor.");
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to update vendor."));
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-3xl shadow-xl font-serif">
        <h2 className="text-xl font-semibold text-sh-blue mb-4">Edit Vendor</h2>

        {/* Vendor Fields */}
        <div className="space-y-4 mb-6">
          <FormInput label="Vendor Name" name="name" value={name} onChange={setName} />
          <FormInput label="Phone" name="phone" value={phone} onChange={setPhone} />
          <FormInput label="Email" name="email" value={email} onChange={setEmail} />
          <FormInput label="City" name="city" value={city} onChange={setCity} />
          <FormInput label="State" name="state" value={stateValue} onChange={setStateValue} />
        </div>

        {/* Vendor Contacts */}
        <h3 className="text-lg font-serif text-sh-blue mb-2">Contacts</h3>
        <div className="space-y-4 mb-6">
          {contacts.map((contact, index) => (
            <div key={index} className="border border-sh-gray p-4 rounded space-y-2">
              <FormInput
                label="Contact Name"
                name={`contact-name-${index}`}
                value={contact.name}
                onChange={(value) => handleContactChange(index, "name", value)}
              />
              <FormInput
                label="Phone"
                name={`contact-phone-${index}`}
                value={contact.phone}
                onChange={(value) => handleContactChange(index, "phone", value)}
              />
              <FormInput
                label="Email"
                name={`contact-email-${index}`}
                value={contact.email}
                onChange={(value) => handleContactChange(index, "email", value)}
              />
              <FormInput
                label="Role"
                name={`contact-role-${index}`}
                value={contact.role}
                onChange={(value) => handleContactChange(index, "role", value)}
              />

              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => handleRemoveContact(index)}>
                  Remove Contact
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="mb-6">
          <Button variant="secondary" onClick={handleAddContact}>
            + Add Contact
          </Button>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end space-x-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
