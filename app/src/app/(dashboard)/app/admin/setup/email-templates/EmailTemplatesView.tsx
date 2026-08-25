"use client";

// /app/src/app/(dashboard)/app/admin/setup/email-templates/EmailTemplatesView.tsx
//
// Email Templates body. App Router port of the legacy admin/setup/email-templates
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Lists
// templates and edits them via a Modal + the shared
// /api/service/email-templates REST endpoint.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { getErrorMessage } from "@/lib/toastError";

interface EmailTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
  category: string;
  isActive: boolean;
}

interface TemplateForm {
  name: string;
  category: string;
  subject: string;
  body: string;
  isActive: boolean;
}

const CATEGORIES = ["CUSTOMER", "INTERNAL", "VENDOR"];

const CATEGORY_COLORS: Record<string, string> = {
  CUSTOMER: "bg-blue-50 text-blue-700",
  INTERNAL: "bg-brand-gray/10 text-brand-gray",
  VENDOR: "bg-yellow-50 text-yellow-800",
};

const EMPTY_FORM: TemplateForm = {
  name: "",
  category: "CUSTOMER",
  subject: "",
  body: "",
  isActive: true,
};

export function EmailTemplatesView() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ editing: EmailTemplate | null } | null>(null);
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await axios.get("/api/service/email-templates");
      setTemplates(res.data.templates || []);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load templates"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const openModal = (item: EmailTemplate | null) => {
    setForm(
      item
        ? {
            name: item.name,
            category: item.category,
            subject: item.subject,
            body: item.body,
            isActive: item.isActive,
          }
        : EMPTY_FORM,
    );
    setModal({ editing: item });
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.subject.trim()) {
      toast.error("Name and subject are required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category,
        subject: form.subject.trim(),
        body: form.body,
        isActive: form.isActive,
      };
      if (modal?.editing) {
        await axios.put(`/api/service/email-templates/${modal.editing.id}`, payload);
      } else {
        await axios.post("/api/service/email-templates", payload);
      }
      setModal(null);
      toast.success("Template saved");
      fetchTemplates();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save template"));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (template: EmailTemplate) => {
    try {
      await axios.put(`/api/service/email-templates/${template.id}`, {
        isActive: !template.isActive,
      });
      fetchTemplates();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update template"));
    }
  };

  if (loading) {
    return <p className="text-brand-gray py-8">Loading...</p>;
  }

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-brand-blue font-semibold">Email Templates</h1>
        <Button variant="primary" size="sm" onClick={() => openModal(null)}>
          Add Template
        </Button>
      </div>

      <div className="bg-white rounded-lg border border-brand-gray/20 shadow-md overflow-hidden">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-brand-linen text-brand-black">
            <tr>
              <th className="p-3 border-b font-medium">Name</th>
              <th className="p-3 border-b font-medium">Category</th>
              <th className="p-3 border-b font-medium">Subject</th>
              <th className="p-3 border-b font-medium w-24">Active</th>
              <th className="p-3 border-b font-medium w-20" />
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="odd:bg-white even:bg-brand-stripe">
                <td className="p-3 border-b font-medium text-brand-black">{t.name}</td>
                <td className="p-3 border-b">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${CATEGORY_COLORS[t.category] || ""}`}
                  >
                    {t.category}
                  </span>
                </td>
                <td className="p-3 border-b text-brand-gray max-w-xs truncate">{t.subject}</td>
                <td className="p-3 border-b">
                  <button
                    type="button"
                    onClick={() => toggleActive(t)}
                    className={`text-xs px-2 py-1 rounded ${
                      t.isActive
                        ? "bg-green-100 text-green-800"
                        : "bg-brand-gray/10 text-brand-gray"
                    }`}
                  >
                    {t.isActive ? "Active" : "Inactive"}
                  </button>
                </td>
                <td className="p-3 border-b">
                  <button
                    type="button"
                    onClick={() => openModal(t)}
                    className="text-sm text-brand-blue hover:underline"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-brand-gray">
                  No email templates configured
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal.editing ? "Edit Email Template" : "Add Email Template"}
          onClose={() => setModal(null)}
          onSave={handleSave}
          saving={saving}
        >
          <FormInput
            label="Name"
            name="templateName"
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
            required
          />
          <div className="mb-4">
            <label htmlFor="templateCategory" className="block text-brand-blue font-serif mb-1">
              Category
            </label>
            <select
              id="templateCategory"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              className="w-full border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <FormInput
            label="Subject"
            name="templateSubject"
            value={form.subject}
            onChange={(v) => setForm((f) => ({ ...f, subject: v }))}
            required
          />
          <div className="mb-4">
            <label htmlFor="templateBody" className="block text-brand-blue font-serif mb-1">
              Body
            </label>
            <textarea
              id="templateBody"
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              rows={8}
              className="w-full border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
            />
            <p className="text-xs text-brand-gray mt-1">
              {"Mustache variables: {{customerName}}, {{orderno}}, {{caseNumber}}, {{summary}}"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="templateActive"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="templateActive" className="text-sm text-brand-gray">
              Active
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
