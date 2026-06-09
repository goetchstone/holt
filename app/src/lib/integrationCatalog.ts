// /app/src/lib/integrationCatalog.ts
//
// Shared client/server contract (CLAUDE.md rule 7) for the third-party
// integrations a deployment can configure from the database instead of env
// files. Both the Settings UI and the integrations API validate provider +
// field names against this single list, so the editor can never POST a
// field the server will reject.

export interface IntegrationFieldDef {
  key: string;
  label: string;
  placeholder?: string;
}

export interface IntegrationProviderDef {
  id: string;
  name: string;
  description: string;
  fields: IntegrationFieldDef[];
}

export const INTEGRATION_PROVIDERS: IntegrationProviderDef[] = [
  {
    id: "mailchimp",
    name: "Mailchimp",
    description: "Email campaign sync, activity tracking, and lead intake.",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "xxxxxxxx-us21" },
      { key: "serverPrefix", label: "Server Prefix", placeholder: "us21" },
      { key: "audienceId", label: "Audience ID", placeholder: "Optional" },
    ],
  },
  {
    id: "smtp",
    name: "Email (SMTP)",
    description: "Transactional email -- booking confirmations and ticket updates.",
    fields: [
      { key: "host", label: "SMTP Host", placeholder: "smtp.example.com" },
      { key: "port", label: "Port", placeholder: "587" },
      { key: "user", label: "Username", placeholder: "you@yourdomain.com" },
      { key: "pass", label: "Password" },
      { key: "fromAddress", label: "From Address", placeholder: "hello@yourdomain.com" },
      { key: "fromName", label: "From Name", placeholder: "Your Company" },
    ],
  },
  {
    id: "axper",
    name: "Axper Traffic",
    description: "Store foot-traffic counts (entries/exits) for the dashboard.",
    fields: [
      { key: "apiBase", label: "API Base URL", placeholder: "https://api.axper..." },
      { key: "apiKey", label: "API Key" },
    ],
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Card payments for the customer portal and point of sale.",
    fields: [
      { key: "secretKey", label: "Secret Key", placeholder: "sk_live_..." },
      { key: "publishableKey", label: "Publishable Key", placeholder: "pk_live_..." },
      { key: "webhookSecret", label: "Webhook Signing Secret", placeholder: "whsec_..." },
    ],
  },
  {
    id: "google",
    name: "Google OAuth",
    description: "Sign-in and Drive access for staff accounts.",
    fields: [
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client Secret" },
    ],
  },
  {
    id: "gmail",
    name: "Gmail Service Account",
    description: "Automated report ingestion via domain-wide delegation.",
    fields: [
      { key: "serviceAccountJson", label: "Service Account JSON", placeholder: "Paste full JSON" },
      { key: "delegateEmail", label: "Delegate Email" },
    ],
  },
  {
    id: "github",
    name: "GitHub App",
    description: "Posts in-app feedback as GitHub issues.",
    fields: [
      { key: "appId", label: "App ID" },
      { key: "installationId", label: "Installation ID" },
      { key: "privateKey", label: "Private Key (PEM)", placeholder: "-----BEGIN..." },
      { key: "repoOwner", label: "Repo Owner", placeholder: "org-or-user" },
      { key: "repoName", label: "Repo Name", placeholder: "feedback-repo" },
    ],
  },
];

const PROVIDER_FIELDS: Record<string, Set<string>> = Object.fromEntries(
  INTEGRATION_PROVIDERS.map((p) => [p.id, new Set(p.fields.map((f) => f.key))]),
);

export function isValidProviderField(provider: string, field: string): boolean {
  return PROVIDER_FIELDS[provider]?.has(field) ?? false;
}
