// /app/src/components/pipeline/ClientInfoSummary.tsx

import { parseLocalDate } from "@/lib/dateUtils";
import type { ClientProfileView } from "@/lib/clientProfile";

function shortDate(date: string): string {
  return parseLocalDate(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function clientFacts(profile: ClientProfileView): string[] {
  return [
    profile.residenceType === "Secondary/Vacation" ? "Secondary/vacation home" : null,
    profile.budgetRange ? `Budget ${profile.budgetRange}` : null,
    profile.projectTimeline,
    profile.closeLikelihood === null ? null : `Odds ${profile.closeLikelihood}/10`,
    profile.expectedCloseDate ? `Close ${shortDate(profile.expectedCloseDate)}` : null,
    profile.decisionMaker,
  ].filter((fact): fact is string => Boolean(fact));
}

function LabeledText({ label, text }: Readonly<{ label: string; text: string | null }>) {
  if (!text) return null;
  return (
    <p className="text-brand-black whitespace-pre-wrap break-words">
      <span className="font-semibold text-brand-gray">{label}:</span> {text}
    </p>
  );
}

export function ClientInfoSummary({ profile }: Readonly<{ profile: ClientProfileView }>) {
  const facts = clientFacts(profile);
  return (
    <div className="text-xs space-y-1">
      {profile.roomsOfInterest.length > 0 && (
        <p className="text-brand-black">{profile.roomsOfInterest.join(", ")}</p>
      )}
      {facts.length > 0 && <p className="text-brand-gray">{facts.join(" · ")}</p>}
      <LabeledText label="Preferences" text={profile.stylePreferences} />
      <LabeledText label="Homes" text={profile.homes} />
      <LabeledText label="Preferred brands" text={profile.preferredBrands} />
      {profile.nextSteps.length > 0 && (
        <p className="text-brand-gray">
          <span className="font-semibold">Next:</span> {profile.nextSteps.join(", ")}
        </p>
      )}
      {profile.projectDescription && (
        <p className="text-brand-black whitespace-pre-wrap break-words">
          {profile.projectDescription}
        </p>
      )}
      {profile.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {profile.keywords.map((keyword) => (
            <span
              key={keyword}
              className="rounded-full bg-brand-linen px-2 py-0.5 text-[11px] font-medium text-brand-gray"
            >
              {keyword}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
