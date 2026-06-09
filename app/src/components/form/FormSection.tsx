// /app/src/components/form/FormSection.tsx

import { ReactNode } from "react";

type FormSectionProps = {
  title: string;
  children: ReactNode;
};

export default function FormSection({ title, children }: FormSectionProps) {
  return (
    <div className="mb-6 border-b border-sh-gray pb-4">
      <h2 className="text-sh-blue font-serif text-lg mb-2">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
