# Text messages (SMS)

Texts to customers, through a provider set up in Settings (GAP-12). Twilio is the
first and only provider today, behind a seam shaped like the payment one. The owner
asked for texting through a third party rather than anything homegrown. DECISIONS 40.

**Not yet exercised against a real Twilio account.** The tests stand in for Twilio at
`fetch`, answering as its docs say it does, and the webhook signature is checked
against the worked example Twilio publishes. So what Holt sends and how it reads the
answers are tested. Whether a real account accepts them isn't. Do this on the first
real setup, using "Set it up" and "Check it works" below.

## What a store sets

- **Settings › Integrations › Twilio (`lib/integrationCatalog.ts`):** Account SID, Auth
  Token, and a From Number or Messaging Service SID. They're encrypted in
  `IntegrationCredential`, with `TWILIO_*` env vars as the fallback, like SMTP's. The
  Test button proves the credentials by reading the account (`testConnection`), which
  sends nothing and costs nothing.
- **Settings › Customer messages:** how each automatic message goes: email (where every
  message starts), text, both, or whichever the customer prefers. Each has its own text
  wording (640 characters), and its own choice of whether the text carries the order
  link. The link is about 250 characters: the arrival text measured 401 with it, which
  is three billed segments. A message can't be switched on to go by text until the
  provider is set up. Scan rules: `email.md`, "Customer messages".
- **The customer form:** "They agreed to get texts", and how they'd rather hear from
  the store.

## Set it up

1. In Twilio, register the sender. **In the US this isn't optional.** Twilio requires
   every application sending over a 10-digit number to register for A2P 10DLC, and an
   unregistered number's texts are blocked with error 30034. A toll-free number needs
   toll-free verification instead
   ([A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc)).
2. Enter the credentials in Settings › Integrations, and press Test.
3. Point the number's (or Messaging Service's) incoming messages at
   `<NEXTAUTH_URL>/api/sms/twilio/webhook`, by POST. Twilio signs the URL it calls, so
   this must match `NEXTAUTH_URL` exactly. Delivery reports use the same address, and
   Holt asks for them on each send when `NEXTAUTH_URL` is https.

## Check it works

- Tick the agreement on a customer with your own mobile, and use "Text the link" on one
  of their orders: the order page should read "Text delivered".
- Reply STOP: the customer page should say so, and another send should be refused.
- Reply START: it should clear.

## Who gets a text

One function decides, `lib/sms/consent.ts textableNumber` (rule 42). All of these must
hold:

- **A number that can take one.** `lib/sms/phone.ts` reads free-text `Customer.phone`
  into E.164. A number with no country code is read as North American only where the
  store's locale says so (rule 63); anything else must be typed with `+`. A number with
  letters in it, such as an extension, is refused.
- **Their agreement, on record.** `Customer.smsConsentAt` and `smsConsentBy`, ticked on
  the customer form. Ticking again keeps the original who and when. A phone number
  alone isn't consent, so a customer with none on record is never texted.
- **No STOP from that number.** `SmsOptOut` is keyed by the number, not the customer,
  because that's what the provider blocks: it covers everyone sharing the number.

"No automatic messages" (`Customer.autoMessagesOptOut`) stops the automatic messages on
both channels. It doesn't stop a text staff send by hand.

## Opting out

- Twilio handles STOP itself: it blocks the sender and answers the customer. Holt
  records it so its screens and queue agree, and answers with nothing.
- The webhook reads Advanced Opt-Out's `OptOutType` if present, since a store can change
  its keywords there. Otherwise it reads Twilio's default words, in any case, as the
  whole message: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT. START and
  UNSTOP opt back in. YES doesn't, because it doesn't lift the block on a toll-free number
  ([Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out)).
- A send Twilio refuses with error 21610 records the opt-out too (`source: PROVIDER`),
  in case the reply never reached Holt.
- Every text says "Reply STOP to opt out." unless the store's own wording has the word
  STOP (`render.ts renderTextMessage`). It reads the store's wording before anything is
  filled in, so a customer's name can't remove the notice.

## The queue

`SmsQueue` (`lib/sms/queue.ts`) has the same shape, states and retries as `EmailQueue`
(`lib/email/state.ts`), and `POST /api/automations/email-queue` drains both every 5
minutes. What's different:

- **A refusal that can't change fails at once.** A 400 is about the message itself (a
  bad number, a STOP), so it isn't retried. Anything else (a 401 from a rotated token, a
  429, a 5xx, no answer) is tried up to four times.
- **Each send checks for a STOP again**, since one can arrive after queuing.
- **SENT means the provider accepted it, not that it arrived.** A delivery report sets
  `deliveredAt`, or turns the row FAILED with the carrier's code. This is how a store
  finds out its number isn't registered: Twilio accepts the text, then reports 30034.
  With `NEXTAUTH_URL` not https, Holt can't receive reports and doesn't ask for them.
- **With no provider set up, rows stay PENDING** and go once one is.

Admin › Email lists the texts with their status and the provider's error. The order
page says where each one stands, without the provider's words.

## Failure and rotation

- **Twilio is down:** texts stay PENDING and retry on each cron run, up to four tries.
  Nothing else waits on them.
- **Auth token rotated:** enter the new one in Settings › Integrations. Until then, sends
  get a 401 and use up their four tries, and webhooks answer 403, so a STOP sent during
  that gap may not reach Holt. A later send to that number gets error 21610, which
  records it. A text that used up its tries stays FAILED and has to be sent again.
- **Idempotency:** a repeated STOP or START changes nothing. A customer message is
  recorded once per event (`CustomerMessage.dedupeKey`), in one transaction with its
  queue rows. A delivery report only updates the row it names.

## Files

`lib/sms/{types,index,twilio,phone,consent,queue,webhook}.ts`;
`pages/api/sms/twilio/webhook.ts` (public; its signature is the authorization, in the
allow-list in `__tests__/apiRouteAuthorization.test.ts`); `pages/api/portal/text-link.ts`.
Tests: `__tests__/integration/smsProvider.integration.test.ts`,
`__tests__/lib/sms/sms.test.ts`.

## Not built

- **The "we're 30 minutes out" text** needs live vehicle positions (`etaNotifyChannel`,
  `delivery-integrations.md`).
- **A short link.** The order link is a signed token, about 250 characters with its
  address, which adds billed segments. A store can leave it out of each message.
- **Replies other than the keywords** are ignored, so nobody sees a customer's "what
  time?".
- **Asking for consent at the register.** The agreement is ticked on the customer form,
  not during a sale.
