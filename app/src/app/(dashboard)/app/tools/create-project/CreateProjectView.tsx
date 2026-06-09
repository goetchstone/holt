"use client";

// /app/src/app/(dashboard)/app/tools/create-project/CreateProjectView.tsx
//
// Creates a customer project folder structure in Google Drive. Posts to the
// shared /api/google/create-project REST endpoint. Any signed-in user; the page
// gated server-side. Chrome + toast come from the (dashboard) layout.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { getErrorMessage } from "@/lib/toastError";

export function CreateProjectView() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [lastName, setLastName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const handleCreateProject = async () => {
    if (!lastName.trim()) {
      toast.error("Customer last name is required.");
      return;
    }

    setIsCreating(true);
    try {
      const response = await axios.post("/api/google/create-project", {
        customerLastName: lastName,
      });
      toast.success(response.data.message);
      setIsModalOpen(false);
      setLastName("");
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create project."));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="mx-auto mt-8 max-w-2xl text-center font-serif">
      <h1 className="mb-4 text-2xl font-semibold text-sh-blue">New Customer Project</h1>
      <p className="mb-8 text-sh-gray">
        Click the button below to create a new project folder structure in Google Drive for a new
        customer.
      </p>
      <Button onClick={() => setIsModalOpen(true)} variant="primary">
        Create New Project Folder
      </Button>

      {isModalOpen && (
        <Modal
          title="Create New Project"
          onClose={() => setIsModalOpen(false)}
          onSave={handleCreateProject}
          saving={isCreating}
        >
          <FormInput
            label="Customer Last Name"
            name="lastName"
            value={lastName}
            onChange={setLastName}
            placeholder="e.g., Smith"
            required
          />
        </Modal>
      )}
    </div>
  );
}
