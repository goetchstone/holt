// /app/src/app/manifest.ts
//
// Lets a handheld add the scanner to its home screen and open it full screen
// (ledger plan phase 15; node_modules/next/dist/docs/01-app/02-guides/
// progressive-web-apps.md). Online only: no service worker, so nothing is
// cached and every scan reaches the server, which makes a retried scan safe
// with its action key instead (lib/inventory/withAction.ts). An offline
// outbox is tracked in docs/domains/inventory.md.

import type { MetadataRoute } from "next";
import { PRODUCT } from "@/lib/branding";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${PRODUCT.name} Scanner`,
    short_name: "Scanner",
    description: "Receive, move, pick, count and look up stock.",
    start_url: "/app/scan",
    scope: "/app/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f5f1",
    theme_color: "#00263e",
    icons: [{ src: "/scanner-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
