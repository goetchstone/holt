// /app/src/components/modals/CustomerEditModal.tsx

import { useState, useEffect } from "react";
import axios from "axios";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import FormSection from "@/components/form/FormSection";
import { Customer, CustomerAddress } from "@prisma/client";
import { toast } from "react-toastify";

interface CustomerEditModalProps {
  item: Customer | null;
  onClose: () => void;
}

const CustomerEditModal = ({ item: customer, onClose }: CustomerEditModalProps) => {
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [isSaving, setIsSaving] = useState(false);

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
    try {
      if (customer?.id) {
        await axios.put(`/api/customers/${customer.id}`, formData);
        toast.success("Customer updated successfully.");
      } else {
        await axios.post("/api/customers", formData);
        toast.success("Customer created successfully.");
      }
      onClose();
    } catch (error) {
      toast.error("Failed to save customer.");
    } finally {
      setIsSaving(false);
    }
  };

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
    </Modal>
  );
};

export default CustomerEditModal;
