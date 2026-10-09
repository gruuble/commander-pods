# Commander Pods 🎲

Random pod generator + round timer for pickup games of Magic: The Gathering Commander. Pure static site — HTML, CSS, vanilla JavaScript. No frameworks, no build step, no network calls.

## What it does

- **Roster** — add players (button or Enter), rename by tapping a name (Enter/blur commits, Escape cancels), remove with × plus a 5-second Undo toast. Empty, >24-character, and duplicate (case-insensitive) names are rejected with an inline error — never `alert()`.
- **Pods** — splits the active roster into as many 4-player pods as the math allows, using 3-player pods only when required (`computePodSizes(n)`, a pure function). 5 players gets an explicit choice: "One pod of 5 (house rules)" or "One pod of 4 + 1 player sits out" (random sitter). Fewer than 3 players disables generation with helper text. Adding/removing players after generating shows an "out of date" banner with a Regenerate shortcut. "Copy pods" puts a plain-text summary on the clipboard.
- **Timer** — 45/60/75/90-minute presets or a custom 1–600 minute input (last duration persists). Drift-free countdown: the absolute end timestamp is stored on Start and remaining time is recomputed from `Date.now()` every 250 ms, so background throttling and device sleep can't skew it. Amber under 5 minutes, red and pulsing under 1 minute (respects `prefers-reduced-motion`). At 00:00: Web-Audio "beep-beep-beep" alarm (synthesized oscillators, ≤60 s), full-screen overlay with Stop alarm, and a flashing tab title. Mute toggle is persisted.
- **Persistence** — a single namespaced, versioned key `commander-pods:v1` holds players, settings, and the last 20 generated rounds. If localStorage is blocked (private mode), the app runs in memory and shows a dismissible "Changes won't be saved" notice. The always-visible header **Reset day** button wipes everything after a two-step inline confirm.
- **Privacy** — single user, single device. No accounts, no backend, no analytics; nothing leaves the browser.

## Run locally

No dependencies, no build step.

- Easiest: double-click `index.html` — the app works from `file://`. (Clipboard may fall back to a legacy copy path when not served over HTTPS.)
- Or serve it: from this folder run `python3 -m http.server 8000` and open <http://localhost:8000>.

## Self-test

Open `index.html?selftest=1` with the devtools console visible. It asserts `computePodSizes` against the full expected table (0–21 players, including the n = 5 special case) and logs a PASS/FAIL table plus a summary line.

## Deploy to GitHub Pages

1. Create a new repository on GitHub (e.g. `commander-pods`).
2. Commit/push `index.html`, `styles.css`, `app.js`, and this `README.md` to the **root of the `main` branch**.
3. In the repo: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, choose branch `main` and folder `/ (root)`, then Save.
4. Wait about a minute — the site is live at `https://<user>.github.io/<repo>/`. All asset paths are relative (`./styles.css`, `./app.js`), so it works unchanged from any subpath.

## Notes

- The current pods and any "sitting out" player are session-only by design (the v1 storage contract stores roster, settings, and history only); a page reload clears the pods view, not your roster.
- Round history is recorded (last 20 rounds) but intentionally has no UI in v1.
- Out of scope for v1: accounts/sync, life totals, deck tracking, "no repeated opponents" balancing.
