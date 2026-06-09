// /app/src/components/ui/StepTabs.tsx
//
// Reusable controlled step-tabs component for wizard/step flows.
// Designed for iPad-friendly touch targets (≥48px) and sticky tab bar.
// Used by: PriceConfigurator, Import Wizard, and future admin flows.

import { createContext, useContext, ReactNode } from "react";
import { Check } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────

export interface StepTabDefinition {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shown below the label — e.g. "511-24 Sofa" or "Grade 16 / $2,340" */
  subtitle?: string | null;
  /** Grayed out, not clickable */
  disabled?: boolean;
  /** Shows a green check indicator */
  completed?: boolean;
}

export interface StepTabsProps {
  tabs: StepTabDefinition[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  children: ReactNode;
  /** Optional sticky bottom bar (e.g. Back/Next buttons) */
  bottomBar?: ReactNode;
}

export interface StepTabPanelProps {
  tabId: string;
  children: ReactNode;
}

// ─── Context ──────────────────────────────────────────────────────

const StepTabsContext = createContext<{ activeTab: string }>({ activeTab: "" });

// ─── StepTabPanel ─────────────────────────────────────────────────

export function StepTabPanel({ tabId, children }: StepTabPanelProps) {
  const { activeTab } = useContext(StepTabsContext);
  if (activeTab !== tabId) return null;
  return <div className="flex-1 overflow-y-auto p-4">{children}</div>;
}

// ─── StepTabs ─────────────────────────────────────────────────────

export default function StepTabs({
  tabs,
  activeTab,
  onTabChange,
  children,
  bottomBar,
}: StepTabsProps) {
  return (
    <StepTabsContext.Provider value={{ activeTab }}>
      <div className="flex flex-col h-full">
        {/* Tab bar */}
        <div role="tablist" className="flex border-b border-sh-gray/20 bg-white sticky top-0 z-10">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            const isDisabled = tab.disabled ?? false;
            const isCompleted = tab.completed ?? false;

            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                aria-disabled={isDisabled}
                disabled={isDisabled}
                onClick={() => !isDisabled && onTabChange(tab.id)}
                className={`
                  relative flex-1 flex flex-col items-center justify-center
                  min-h-[48px] px-3 py-2.5
                  text-center transition-all
                  ${
                    isDisabled
                      ? "opacity-40 cursor-not-allowed"
                      : "cursor-pointer hover:bg-sh-linen/50"
                  }
                  ${
                    isActive ? "border-b-[3px] border-sh-blue" : "border-b-[3px] border-transparent"
                  }
                `}
              >
                {/* Icon + completion dot row */}
                <div className="flex items-center gap-1.5">
                  {tab.icon && (
                    <span className={isActive ? "text-sh-blue" : "text-sh-gray"}>{tab.icon}</span>
                  )}
                  <span
                    className={`text-sm font-semibold ${
                      isActive ? "text-sh-blue" : "text-sh-gray"
                    }`}
                  >
                    {tab.label}
                  </span>
                  {isCompleted && !isActive && (
                    <span className="w-4 h-4 rounded-full bg-green-500 text-white flex items-center justify-center flex-shrink-0">
                      <Check className="w-2.5 h-2.5" />
                    </span>
                  )}
                </div>

                {/* Subtitle */}
                {tab.subtitle && (
                  <span className="text-[11px] text-sh-gray truncate max-w-full mt-0.5 leading-tight">
                    {tab.subtitle}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Active panel content */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>

        {/* Optional bottom bar */}
        {bottomBar && (
          <div className="sticky bottom-0 bg-white border-t border-sh-gray/20 px-4 py-3">
            {bottomBar}
          </div>
        )}
      </div>
    </StepTabsContext.Provider>
  );
}
