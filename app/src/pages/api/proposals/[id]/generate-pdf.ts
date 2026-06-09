// /app/src/pages/api/proposals/[id]/generate-pdf.ts
//
// POST: Generate and return a PDF for the proposal.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { generateProposalPdf } from "@/lib/proposalPdf";
import { getAppSettings } from "@/lib/appSettings";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end();
    }

    const proposalId = Number.parseInt(req.query.id as string, 10);
    if (Number.isNaN(proposalId)) return res.status(400).json({ error: "Invalid proposal ID" });

    try {
      const proposal = await prisma.proposal.findUnique({
        where: { id: proposalId },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              addresses: { take: 1 },
            },
          },
          salesPerson: { select: { displayName: true } },
          lineItems: {
            orderBy: { sortOrder: "asc" },
            include: {
              images: { where: { isPrimary: true }, take: 1 },
            },
          },
        },
      });

      if (!proposal) return res.status(404).json({ error: "Proposal not found" });

      const customerName = proposal.customer
        ? [proposal.customer.firstName, proposal.customer.lastName].filter(Boolean).join(" ")
        : proposal.companyName || "Client";

      const addr = proposal.customer?.addresses?.[0];
      const customerAddress = addr
        ? [addr.address1, addr.city, addr.state, addr.zip].filter(Boolean).join(", ")
        : null;

      const settings = await getAppSettings();
      const pdfBranding = {
        name: settings.companyName ?? settings.appName,
        navy: settings.theme.navy,
        gold: settings.theme.gold,
        gray: settings.theme.gray,
        linen: settings.theme.linen,
      };

      const pdfBuffer = generateProposalPdf(
        {
          proposalNumber: proposal.proposalNumber,
          projectName: proposal.projectName,
          companyName: proposal.companyName,
          customerName,
          customerAddress,
          salesPersonName: proposal.salesPerson?.displayName ?? null,
          coverLetter: proposal.coverLetter,
          terms: proposal.terms,
          lineItems: proposal.lineItems.map((li) => ({
            itemName: li.itemName,
            itemDescription: li.itemDescription,
            vendorName: li.vendorName,
            partNumber: li.partNumber,
            retailPrice: Number(li.retailPrice),
            quantity: li.quantity,
            selectedGrade: li.selectedGrade,
            selectedFinish: li.selectedFinish,
            itemNotes: li.itemNotes,
            showInOutput: li.showInOutput,
            primaryImagePath: li.images[0]?.imageUrl ?? null,
          })),
        },
        pdfBranding,
      );

      const filename = `${proposal.proposalNumber}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", pdfBuffer.length);
      return res.send(pdfBuffer);
    } catch (err: unknown) {
      logError("Failed to generate proposal PDF", err);
      return res.status(500).json({ error: "Failed to generate PDF" });
    }
  },
);
