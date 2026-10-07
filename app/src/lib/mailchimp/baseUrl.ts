// /app/src/lib/mailchimp/baseUrl.ts
//
// Mailchimp encodes its datacenter in the API-key suffix (e.g. <key>-us21) and the
// REST host is https://<dc>.api.mailchimp.com. Because the dc is interpolated into
// a request URL, validate it against the known shape first: a malformed suffix
// (e.g. "evil.example.com/") would otherwise repoint every call at an arbitrary
// host (SSRF). The credential is admin-set, so this is defense in depth, but cheap.
// Returns null when the key is missing or the datacenter is malformed.

const DATACENTER_RE = /^[a-z]{2,4}\d{1,3}$/;

export function mailchimpDatacenter(apiKey: string | undefined | null): string | null {
  const dc = apiKey?.split("-")[1];
  if (!dc || !DATACENTER_RE.test(dc)) return null;
  return dc;
}

export function mailchimpBaseUrl(datacenter: string): string {
  return `https://${datacenter}.api.mailchimp.com/3.0`;
}
