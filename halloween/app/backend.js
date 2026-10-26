// Data layer. Two interchangeable backends with the same API:
//  - firebase: shared Firestore database, one anonymous sign-in per phone
//  - demo:     localStorage in this browser, each tab acts as a separate guest
//
// Data model (Firestore):
//  config/state   { phase: 'entries'|'voting'|'closed'|'revealed', results }
//  entries/{uid}  { name, costume, photo (JPEG data URL), createdAt }  one per phone
//  votes/{uid}    { entryId, at }                                       one per phone
//  hosts/{uid}    { pin }  created by entering the host password (checked by the rules)
import { firebaseConfig } from '../firebase-config.js';

const FIREBASE_VERSION = '10.12.2';
export const DEMO_PIN = 'boo';

const params = new URLSearchParams(location.search);
// Set by the all-in-one test page, which embeds each "phone" as an inline frame.
const embed = window.GGW_EMBED;
export const firebaseReady = Boolean(firebaseConfig?.apiKey) && !firebaseConfig.apiKey.startsWith('PASTE');
export const isDemo = params.has('demo') || !firebaseReady || Boolean(embed);

export const LIMITS = { name: 40, costume: 60, photo: 300000 };

export function connect() {
  return isDemo ? demoBackend() : firebaseBackend();
}

function reportError(err) {
  console.error(err);
  dispatchEvent(new CustomEvent('backend-error', { detail: err }));
}

function cleanEntry({ name, costume, photo }) {
  name = String(name ?? '').trim().slice(0, LIMITS.name);
  costume = String(costume ?? '').trim().slice(0, LIMITS.costume);
  if (!name) throw new Error('Please add your name.');
  if (!costume) throw new Error('Please name your costume.');
  if (typeof photo !== 'string' || !photo.startsWith('data:image/jpeg;base64,')) throw new Error('Please add a photo of your costume.');
  if (photo.length >= LIMITS.photo) throw new Error('That photo is too large. Try another one.');
  return { name, costume, photo };
}

const byCreated = (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

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

  const stateRef = F.doc(db, 'config', 'state');
  const toMs = t => (t?.toMillis ? t.toMillis() : Number(t) || 0);
  const friendly = (e, msg) => {
    if (e?.code === 'permission-denied') throw new Error(msg);
    throw e;
  };

  return {
    mode: 'firebase',
    uid,
    watchState: cb => F.onSnapshot(stateRef, s => cb(s.exists() ? s.data() : null), reportError),
    watchEntries: cb => F.onSnapshot(F.collection(db, 'entries'), qs => {
      cb(qs.docs.map(d => {
        const x = d.data({ serverTimestamps: 'estimate' });
        return { ...x, id: d.id, createdAt: toMs(x.createdAt) };
      }).sort(byCreated));
    }, reportError),
    watchMyVote: cb => F.onSnapshot(F.doc(db, 'votes', uid), s => cb(s.exists() ? s.data().entryId : null), reportError),
    watchVotes: cb => F.onSnapshot(F.collection(db, 'votes'), qs => {
      cb(qs.docs.map(d => ({ uid: d.id, entryId: d.data().entryId })));
    }, reportError),

    async saveEntry(data) {
      const entry = cleanEntry(data);
      const ref = F.doc(db, 'entries', uid);
      try {
        if ((await F.getDoc(ref)).exists()) await F.updateDoc(ref, entry);
        else await F.setDoc(ref, { ...entry, createdAt: F.serverTimestamp() });
      } catch (e) { friendly(e, 'Entries are closed right now.'); }
    },
    async deleteEntry(id) {
      try { await F.deleteDoc(F.doc(db, 'entries', id)); }
      catch (e) { friendly(e, 'That entry can’t be removed right now.'); }
    },
    async castVote(entryId) {
      try { await F.setDoc(F.doc(db, 'votes', uid), { entryId, at: F.serverTimestamp() }); }
      catch (e) { friendly(e, 'Voting isn’t open right now.'); }
    },

    async isHost() {
      try { return (await F.getDoc(F.doc(db, 'hosts', uid))).exists(); } catch { return false; }
    },
    async claimHost(pin) {
      try { await F.setDoc(F.doc(db, 'hosts', uid), { pin }); }
      catch (e) { friendly(e, 'Wrong host password.'); }
      if (!(await F.getDoc(stateRef)).exists()) await F.setDoc(stateRef, { phase: 'entries', results: null });
    },
    setState: patch => F.setDoc(stateRef, patch, { merge: true }),
    async resetAll() {
      const [votes, entries] = await Promise.all([
        F.getDocs(F.collection(db, 'votes')),
        F.getDocs(F.collection(db, 'entries')),
      ]);
      const refs = [...votes.docs, ...entries.docs].map(d => d.ref);
      for (let i = 0; i < refs.length; i += 400) {
        const batch = F.writeBatch(db);
        refs.slice(i, i + 400).forEach(r => batch.delete(r));
        await batch.commit();
      }
      await F.setDoc(stateRef, { phase: 'entries', results: null });
    },
  };
}

// Demo mode mirrors the Firestore security rules so it behaves like the real thing.
function demoBackend() {
  const KEY = 'ggw-demo-v1';
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
  const blank = () => ({ state: null, entries: {}, votes: {}, hosts: {} });
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
    catch { throw new Error('Demo storage is full. Reset the contest from the host page.'); }
    emit();
  };
  const watch = (select, cb) => {
    const f = () => cb(select(load()));
    subs.add(f);
    queueMicrotask(f);
    return () => subs.delete(f);
  };
  const phase = d => d.state?.phase;
  const isHost = d => Boolean(d.hosts[uid]);
  const deny = msg => { throw new Error(msg); };

  return Promise.resolve({
    mode: 'demo',
    uid,
    watchState: cb => watch(d => d.state, cb),
    watchEntries: cb => watch(d => Object.entries(d.entries).map(([id, e]) => ({ ...e, id })).sort(byCreated), cb),
    watchMyVote: cb => watch(d => d.votes[uid]?.entryId ?? null, cb),
    watchVotes: cb => watch(d => (isHost(d) ? Object.entries(d.votes).map(([u, v]) => ({ uid: u, entryId: v.entryId })) : []), cb),

    async saveEntry(data) {
      const entry = cleanEntry(data);
      write(d => {
        if (!['entries', 'voting'].includes(phase(d))) deny('Entries are closed right now.');
        d.entries[uid] = { ...entry, createdAt: d.entries[uid]?.createdAt ?? Date.now() };
      });
    },
    async deleteEntry(id) {
      write(d => {
        const own = id === uid && ['entries', 'voting'].includes(phase(d));
        if (!own && !isHost(d)) deny('That entry can’t be removed right now.');
        delete d.entries[id];
      });
    },
    async castVote(entryId) {
      write(d => {
        if (phase(d) !== 'voting' || entryId === uid || !d.entries[entryId]) deny('Voting isn’t open right now.');
        d.votes[uid] = { entryId, at: Date.now() };
      });
    },

    async isHost() { return isHost(load()); },
    async claimHost(pin) {
      if (pin !== DEMO_PIN) deny('Wrong host password.');
      write(d => {
        d.hosts[uid] = true;
        d.state ??= { phase: 'entries', results: null };
      });
    },
    async setState(patch) {
      write(d => {
        if (!isHost(d)) deny('Only the host can do that.');
        d.state = { ...d.state, ...patch };
      });
    },
    async resetAll() {
      write(d => {
        if (!isHost(d)) deny('Only the host can do that.');
        Object.assign(d, { state: { phase: 'entries', results: null }, entries: {}, votes: {} });
      });
    },
  });
}
