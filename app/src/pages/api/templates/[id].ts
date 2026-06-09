// /app/src/pages/api/templates/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);

  if (req.method === "GET") {
    const template = await prisma.labelTemplate.findUnique({
      where: { id },
      include: { categories: true }, // optional: remove if not needed
    });
    if (!template) return res.status(404).json({ message: "Not found" });
    return res.status(200).json(template);
  }

  if (req.method === "PUT") {
    const { name, context, tagSize, zplTemplate } = req.body;
    const updated = await prisma.labelTemplate.update({
      where: { id },
      data: {
        name,
        context,
        tagSize,
        zplTemplate,
      },
    });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    await prisma.labelTemplate.delete({ where: { id } });
    return res.status(204).end();
  }

  return res.status(405).json({ message: "Method not allowed" });
}
