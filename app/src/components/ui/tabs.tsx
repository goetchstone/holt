// /app/src/components/ui/tabs.tsx

import { useState, createContext, useContext, ReactNode, ReactElement } from "react";

interface TabsContextType {
  value: string;
  setValue: (v: string) => void;
}

const TabsContext = createContext<TabsContextType | null>(null);

export function Tabs({
  defaultValue,
  children,
  className = "",
}: {
  defaultValue: string;
  children: ReactNode;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`flex gap-2 mb-4 border-b ${className}`}>{children}</div>;
}

export function TabsTrigger({ children, value }: { children: ReactNode; value: string }) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("TabsTrigger must be used within Tabs");

  const isActive = ctx.value === value;
  const handleClick = () => ctx.setValue(value);

  return (
    <button
      onClick={handleClick}
      className={`px-4 py-2 text-sm font-medium rounded-t border-t border-r border-l ${
        isActive
          ? "bg-sh-linen text-sh-blue border-sh-gray"
          : "bg-white text-sh-black border-transparent"
      }`}
    >
      {children}
    </button>
  );
}

export function TabsContent({ children, tabValue }: { children: ReactNode; tabValue: string }) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("TabsContent must be used within Tabs");
  return ctx.value === tabValue ? (
    <div className="p-4 border rounded-b bg-white">{children}</div>
  ) : null;
}
