// /app/src/pages/api/reports/monthly-percentages.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";

const getMonthOrder = () => {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return months.reduce(
    (acc, month, index) => {
      acc[month] = index;
      return acc;
    },
    {} as Record<string, number>,
  );
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { method, body, query } = req;

  switch (method) {
    case "GET":
      try {
        const year = query.year ? Number(query.year) : new Date().getFullYear();
        const percentages = await prisma.monthlySalesPercentage.findMany({
          where: { year },
        });

        const monthOrder = getMonthOrder();
        percentages.sort((a, b) => monthOrder[a.month] - monthOrder[b.month]);

        res.status(200).json(percentages);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch monthly percentages." });
      }
      break;

    case "PUT":
      try {
        const { id, percentage } = body;
        if (!id || percentage == null) {
          return res.status(400).json({ error: "Missing required fields." });
        }
        const updatedPercentage = await prisma.monthlySalesPercentage.update({
          where: { id: Number(id) },
          data: { percentage: Number.parseFloat(percentage) },
        });
        res.status(200).json(updatedPercentage);
      } catch (error) {
        res.status(500).json({ error: "Failed to update percentage." });
      }
      break;

    default:
      res.setHeader("Allow", ["GET", "PUT"]);
      res.status(405).end(`Method ${method} Not Allowed`);
  }
}
