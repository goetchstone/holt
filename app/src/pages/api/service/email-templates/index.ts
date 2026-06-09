// /app/src/pages/api/service/email-templates/index.ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  success,
  created,
  unauthorized,
  forbidden,
  badRequest,
  conflict,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  if (req.method === "GET") {
    try {
      const templates = await prisma.emailTemplate.findMany({
        orderBy: [{ category: "asc" }, { name: "asc" }],
      });
      return success(res, templates);
    } catch (err) {
      return handleError(res, err, "GET /service/email-templates");
    }
  }

  if (req.method === "POST") {
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN") return forbidden(res, "Manager role required");

    const { name, subject, body, category } = req.body;
    if (!name?.trim() || !subject?.trim() || !body?.trim() || !category?.trim()) {
      return badRequest(res, "name, subject, body, and category are required");
    }

    try {
      const template = await prisma.emailTemplate.create({
        data: {
          name: name.trim(),
          subject: subject.trim(),
          body: body.trim(),
          category: category.trim(),
          createdBy: session.user?.email || null,
        },
      });
      return created(res, template);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002")
        return conflict(res, `Template "${name.trim()}" already exists`);
      return handleError(res, err, "POST /service/email-templates");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}
