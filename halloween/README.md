# Ghouls Gone Wild: Costume Contest 🎃

A no-download voting app. Guests scan a QR code, add a photo of their costume and vote for their favorite.
The host opens and closes voting and reveals the winner on a big screen.

| Page | Who | What |
|---|---|---|
| `index.html` | Guests (QR code goes here) | Enter your costume, see the lineup, vote (one per phone, not for yourself) |
| `host.html` | You | Open/close voting, reveal the winner, remove entries, live tally |
| `screen.html` | TV or laptop | QR code, live photo wall, 3-2-1 winner reveal with confetti |
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
1. Open **big screen** from the host page on a TV or laptop (⛶ for full screen). Print the **QR poster** too.
2. **Entries open:** guests scan, snap a photo and join the lineup.
3. **Open voting:** each phone gets one vote and can change it. Late arrivals can still enter.
4. **Close voting**, gather everyone around the TV, then **🏆 Reveal the winner**. The TV counts down 3-2-1,
   and every guest's phone shows the winner too.

## Notes
- "One vote per phone" uses Firebase anonymous sign-in. Someone could cheat by voting again in a private tab, which is fine for a house party.
- Guests can't see vote counts until you reveal. The host page hides them too unless you tick **Show vote counts**.
- Photos are shrunk on the phone (~50–150 KB) and stored in Firestore, so you don't need Firebase Storage or a paid plan.
- **Reset the whole contest** (host page → Danger zone) clears every entry and vote, e.g. after a test run.
