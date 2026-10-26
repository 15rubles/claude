// Data layer. Two interchangeable backends with the same API:
//  - firebase: shared Firestore database, one anonymous sign-in per phone
//  - demo:     localStorage in this browser, each tab acts as a separate guest
//
// Data model (Firestore):
//  votes/{uid}  { name, at }  one vote per phone: the name the guest typed
//  hosts/{uid}  { pin }       created by entering the host password (checked by the rules)
import { firebaseConfig } from '../firebase-config.js';

const FIREBASE_VERSION = '10.12.2';
export const DEMO_PIN = 'boo';
export const NAME_MAX = 40;

const params = new URLSearchParams(location.search);
// Set by the all-in-one test page, which embeds each "phone" as an inline frame.
const embed = window.GGW_EMBED;
export const firebaseReady = Boolean(firebaseConfig?.apiKey) && !firebaseConfig.apiKey.startsWith('PASTE');
export const isDemo = params.has('demo') || !firebaseReady || Boolean(embed);

export function connect() {
  return isDemo ? demoBackend() : firebaseBackend();
}

function reportError(err) {
  console.error(err);
  dispatchEvent(new CustomEvent('backend-error', { detail: err }));
}

function cleanName(name) {
  name = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!name) throw new Error('Type a name to vote for.');
  return name;
}

async function firebaseBackend() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);

  await auth.authStateReady();
  if (!auth.currentUser) await A.signInAnonymously(auth);
  const uid = auth.currentUser.uid;

  return {
    mode: 'firebase',
    uid,
    watchVotes: cb => F.onSnapshot(F.collection(db, 'votes'), qs => {
      cb(qs.docs.map(d => {
        const x = d.data({ serverTimestamps: 'estimate' });
        return { uid: d.id, name: x.name, at: x.at?.toMillis?.() ?? 0 };
      }));
    }, reportError),
    watchMyVote: cb => F.onSnapshot(F.doc(db, 'votes', uid), s => cb(s.exists() ? s.data().name : null), reportError),
    async castVote(name) {
      await F.setDoc(F.doc(db, 'votes', uid), { name: cleanName(name), at: F.serverTimestamp() });
    },

    async isHost() {
      try { return (await F.getDoc(F.doc(db, 'hosts', uid))).exists(); } catch { return false; }
    },
    async claimHost(pin) {
      try { await F.setDoc(F.doc(db, 'hosts', uid), { pin }); }
      catch (e) { throw e?.code === 'permission-denied' ? new Error('Wrong host password.') : e; }
    },
    async clearVotes() {
      const votes = await F.getDocs(F.collection(db, 'votes'));
      for (let i = 0; i < votes.docs.length; i += 400) {
        const batch = F.writeBatch(db);
        votes.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    },
  };
}

// Demo mode mirrors the Firestore security rules so it behaves like the real thing.
function demoBackend() {
  const KEY = 'ggw-demo-v2';
  // ?as=<name> pins the demo identity, so one test page can embed several "phones".
  const as = params.get('as') ?? embed?.as;
  let uid = as ? `guest-${as}` : null;
  try {
    uid ??= sessionStorage.getItem('ggw-demo-uid');
    if (!uid) {
      uid = 'guest-' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('ggw-demo-uid', uid);
    }
  } catch {
    uid ??= 'guest-' + Math.random().toString(36).slice(2, 8);
  }
  // Embedded frames share one in-memory store on the parent page instead of localStorage.
  const hub = embed?.hub;
  const blank = () => ({ votes: {}, hosts: {} });
  const load = () => {
    try { return { ...blank(), ...JSON.parse(hub ? hub.data : localStorage.getItem(KEY)) }; } catch { return blank(); }
  };
  const subs = new Set();
  const emit = () => subs.forEach(f => f());
  if (hub) hub.subs.add(emit);
  else addEventListener('storage', e => { if (e.key === KEY) emit(); });
  const write = fn => {
    const d = load();
    fn(d);
    const json = JSON.stringify(d);
    if (hub) {
      hub.data = json;
      hub.subs.forEach(f => f());
      return;
    }
    try { localStorage.setItem(KEY, json); }
    catch { throw new Error('Demo storage is full. Clear the votes from the host page.'); }
    emit();
  };
  const watch = (select, cb) => {
    const f = () => cb(select(load()));
    subs.add(f);
    queueMicrotask(f);
    return () => subs.delete(f);
  };
  const isHost = d => Boolean(d.hosts[uid]);

  return Promise.resolve({
    mode: 'demo',
    uid,
    watchVotes: cb => watch(d => Object.entries(d.votes).map(([u, v]) => ({ uid: u, ...v })), cb),
    watchMyVote: cb => watch(d => d.votes[uid]?.name ?? null, cb),
    async castVote(name) {
      const clean = cleanName(name);
      write(d => { d.votes[uid] = { name: clean, at: Date.now() }; });
    },

    async isHost() { return isHost(load()); },
    async claimHost(pin) {
      if (pin !== DEMO_PIN) throw new Error('Wrong host password.');
      write(d => { d.hosts[uid] = true; });
    },
    async clearVotes() {
      write(d => {
        if (!isHost(d)) throw new Error('Only the host can do that.');
        d.votes = {};
      });
    },
  });
}
