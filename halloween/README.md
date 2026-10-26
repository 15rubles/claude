# Ghouls Gone Wild: Costume Contest 🎃

A no-download voting app. Guests scan a QR code, type the name of the person with the best costume, and tap Vote.
The TV shows the names live, with a count next to each one.

| Page | Who | What |
|---|---|---|
| `index.html` | Guests (QR code goes here) | Type a name and vote. One vote per phone, which can be changed |
| `host.html` | You | Vote count, links to the TV and poster, clear all votes |
| `screen.html` | TV or laptop | QR code and the names people voted for, most votes first |
| `poster.html` | Printer | QR poster to stick on the wall |

**Try it first:** until Firebase is set up, the app runs in **demo mode**. Votes stay in that one browser,
each tab acts as a different guest, and the host password is `boo`.

## Setup (about 10 minutes)

### 1. Create a free Firebase project
1. Go to <https://console.firebase.google.com>, click **Create a project**, and name it (e.g. `ghouls-gone-wild`). Google Analytics is not needed.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable → Save.**
3. Still in Authentication: **Settings → Authorized domains → Add domain →** `15rubles.github.io`.
4. **Build → Firestore Database → Create database.** Pick a location near you (e.g. `us-west1`) and start in **production mode**.
5. **Firestore → Rules tab:** paste the whole of [`firestore.rules`](firestore.rules). Change `CHANGE-ME-HOST-PASSWORD`
   to your own host password (a phrase is safer than a short code), then click **Publish**.
   Keep the real password out of this repo; it only needs to live in the Firebase console.
6. **Project settings (⚙️) → General → Your apps → Web (`</>`)**. Register an app (no hosting needed) and copy the
   `firebaseConfig` values into [`firebase-config.js`](firebase-config.js). These values are safe to commit.

### 2. Put it online with GitHub Pages
1. Commit and push `firebase-config.js`.
2. On GitHub: **repo Settings → Pages → Build and deployment → Source: Deploy from a branch**. Choose the
   branch `claude/halloween-costume-voting` and folder `/ (root)`, then save.
3. After a minute or two the app is live at **<https://15rubles.github.io/claude/halloween/>**.

### 3. Become the host
Open <https://15rubles.github.io/claude/halloween/host.html> on your phone or laptop and enter your host password.
That device stays signed in as host. You can unlock more than one device.

## On party night
1. Open the TV page, <https://15rubles.github.io/claude/halloween/screen.html>, on a TV or laptop (⛶ for full screen).
   Print the QR poster too (`poster.html`).
2. Guests scan, type a name and tap **Vote**. Names show up on the TV right away.
   The same name typed with different capitals or extra spaces counts as one name.
3. Whoever has the biggest count when you call it wins the gift basket.

## Notes
- "One vote per phone" uses Firebase anonymous sign-in. Someone could vote again from a private tab, which is fine for a house party.
- Guests can change their vote any time. The TV updates to match.
- **Clear all votes** on the host page wipes everything, e.g. after a test run.
