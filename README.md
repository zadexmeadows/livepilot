# LivePilot — YouTube Live Chat Automation Dashboard

LivePilot is a local-first Next.js application for managing repeated messages on public YouTube livestreams through the normal YouTube website. It does **not** use the YouTube Data API to send messages. A visible Playwright Chromium session performs the same normal chat interaction you can observe in the browser.

The application supports any number of local Google/YouTube accounts. Every account gets a separate persistent Chromium profile, and every automation selects its account independently.

> Use automation responsibly and follow YouTube's Terms of Service and community policies. LivePilot enforces a 30-second minimum interval, honors slow mode and access restrictions, and includes no CAPTCHA solving, stealth, proxy rotation, fingerprint spoofing, or enforcement-bypass features.

Chat discovery waits up to 25 seconds for YouTube's asynchronously loaded input,
including replacement iframes and inline chat. It requires a visible, editable
chat field and stops with a reason when a restriction or timeout prevents posting.
Pause/Stop cancels loading and closes only that worker's page.
Run `npm run test:chat` for the offline chat-readiness regression tests; these use
simulated locators and do not open Google accounts or send live messages.

### Temporary failures and automatic recovery

After Enter, LivePilot waits up to 10 seconds for the composer to clear or a
YouTube rejection notice. A delayed response no longer fails after 900 ms.
An unreadable/disappearing composer is not treated as success. Composer clearing
is a UI acknowledgment, not proof that every viewer received the message.

Temporary loading/network/browser failures and unconfirmed submissions show
**Retrying**, with a warning log and next-attempt time. There are at most five
delayed retries (normally 60, 120, 240, 480, and 900 seconds); a longer configured
interval or YouTube wait is never shortened. A successful send resets the retry
budget. Uncertain delivery is not resent immediately, but website automation
cannot guarantee exactly-once delivery after a network failure.

Six consecutive failed attempts stop with a clear error for manual inspection.
Authentication, CAPTCHA/security checks, explicit posting restrictions and message
policy rejections are not bypassed or blindly retried. Existing message/duration
limits still apply, unless that event uses **No limit — stop manually**. Pause,
Stop and Emergency Stop also cancel recovery. Only that worker's page is closed;
other tabs and accounts are left alone. Run `npm run test:retries` for isolated
controller tests with a manually advanced scheduler and fake browser/database.

## 1. Requirements

Windows 10 or Windows 11 is the primary supported environment.

- Node.js 22.13 or newer
- npm 10 or newer
- About 1 GB of free disk space for dependencies and Playwright Chromium
- A desktop session capable of displaying Chromium windows
- A Google/YouTube account that is allowed to chat on the selected livestream

Check your versions in PowerShell:

```powershell
node --version
npm --version
```

## 2. Installation on Windows

Open PowerShell in this project directory, then install packages:

```powershell
npm install
```

Install the Playwright-managed Chromium browser:

```powershell
npx playwright install chromium
```

Copy the environment example if `.env` is not already present:

```powershell
Copy-Item .env.example .env
```

The defaults bind the dashboard to `127.0.0.1` only and store all data locally.

## 3. Initialize the database

Run the included SQLite migrations:

```powershell
npm run db:generate
npm run db:migrate
```

The database is created at `data/app.db`. To inspect it visually later:

```powershell
npm run db:studio
```

## 4. Start the application

For development:

```powershell
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

For a production build:

```powershell
npm run build
npm run start
```

The server remains local to the computer. Do not change the host to `0.0.0.0` unless you understand the security implications and intentionally add access controls.

## 5. Connect a Google account

1. Open **Google Accounts** in the sidebar.
2. Select **Connect Google Account**.
3. A normal visible Chrome window opens YouTube, without Playwright attached. Click YouTube's **Sign in** button.
4. Complete sign-in manually, including any 2FA or security checks. Then **close that Chrome window**, not just its remote-console tab.
5. Never enter your Google password in the LivePilot dashboard. LivePilot never asks for or stores it.
6. Keep the Google Accounts page or automation form open. After manual Chrome exits, the dashboard uses Playwright to check the saved YouTube session and detect the account name, email when visible, channel name, and avatar. No Google login fields are automated.

Manual sign-in is a browser session, not OAuth API authorization. Google may still
reject a sign-in or later automation; the application cannot guarantee acceptance
and never hides automation or bypasses a restriction. Install Google Chrome for
manual sign-in; set **Browser executable path** to Chrome to use the same browser
for both sign-in and workers. Each account uses an application-owned profile, never
your personal Chrome profile. Close manual Chrome before disconnecting or deleting
that account. Pause workers for that account before reconnecting.

You can also connect an account inside **New Automation**. The current form stays in memory while the browser sign-in happens. When the new account is detected, it is selected automatically without clearing the URL, message, schedule, or limits.

Each account is stored separately:

```text
data/
  browser-profiles/
    account_abc123/
    account_def456/
    account_ghi789/
```

Cookies, local storage, and YouTube sessions are never shared across these folders. Do not copy or publish the profile folders; they contain authenticated browser state.

## 6. Create an automation

Under **Session message limit**, choose **Maximum messages** for a finite session,
or **No limit — stop manually** to remove message-count and duration stops for that
event. This is opt-in per automation; existing limits and defaults are unchanged.
The manual option disables conflicting automatic-stop settings. Save an edited
event, then click Start when ready (editing stops an active worker).
Pause, Stop and Emergency Stop remain available. YouTube restrictions, lost
authentication, errors or application shutdown can still stop an unlimited event;
this option does not restart workers automatically after a server restart.
Intervals and slow-mode protection are unchanged. Run `npm run test:limits` for
offline limit and validation tests.

1. Select **New Automation**.
2. Enter an automation name.
3. Paste one of these URL forms:
   - `https://www.youtube.com/watch?v=VIDEO_ID`
   - `https://www.youtube.com/live/VIDEO_ID`
4. Select the Google account that should post this event's messages, or connect a new account in place.
5. Enter a chat message of up to 200 characters.
6. Set a repeat interval in seconds or minutes. The minimum is 30 seconds.
7. Choose immediate or scheduled start.
8. Optionally stop after a number of messages, minutes, hours, or at a date/time.
9. Set the maximum number of messages for the session.
10. Select **Save Automation** or **Save & Start**.

Changing an existing automation from Account A to Account B stops its current worker and uses Account B's isolated profile on its next run.

## 7. Start, pause, resume, and stop

- **Start** creates one isolated worker for that automation. A duplicate worker for the same automation is rejected.
- **Pause** cancels the worker gracefully and preserves configuration and counters.
- **Resume** creates a new worker with the same saved configuration.
- **Stop** cancels the worker and clears its next-send schedule.
- **Emergency Stop All** gracefully cancels every active worker immediately.

Different accounts can run simultaneously. The browser manager holds one persistent context per Google account and creates separate pages for that account's workers. An automation assigned to Account B cannot accidentally launch in Account A's context.

## 8. Statuses and live updates

The dashboard receives Server-Sent Events and updates without refreshing. Supported statuses are:

- `DRAFT`
- `STARTING`
- `RUNNING`
- `PAUSED`
- `STOPPED`
- `WAITING_FOR_STREAM`
- `RATE_LIMITED`
- `AUTH_REQUIRED`
- `ERROR`
- `COMPLETED`

Activity Logs record the timestamp, automation, stream, status, action, result, and error reason. Filter logs by success, warning, or error.

When YouTube reports slow mode, members-only chat, subscribers-only chat, sign-in requirements, a missing chat input, disabled chat, a stream that has not started, or an ended livestream, LivePilot displays that reason and follows the restriction rather than trying to bypass it.

## 9. Browser profiles and account management

The Account Manager offers:

- Reconnect
- Open Browser Session
- Disconnect the running context
- Delete Profile

Disconnecting closes the live browser context but keeps the profile directory. Reconnecting reuses it. Deleting a profile permanently removes its local browser state and is allowed only after all assigned automations have been moved or deleted.

Closing the LivePilot server closes active workers. On the next start, stale running statuses are safely changed to `STOPPED`; start them again from the dashboard.

## 10. Settings

The Settings page controls:

- Default interval
- Default maximum messages per automation
- Always-visible browser mode
- Start browser minimized
- Optional Chromium/Chrome executable path
- Local data directory for new profiles
- Notification preferences

For the browser executable path, enter a full path such as:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
```

Leave it blank to use Playwright Chromium. Existing account contexts must be closed before browser launch setting changes take effect.

## 11. Validation and test commands

```powershell
npm run typecheck
npm run lint
npm run build
npm run test:integration
npm run test:browser
```

`test:integration` creates temporary database records, verifies create/update/delete behavior, starts a future-scheduled worker, cancels it, and removes the records. It never posts to YouTube.

`test:browser` launches a visible persistent Chromium context using a temporary profile under `work/`, opens a local data page, confirms the profile was written, and closes it. It does not access or modify a Google account.

## 12. Troubleshooting

### Chromium executable is missing

Run:

```powershell
npx playwright install chromium
```

Alternatively, configure a full Chrome or Chromium executable path on the Settings page.

### Google asks for CAPTCHA or extra verification

Complete it manually in the visible browser. LivePilot intentionally does not automate CAPTCHA or bypass Google security protections.

### Account remains in Connecting

Finish the Google flow until the persistent browser is visibly on YouTube. Keep the window open. The automation dialog polls automatically; on the Account Manager, use **Reconnect** to start and monitor a fresh sign-in.

### `AUTH_REQUIRED`

The saved session expired or YouTube signed the profile out. Open **Google Accounts**, select **Reconnect**, complete sign-in in the same visible profile, then resume the automation.

### Chat input is missing

Confirm that the livestream is active, chat is enabled, the selected account can participate, and any subscribers-only or members-only requirement is satisfied. YouTube's website changes over time; all locator fallbacks are centralized in `lib/browser/selectors.ts` for easier maintenance.

### Slow mode or rate limiting

LivePilot waits for at least YouTube's stated restriction period and never retries in a tight loop. Increasing the configured interval is recommended.

### Database migration fails

Make sure no security software is blocking the project directory, then run:

```powershell
npm run db:generate
npm run db:migrate
```

Do not delete `data/app.db` unless you intentionally want to erase all configuration and logs.

### Port 3000 is already in use

Start development on another local port:

```powershell
npm run dev -- --port 3001
```

Then open `http://127.0.0.1:3001`.

## Architecture

```text
app/                     Next.js pages and local API routes
components/              Dashboard, account, automation, log, and UI components
lib/browser/             Persistent contexts, account detection, YouTube chat helpers
lib/automation/          Cancelable isolated automation workers
lib/db/                  Prisma client
lib/logger/              Structured activity logging
prisma/                  SQLite schema and migrations
data/                    Local database and browser profiles (not committed)
scripts/                 Database, integration, and headed-browser verification
```

The automation engine uses abortable delays, one worker per automation ID, try/catch isolation, and one persistent browser context per account ID. All YouTube selector fallbacks live in one file. The dashboard communicates with local server routes only and exposes no Playwright debugging port.
## Streamlabs Mode

On the **Dashboard**, turn **Streamlabs Mode ON** and confirm the displayed sequence. It includes every automation whose account is connected, ordered oldest-created first (also shown in the card). The first automation's account watches **that automation's livestream**. Each participant sends its own configured message to its own configured livestream. Set the same stream on all participants if they are joining the same heist.

- Existing interval workers are paused. Interval, scheduled start, message-count and duration limits are temporarily suspended for this mode; saved settings are not changed.
- The monitor matches the displayed author name `Streamlabs` / `@Streamlabs` and a message mentioning captain/ahoy, crew, treasure hunt, `!heist`, and join. Usernames, whitespace, capitalization and small wording changes may vary. The displayed name is not cryptographic proof of the bot's identity; this is not suitable for financial or security-sensitive actions.
- Existing chat history is baselined and ignored on startup/reconnection. A fresh matching message triggers one round: automation 1 sends as soon as its composer is ready, then there is at least a 10-second delay after each attempt before the next participant. Browser/network delay can make this longer.
- The monitor polls rendered live chat every 750ms. Stable YouTube message IDs are claimed in SQLite before sending, so a rerender/reconnect cannot replay a claimed announcement. Identical text with a new ID is a new announcement. Rows without stable IDs do not trigger sending.
- One round at a time. An announcement arriving during a round is logged and skipped, not queued for a late join. After the last account, the mode waits for a **new** announcement.
- An uncertain send is never resent within that round. Temporary failures impose a cooldown before a later announcement can try again. Five failed recoveries or a genuine rejection/authentication restriction block that automation until the mode is restarted. Other eligible participants continue. If none can send, the mode stops with an error.
- YouTube slow-mode waits still apply. Events sharing one account share its cooldown; a minimum 30-second per-account cooldown prevents duplicate events from generating a rapid loop. Different accounts normally take turns 10 seconds apart.
- **Stop sequence**, **Emergency Stop All**, or Pause/Stop on a participating row cancels the sequence without restarting interval workers. Editing/deleting a participant also stops the entire sequence. Add new automations with Save (not Save & Start), then restart the mode to include them.
- Turning **OFF** cancels the sequence and resumes only the interval workers that were running before ON. Previously stopped jobs/drafts are not automatically started in interval mode. Closing the dashboard does not stop the server worker. An app restart stops the mode; it must be enabled again manually.

Check the card for phase, participant order, round, last announcement and next action; detailed events appear in Activity Logs. Run `npm run test:streamlabs` for simulated matching, ordering, cooldown, cancellation and duplicate-announcement regression tests. Tests do not log in to Google or send real messages.
