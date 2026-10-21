// /app/src/lib/fulfilment/runs.ts
//
// Moving a delivery run along (PUT /api/dispatch/runs/[id]/status).
//
// A run is COMPLETED only when every stop on it is. A stop that could not be
// done comes off the run (stops.ts failStop), so nothing legitimate is left
// open at the end of a day: an open stop is a delivery nobody has accounted
// for. The driver screen hides "Complete Run" until every stop is done; this
// is the check, so the desk and any other caller get it too.
//
// The run's truck is a place (truck.ts). Moving the run to LOADED here puts
// what is at the loading bay aboard, as loading it on a handheld does. A run
// is not COMPLETED while anything is still on its truck -- a stop that could
// not be done leaves its units aboard -- and completing it retires the truck
// places.
//
// The transitions are this route's own and stricter than deliveryService.ts
// VALID_RUN_TRANSITIONS, which also allows PLANNING -> COMPLETED. Whether a run
// can be closed without being loaded is an open owner decision (ROADMAP,
// "Decisions only you can make" #4); until it is made, the route keeps refusing
// it, and the two tables merge once it is.

import type { DeliveryRunStatus, Prisma } from "@prisma/client";
import { aboard, boardRun, describeAboard, retireTruckPlaces } from "./truck";

type Tx = Prisma.TransactionClient;

export class RunError extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 404 = 400,
  ) {
    super(message);
  }
}

const RUN_STATUS_TRANSITIONS: Record<DeliveryRunStatus, DeliveryRunStatus[]> = {
  PLANNING: ["LOADED"],
  LOADED: ["IN_PROGRESS"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
};

const RUN_STATUSES = Object.keys(RUN_STATUS_TRANSITIONS) as DeliveryRunStatus[];

export function isRunStatus(value: unknown): value is DeliveryRunStatus {
  return typeof value === "string" && (RUN_STATUSES as string[]).includes(value);
}

export async function setRunStatus(
  tx: Tx,
  runId: number,
  status: DeliveryRunStatus,
  actor: string | null,
) {
  const run = await tx.deliveryRun.findUnique({
    where: { id: runId },
    select: { status: true, runNumber: true },
  });
  if (!run) throw new RunError("Delivery run not found.", 404);

  if (!RUN_STATUS_TRANSITIONS[run.status].includes(status)) {
    throw new RunError(`Cannot move run ${run.runNumber} from ${run.status} to ${status}.`);
  }

  if (status === "COMPLETED") {
    const open = await tx.deliveryStop.count({
      where: { deliveryRunId: runId, status: { not: "COMPLETED" } },
    });
    if (open > 0) {
      throw new RunError(
        `Run ${run.runNumber} has ${open} stop${open === 1 ? "" : "s"} still open. ` +
          `Complete each one, or mark it couldn't deliver, before completing the run.`,
      );
    }
    const onTruck = await aboard(tx, runId);
    if (onTruck.length > 0) {
      throw new RunError(
        `Run ${run.runNumber} still has ${describeAboard(onTruck)} on the truck. ` +
          `Unload it at a loading bay (Scan > Pick and load) before completing the run.`,
      );
    }
  }

  // Claimed from the status just read, so two callers racing cannot both move
  // it (and both stamp departedAt or completedAt).
  const now = new Date();
  const claimed = await tx.deliveryRun.updateMany({
    where: { id: runId, status: run.status },
    data: {
      status,
      updatedBy: actor,
      ...(status === "IN_PROGRESS" ? { departedAt: now } : {}),
      ...(status === "COMPLETED" ? { completedAt: now } : {}),
    },
  });
  if (claimed.count === 0) {
    throw new RunError(`Run ${run.runNumber} changed while saving. Reload and try again.`);
  }
  if (status === "LOADED") await boardRun(tx, runId, { actor });
  if (status === "COMPLETED") await retireTruckPlaces(tx, runId);

  return tx.deliveryRun.findUniqueOrThrow({
    where: { id: runId },
    include: { vehicle: true, driver: true },
  });
}
