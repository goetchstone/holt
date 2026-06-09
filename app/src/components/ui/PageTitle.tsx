// /app/src/components/ui/PageTitle.tsx

import clsx from "clsx";

interface PageTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function PageTitle({ children, className }: PageTitleProps) {
  return <h1 className={clsx("text-2xl font-semibold text-sh-blue", className)}>{children}</h1>;
}
