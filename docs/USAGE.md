# Using Session Manager

The user guide: every panel, setting, and file, from the user's side. For install steps see
the [README](../README.md); for how it works underneath see [ARCHITECTURE.md](ARCHITECTURE.md).

**Contents:** [Settings](#settings) · [Adding accounts](#adding-accounts) · [Reading a card](#reading-a-card) ·
[Switching manually](#switching-manually) · [Auto-swap](#auto-swap) ·
[Live usage from Claude Code](#live-usage-from-claude-code) · [Compact nudge](#compact-nudge) ·
[Claude Code sessions and iMessage alerts](#claude-code-sessions-and-imessage-alerts) · [Codex panel](#codex-panel) · [Menu bar](#menu-bar) · [Settings reference](#settings-reference) ·
[Files](#files)

## Settings

Everything you can change lives in **Settings** (the toolbar button, or ⌘,), which takes over
the whole window: a list of sections on the left (Auto-swap, Swap lines, Claude Code, Session
alerts, General) and the settings on the right. **Done** or Esc goes back to the dashboard,
which only shows status and the few one-click actions (switch, refresh, arm auto-swap).

Switches save the moment you flip them. Typed fields (numbers, the phone number, the menus)
wait for **Save** in the bar that appears at the bottom once something is edited, so a
half-typed value never takes effect; **Revert** throws the edits away. Leaving Settings with
unsaved edits asks whether to save or discard them.

## Adding accounts

**Capture current login.** If Claude Code is signed in, this copies its credential from
the Keychain and its identity from `~/.claude.json`. The captured account becomes the
active one. Capture again any time; an account you already have is updated in place.

**Log in with browser.** Opens claude.ai in your default browser. After you approve, the
browser redirects to `http://localhost:54545/callback`, the app exchanges the code for a
token, looks up the account's email and organisation, and adds it as a standby account.
The page says you can close the tab. Cancel from the app if the browser never comes back;
the flow times out after five minutes.

Sign out of claude.ai in the browser between logins if you want to add a different account.

## Reading a card

Each card shows the account's **headroom**: `100 − used %` of its **binding window**, whose
name and reset countdown sit under the number. The binding window is the 5-hour session, the
window that throttles the session you are working in. A weekly window (all models, or Fable)
takes over only once it is past the warn line *and* closer to its limit than the session is:
that is when the week will run out before the session does. The other gating windows are the
smaller meters beneath. Colours: green at 30+ headroom, orange at 11–29, red at 10 or below
(or at/over that window's swap line).

States a card can be in:

- **Active** — the credential Claude Code is using now.
- **Held out of rotation** — never an auto-swap target; still a manual switch target.
- **Needs login** — the refresh token was rejected. Remove the account and add it again.
- **Fetch error** — the last usage fetch failed; the numbers shown are from the previous
  success and the error is in Activity.

## Limit resets

Anthropic and OpenAI occasionally give subscribers a banked **limit reset** (the Claude Opus 5.5
launch handed one to every Pro and Max plan). Spending one puts the 5-hour and weekly limits back
to full at once; an unused one expires on the date the provider sets.

When an account holds any, a **Limit resets** row appears under its meters, on the hero card,
on standby cards and in the Codex panel, with how many are banked and when the soonest expires.
**Use reset** does not spend anything by itself: it opens a confirmation that names the account,
says which limits go back to full and how many will be left. Press **Use reset** there to spend
it, or **Cancel** (or Esc) to keep it. The card re-fetches right after and Activity logs the reset.

- A reset the provider will not spend right now (a cooldown, a paused grant) shows *Usable in …*
  or *Not usable yet* instead of the button.
- If usage is too low to need a reset, the provider refuses and the reset is kept; the toast
  says so.
- For the active Claude account the app uses Claude Code's current token and never refreshes
  it. If that token has lapsed, send Claude Code a message and try again.

## Switching manually

Click **Switch to this account** on a standby card, or pick the account from the menu bar
menu. The app takes Claude Code's lock files, saves the outgoing credential back into its
slot (so a token Claude Code rotated is not lost), writes the new credential, updates
`oauthAccount` in `~/.claude.json`, and records the switch. Running `claude` sessions use
the new login on their next request.

## Auto-swap

Arm it with the switch in the dashboard's Auto-swap panel or in Settings → Auto-swap; every
other knob below is in Settings. Each poll the policy runs:

1. Accounts that are held or have unknown usage are never targets.
2. The active account is *near limit* when its 5-hour session is at or past **5-hour swap
   at**, or the weekly window that counts is at or past **Weekly swap at**. **Weekly limit**
   picks that window: *All models* (the plain weekly limit; the right choice while you
   mostly run Opus), *Fable only* (the per-model weekly window named by **Gating model
   window**; an account that reports none falls back to the all-models week), or
   *Whichever is tighter* (the default: both count). A window that does not count still
   shows on the card, without a swap line.
3. `best`: stay unless near limit. `consume_first`: prefer the account whose weekly window
   resets soonest, if its weekly headroom beats the active account's by ≥ **margin** and it
   is under every line.
4. Near limit: switch to the account with the most headroom on the axis that hit (session
   headroom for the session, weekly headroom for a weekly window) that is under every line
   itself and beats the active account by ≥ margin on that axis. None → *blocked*.
5. No automatic switch within **cooldown** seconds of the last one.
6. **Dry run** turns a switch into a logged *stay* prefixed `dry-run:`.

The last decision is shown in the panel and, when it changes, in Activity. A notification
fires on each automatic switch (turn off with *Notifications*).

Poll interval is 5 min by default (minimum 15 s). Anthropic's usage endpoint allows only
about 30 requests per hour per account, shared with Claude Code's own checks, so the active
account is fetched at most every 5 min and standby accounts every 10 min unless one of their
windows is within 10 points of its swap line. Accounts fetched within those gaps are
skipped unless you press Refresh.

## Live usage from Claude Code

Claude Code already knows your 5-hour and weekly usage from every response it gets. Click
**Install** on "Status line feed" in Settings → Claude Code and it hands those
numbers to Session Manager on every assistant message, so the active account updates
live and the app polls Anthropic only for the Fable window (every 30 min, or every 5 once
it is within 10 points of its swap line). Between those
polls the Fable window is projected from the live weekly number, two Fable points per weekly
point, anchored at the last real reading, and shown with a ≈ mark (with **Weekly limit** on
*All models* there is no projection: the Fable window keeps its last real reading). If you already
have a status line, it keeps running underneath ours; Remove restores it. Standby accounts
are still polled, since Claude Code only knows about the account it is logged in with.

After a swap, a Claude Code session still finishing a turn on the previous login keeps
reporting that login's numbers for a moment. Those are recognised by their weekly reset time
and ignored, so the new account is never shown (or swapped) as if it were the old one;
Activity notes it once.

## Compact nudge

A swap in the middle of a long Claude Code conversation makes the next request re-cache the
whole context on the new account (one full uncached read, priced as a cache write). The nudge
gets you to `/compact` first.

1. In Settings → Claude Code, click **Install** on "Compact nudge". This writes
   `~/.claude/hooks/session-manager-nudge.sh` and registers it as a `UserPromptSubmit` hook in
   `~/.claude/settings.json`. Nothing else in that file is touched; **Remove** takes it back out.
2. Set **Warn at (%)**, default 80. When the active account's gating window nearest its swap line reaches it
   (and auto-swap is armed, not in dry run), the hero card shows a "Swap soon" notice and the
   app raises a flag file the hook reads.
3. Pick the **Nudge** behaviour. *Block once* (default): the next message you send in
   Claude Code is stopped once with "run /compact now, then send your message again"; later
   prompts go through, with a short note to Claude. *Context only*: nothing is stopped;
   Claude is told a swap is near and may remind you once.

The flag clears on its own once the account is below the warn line again, or after the swap.
The hook is silent whenever there is no flag. Session Manager only needs to be running; the
hook works in every Claude Code session on the machine.

## Claude Code sessions and iMessage alerts

The dashboard's *Claude Code sessions* panel lists every Claude Code session open on this Mac and what
it is doing: **Working**, **Asking a question** (Claude asked you something, or an MCP server
wants input), **Needs permission** (a permission prompt is up), **Your turn** (it finished
and is waiting for your next message), or **Ready** (opened, no prompt yet). With alerts on,
Session Manager texts your phone through the Messages app on this Mac when one of them is
waiting on you, so you know to come back while you are away. No other software is needed,
and nothing leaves the Mac except that iMessage. Under the list, one line says whether texts
are going out and to where.

1. In Settings → Claude Code, click **Install** on "Session hooks". This writes
   `~/.claude/hooks/session-manager-sessions.sh` and registers it in `~/.claude/settings.json`
   for the events that show where a session is (session start and end, prompts, tool calls,
   permission requests, questions, notifications, and the end of each turn). The hooks run in
   the background, so Claude Code never waits on them. Each writes a tiny file under
   `sessions/` in the data folder with the session id, its folder, and at most the question
   Claude asked; prompts, tool inputs and outputs are never stored. **Remove** takes them out.
   Claude Code reads its hooks when a session starts, so sessions already open show up once
   restarted (or resumed with `claude --resume`).
2. In Settings → Session alerts, enter the phone number or Apple ID email to text under
   **Send texts to** and Save. You can set or change it at any time, hooks or not. Messages
   on this Mac must be signed in to iMessage. Press **Send test**: the first time, macOS asks
   whether Session Manager may control Messages. Allow it (or later in System Settings →
   Privacy & Security → Automation).
3. Turn on **Text me when a session needs me** (it needs both the number and the hooks).

When a session starts waiting on you, a text goes out once it has waited **Text after (min)**
(default 2). With **Only when I'm away** on (the default), it is sent only if the Mac has had
no keyboard or mouse input since the session started waiting, so nothing arrives while you
are at the desk. Several sessions ready at the same moment share one text. Each waiting spell
is texted at most once; the session has to move on and wait again for another. Turning
alerts on (or starting the app) never texts about sessions that were already waiting.

Texting your own number from the same Apple ID: the message lands in the conversation with
yourself. If your phone does not notify you for it, text a different handle of yours (your
email instead of your number, or the reverse), or check that the conversation is not muted.

## Codex panel

Shows the Codex CLI's account when `~/.codex/auth.json` has a ChatGPT login: plan, email,
5-hour and weekly windows. **Refresh** in the panel header re-fetches the Codex quota on the
spot, ignoring the 5-minute hold after a failure, with the time since the last fetch beside
it; the toolbar's **Refresh Claude** leaves Codex alone. After `codex login`, press it to pick
the new login up without waiting for the next poll. The app refreshes the CLI's token when it is within 30 minutes
of expiring and writes it back. In API-key mode the CLI has no quota endpoint, so the
panel only reports that it is configured. Banked Codex limit resets show in the panel and can be
spent from it; see [Limit resets](#limit-resets). Settings → General → *Codex panel* hides it (and stops
polling Codex).

## Menu bar

The menu bar item is the code-bracket mark alone, no text. Click it for a glance menu: each
account with a usage bar per window (5-hour limit, Weekly · all models, Weekly · Fable) and its
reset time,
the Codex account, and one status line (auto-swap state, last poll). The only actions are
**Open Session Manager** and **Quit**; switching and settings live in the window so the menu
can never change anything by accident. Clicking any row opens the window.
*Show in Dock* off hides the Dock icon; the app then lives only in the menu bar. Closing the
window hides it; quit from the menu or ⌘Q.

## Settings reference

All of these are in Settings (⌘,).

| Setting | Range / default | Effect |
| --- | --- | --- |
| Auto-swap | off | Run the policy each poll. |
| Dry run | off | Log decisions without switching. |
| 5-hour swap at | 50–100, 90 | The 5-hour session's swap line. |
| Weekly swap at | 50–100, 90 | The weekly and Fable weekly windows' swap line. |
| Margin | 0–50, 10 | Required headroom advantage of a target, on the axis that hit. |
| Cooldown | ≥ 0, 300 s | Minimum gap between automatic switches. |
| Poll interval | ≥ 15, 300 s | How often the loop runs; each account is fetched at most every 5 min (standby: 10). |
| Strategy | `best` | `best` or `consume_first`. |
| Weekly limit | Whichever is tighter | Which weekly window counts: *All models*, *Fable only* (the per-model window), or both. |
| Model | `Fable` | Display name of the per-model weekly window (**Gating model window**). |
| Codex panel (Hide / Show) | on | Show the Codex panel. |
| Notifications | on | macOS notification on automatic switches. |
| Launch at login | off | Register as a login item. |
| Show in Dock | on | Off = menu-bar only. |
| Warn at | 80 | Raise the compact nudge when the active account's window nearest its swap line reaches this; a weekly window past it can take over the gauge from the session |
| Nudge | Block once | What the Claude Code hook does with the flag |
| Text me when a session needs me | off | Send an iMessage when a Claude Code session waits on you. Needs **Send texts to** and the session hooks. |
| Send texts to | empty | Phone number or Apple ID email to text. |
| Only when I'm away | on | Text only if the Mac has had no input since the session started waiting. |
| Text after (min) | 1–60, 2 | How long a session waits before the text goes out. |

## Files

`~/Library/Application Support/Session Manager/` holds `settings.json`, `accounts.json`
(no secrets), `credentials/` (0600 files), `usage.json`, `state.json`, `events.jsonl`, and
`sessions/` (one small file per Claude Code session and hook event; ended sessions are
removed, idle ones after 12 hours).
Deleting the folder while the app is quit resets it; the app never
touches Claude Code's own login.
