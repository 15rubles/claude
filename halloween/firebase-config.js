// Paste your Firebase web app config here (Firebase console → Project settings →
// Your apps → Web app → "SDK setup and configuration" → Config).
// These values are not secrets; the security rules in firestore.rules protect the data.
//
// While apiKey still starts with "PASTE", the app runs in demo mode: everything
// is stored in this browser only, so you can try it out but phones can't share votes.
export const firebaseConfig = {
  apiKey: 'PASTE_API_KEY_HERE',
  authDomain: 'PASTE_PROJECT_ID.firebaseapp.com',
  projectId: 'PASTE_PROJECT_ID',
  storageBucket: 'PASTE_PROJECT_ID.appspot.com',
  messagingSenderId: 'PASTE_SENDER_ID',
  appId: 'PASTE_APP_ID',
};
