# Getting help with Holt

Holt is an independent open-source project, provided as is (see
[LICENSE](./LICENSE)). Help here is given as time allows, with no guaranteed
response time.

## Where to go

| You have | Go to |
|---|---|
| A question about installing, configuring or using Holt | The [README](./README.md), [OPERATIONS.md](./OPERATIONS.md) and [docs/HOSTING.md](./docs/HOSTING.md) first. In the app, the **?** at the top of a screen opens that screen's help. Still stuck: open a [Question](https://github.com/goetchstone/holt/issues/new?template=question.yml). |
| Something broken | A [Bug report](https://github.com/goetchstone/holt/issues/new?template=bug_report.yml). |
| An import that fails or numbers that do not add up | An [Import or data problem](https://github.com/goetchstone/holt/issues/new?template=data_issue.yml). |
| An idea or a missing feature | A [Feature request](https://github.com/goetchstone/holt/issues/new?template=feature_request.yml). |
| A security vulnerability | **Not a public issue.** Report it privately as [SECURITY.md](./SECURITY.md) describes. |
| A change you want to make yourself | [CONTRIBUTING.md](./CONTRIBUTING.md). |

Search the [existing issues](https://github.com/goetchstone/holt/issues?q=is%3Aissue)
before opening a new one, and add to the one that matches.

## Before you post

The tracker is public. Leave out real customer names and contact details, card
or bank details, passwords and keys, and any vendor file you are not free to
publish. Blur them in screenshots.

## What to include

- The commit or release you run (`git rev-parse --short HEAD`).
- How Holt is run (Docker Compose, or `npm run dev`).
- What you did, what you expected and what happened, with the message the
  screen showed.

## Which versions are supported

The latest `main`. Fixes land there first and are not back-ported.
