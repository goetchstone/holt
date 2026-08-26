# Delivery integrations — our trucks, and other people's

**Status: proposal.** Nothing is built. Written so the shape is decided before a
provider is, because the provider is the part most likely to change.

Two integrations that answer the same question — *where is this delivery and
when does it land* — for the two ways a delivery actually happens:

1. **Our own truck**, tracked by GPS telematics.
2. **Somebody else's truck**, via a third-party logistics carrier.

They share a conclusion, and it is the important part: **both end in the same
event.** When the goods reach the customer, `markHandedOver()` runs, the invoice
is generated, and the sale is recognised. Whether that fact arrived from a
geofence or a carrier's status callback changes nothing downstream. The seam is
already built (`lib/fulfilment/handover.ts`); these are two more ways to feed
it.

## What this is for, and what it is not

The goal is **knowing where a delivery is**, so the business can tell a customer
and so dispatch can react before a customer calls. Everything below serves that.

Deliberately **not** in scope:

- **Video.** Not wanted. If the right people are driving, the camera is
  answering a question nobody asked.
- **Driver scorecards** — harsh braking, speeding leaderboards, idle-time
  league tables. These are the default reason telematics gets bought and the
  reason drivers resent it. They also measure the wrong thing: a driver who
  brakes hard once to avoid a cyclist scores worse than one who is simply slow.
- **Anything that only a manager sees.** If a metric cannot be turned into
  either a customer message or a scheduling decision, it is surveillance with a
  dashboard.

The test for any feature here: *does it change what somebody does?* An ETA text
does. A monthly braking score does not.

---

## What holt already has, and the three gaps

| Have | Model |
| --- | --- |
| Trucks | `Vehicle` — name, type, plate, capacity |
| Runs | `DeliveryRun` — vehicle, driver, status, `departedAt`, `completedAt` |
| Stops in order | `DeliveryStop` — `stopOrder`, `estimatedArrival`, `actualArrival` |
| The address | `ServiceAppointment.address` → `CustomerAddress` |
| Zones and fees | `DeliveryZone` — `baseFee`, `perPieceFee`, zip coverage |
| Encrypted provider secrets | `IntegrationCredential` — per org, per provider, per field |

Three things are missing, and the second is the one that blocks everything else:

1. **`Vehicle` has no device identity.** Nothing links a truck to a tracker.
2. **`CustomerAddress` has no latitude or longitude.** No coordinates means no
   geofence, no arrival detection, no distance, no route sequencing. Geocoding
   is a prerequisite, not a nice-to-have — and it is independently useful
   (better zone assignment than zip matching, and a map view of tomorrow's run).
3. **`actualArrival` exists and nothing sets it.** The field is already there,
   waiting for something to know.

---

## The seam

Modelled on `lib/payments/` — a flat catalog and a switch, one active provider
per deployment, capabilities declared because providers genuinely differ. Same
reasoning as CLAUDE.md 61-63: the provider is a deployment fact, and config
selects behaviour rather than supplying it.

```ts
export type TelematicsProviderId = "samsara" | "motive" | "geotab" | "surecam";

export interface TelematicsCapabilities {
  /** Current position on demand. Every provider has this. */
  livePosition: boolean;
  /** Position history over a window -- needed for cost-per-delivery. */
  historicalTrace: boolean;
  /** Provider-side geofences that fire events. Where absent, holt computes
   *  arrival itself from position + stop coordinates. */
  geofenceEvents: boolean;
  /** Push instead of poll. Lower latency, more setup. */
  webhooks: boolean;
  /** Odometer readings, for true miles per delivery rather than
   *  point-to-point distance. */
  odometer: boolean;
}

export interface TelematicsProvider {
  id: TelematicsProviderId;
  capabilities: TelematicsCapabilities;
  listVehicles(): Promise<TelematicsVehicle[]>;
  getPositions(deviceIds: string[]): Promise<VehiclePositionReading[]>;
  getTrace(deviceId: string, from: Date, to: Date): Promise<VehiclePositionReading[]>;
}
```

**Poll first, webhooks later.** Polling works with every provider and needs no
inbound endpoint or signature verification. holt already runs scheduled
automations; a 60-second poll during active runs is plenty for delivery ETAs and
costs almost nothing. Webhooks become an optimisation once a provider is chosen,
not a dependency.

### New models

```prisma
model Vehicle {
  // ...existing
  telematicsProvider String?   // TelematicsProviderId
  telematicsDeviceId String?   // the provider's own id for this truck
  @@unique([telematicsProvider, telematicsDeviceId])
}

model VehiclePosition {
  id          Int      @id @default(autoincrement())
  vehicleId   Int
  recordedAt  DateTime            // provider's timestamp, not ours
  latitude    Decimal  @db.Decimal(9, 6)
  longitude   Decimal  @db.Decimal(9, 6)
  speedMph    Decimal? @db.Decimal(5, 1)
  headingDeg  Int?
  odometerMi  Decimal? @db.Decimal(10, 1)
  source      String              // which provider produced it
  @@index([vehicleId, recordedAt])
}

model CustomerAddress {
  // ...existing
  latitude   Decimal?  @db.Decimal(9, 6)
  longitude  Decimal?  @db.Decimal(9, 6)
  geocodedAt DateTime?
}

model DeliveryStop {
  // ...existing
  /** When the truck was first seen inside the stop's geofence. Kept SEPARATE
   *  from actualArrival, which is what the driver confirmed. They disagree
   *  more often than you would think -- parking, a wrong pin, a long
   *  driveway -- and the difference is worth being able to see rather than
   *  silently overwriting. */
  arrivalDetectedAt DateTime?
}
```

Six decimal places is roughly 0.1 m, well past what any vehicle GPS resolves,
and it costs nothing to keep.

---

## What it enables, in the order worth building

### 1. Tell the customer — the whole reason to do this

A furniture delivery that fails because nobody is home costs a **whole truck
slot**, twice: the wasted stop and the redelivery. It is the single most
expensive routine failure in the operation, and an ETA message is the cheapest
thing that reduces it.

- "You are stop 4 of 9, roughly 90 minutes away."
- An automatic message at a configurable distance or time out.
- Live position on the client portal for the last leg only, which is the part
  a customer actually wants and the least sensitive to share.

`ServiceAppointment` and the client portal already exist; this needs the ETA and
a message template, both of which are now seeded.

### 2. Let dispatch answer the phone

When a customer calls, dispatch should not be calling the driver to find out.
Where the truck is, which stop it is on, and whether the run is running late
against `estimatedArrival`.

The useful alert is **"this run is 45 minutes behind and has 4 stops left"** —
sent to dispatch, so somebody can ring ahead. Not sent to the driver, who is
driving and already knows.

### 3. Stop making the driver do admin

Auto-stamp `arrivalDetectedAt` on geofence entry. The driver still confirms the
delivery — signature and photo are evidence and stay manual — but nobody should
be tapping "arrived" while parking a box truck.

This also makes the timing data honest. Hand-entered arrival times cluster on
the quarter-hour because people round.

### 4. Find out what a delivery actually costs

The one most businesses never learn, and holt is unusually placed to answer it
because it already holds the fee side.

With a trace: real miles and real minutes per stop. Against `DeliveryZone`'s
`baseFee` and `perPieceFee`: **is each zone priced above what it costs to
serve?** Almost every furniture retailer has one zone quietly losing money and
one subsidising it, and nobody can prove which.

Also falls out: whether the delivery windows quoted to customers match reality,
per zone. If the 12-4 window in one zone is met 60% of the time, that is a
scheduling problem with a number attached.

### 5. Sequence the next stop sensibly

Only after the above. Re-ordering remaining stops by live traffic is genuinely
useful and genuinely easy to get wrong -- a driver who knows the area will beat
a naive optimiser, and overriding them is the micromanagement this is supposed
to avoid. Treat it as a **suggestion the driver can dismiss**, and measure
whether they take it before making it louder.

---

## Providers to evaluate

Not a recommendation — a shortlist, with what to check. SureCam is what Saybrook
runs today and is video-first, so the question there is whether its GPS side is
exposed well enough to be the only integration.

| Provider | Why it is on the list | What to verify |
| --- | --- | --- |
| **Samsara** | Large, modern REST API, strong docs, common in small fleets | Rate limits; per-vehicle pricing at 2-4 trucks |
| **Motive** | Similar profile, competitive on price | API access on the entry tier |
| **Geotab** | Very large partner ecosystem, deep API, device-based | SDK shape is its own thing; more integration work |
| **Azuga** | Aimed at small fleets | API completeness — thinner than the above |
| **Verizon Connect** | Enterprise incumbent | Contract length and whether the API costs extra |
| **SureCam** | Already in use at Saybrook | Whether GPS is available without buying the video product |

**The thing to check first, for any of them: is API access included, or an
upsell?** Several fleet products price the API separately, and that single fact
decides the shortlist faster than feature comparison.

Because the seam declares capabilities, a provider missing geofence events is
not disqualified — holt computes arrival from position and stop coordinates
instead. That is the point of declaring capabilities rather than assuming them.

---

---

# Part two: third-party carriers

Most furniture retailers hand some deliveries to an outside carrier — long-haul,
overflow at the weekend, or everything, for a shop with no truck at all. The
customer's experience should not change based on whose van it is.

## What holt has, and the one structural blocker

`DeliveryZone` already carries `isThirdParty` and `carrierName`. They are
**display-only** — set on the zones admin screen, read nowhere in fulfilment.
The shipped demo has a "Long Haul (carrier)" zone that looks like an integration
and is a label.

The blocker is structural: **`DeliveryStop.deliveryRunId` is non-null**. A stop
requires a run, a run requires a `Vehicle`, and a carrier delivery has neither.
So a third-party delivery cannot currently be a stop at all — it is invisible to
the dispatch board, the planner, and every metric that reads them.

Two ways out:

- **(a) Make `deliveryRunId` nullable** and add `carrierId` / `carrierReference`
  to the stop. A stop belongs to a run *or* to a carrier.
- **(b) Give each carrier a synthetic `Vehicle`** so nothing else changes.

**Recommend (a).** (b) is tempting because it is smaller, and it lies: a carrier
is not a truck, it has no capacity to plan against, and every report that counts
vehicles starts counting carriers. The nullable FK is honest and the change is
contained — `DeliveryStop` is read in few places, and they all already handle a
stop having no completion.

## What a carrier integration has to do

| Step | What moves | Notes |
| --- | --- | --- |
| **Tender** | address, pieces, cube/weight, service level, requested window | The carrier decides the date; holt should not pretend to schedule it |
| **Confirm** | carrier reference, scheduled date/window | Store the reference — it is what a customer service call is about |
| **Status** | scheduled → out for delivery → delivered / attempted / refused | The status feed is the whole value |
| **Proof** | signature, photo, recipient | Comes from *their* app; holt stores the link or the image |
| **Charge** | what the carrier billed | Feeds the same cost-per-delivery question as Part one |
| **Exception** | damage, refusal, reschedule | Should raise a `ServiceCase`, which already exists |

The seam mirrors the telematics one: a `CarrierProviderId` union, declared
capabilities (not every carrier exposes tendering by API — some are a portal and
a CSV), and one active carrier per zone rather than per deployment, because a
shop can reasonably use two.

```ts
export interface CarrierCapabilities {
  tender: boolean;        // can we book by API, or is it a portal?
  statusPolling: boolean;
  statusWebhook: boolean;
  proofOfDelivery: boolean;
  rateQuote: boolean;     // rare, and the basis of automatic zone pricing
}
```

**Grasshopper / Deliverite** is the named starting point — it is furniture and
appliance final-mile software, which is exactly the shape holt needs, and worth
evaluating first for that reason. The same questions apply as in Part one, and
one more: *does the carrier expose an API at all, or is the real integration a
scheduled file exchange?* For final-mile logistics the answer is often the
latter, and a CSV or EDI drop on a schedule is a perfectly respectable
integration — holt already has a configurable import engine and a source-adapter
seam built for exactly that shape.

## Where it lands

A carrier status of `delivered` calls `markHandedOver()` with
`method: "DELIVERY"` and the carrier's completion timestamp. From there it is
indistinguishable from our own driver completing a stop: inventory is consumed,
the invoice is generated, the deposit is relieved and the sale is recognised.

That is the argument for doing this properly rather than tracking carrier
deliveries in a spreadsheet — the accounting consequence is already wired, and a
delivery nobody records is revenue nobody recognises.

---

## Two things to decide deliberately (our own fleet)

Both concern tracking *our employees*. A carrier's own drivers are their
business, and holt only ever sees a status and a proof-of-delivery.

**Retention.** A position trace is employee location data. Keep raw positions
for a short window — 90 days is generous for answering "what happened on that
delivery" — and aggregate beyond it into the per-stop metrics, which is what the
costing actually needs. Indefinite raw traces are a liability with no
operational upside.

**Notice.** Employee vehicle tracking is regulated, and the rules vary by state;
several require notice, and some require consent. This is not a blocker and it
is not something to discover after installing devices. Worth a written policy
and a line in the handbook before the first tracker goes in, which also happens
to be the thing that makes drivers fine with it: tracking the *van* for the
*customer's* benefit is an easy sell, tracking the *person* is not.

Building only the features above keeps that sentence true.
