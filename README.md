# Track Everything

A family operations hub for tracking steps, tasks, expenses, savings goals, and other shared household information through controlled programmatic interfaces.

## Step tracking MVP

The first module provides:

- a responsive GitHub Pages family step dashboard;
- a private Google Sheet used as the initial datastore;
- a Google Apps Script API for controlled reads and writes;
- separate per-member write tokens;
- dashboard read-key validation;
- append-only, idempotent step events;
- daily goals and a seven-day family trend;
- an integration contract for Apple Health/HealthKit and Android Health Connect companion apps.

## Repository structure

```text
.
├── index.html                 # GitHub Pages dashboard
├── config.js                  # public dashboard endpoint configuration
├── assets/
│   ├── app.js                 # API client and dashboard rendering
│   └── styles.css             # responsive UI
├── apps-script/
│   ├── Code.gs                # controlled Google Sheet API
│   └── appsscript.json        # Apps Script manifest
└── docs/
    └── step-tracking-setup.md # deployment and device integration guide
```

## Run locally

Because this is a static site, any local web server works:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`. Until `config.js` contains a deployed Apps Script URL, the dashboard intentionally displays demo data.

## Deploy

1. Follow [the step tracking setup guide](docs/step-tracking-setup.md).
2. Configure the Apps Script deployment URL, family ID, and read key in `config.js`.
3. Enable GitHub Pages for the repository's main branch after this work is merged.

## Security boundary

The Google Sheet remains private and is never accessed directly from family devices or GitHub Pages. Devices write through member-scoped tokens. The static dashboard can only use a low-privilege read key, so sensitive future modules such as expenses should use authenticated users and a server-side backend rather than exposing secrets in GitHub Pages.

## Planned modules

1. Step tracking and device synchronization
2. Family tasks and reminders
3. Expense capture and monthly summaries
4. College savings goals and contribution tracking
5. Documents, renewals, and important family dates
