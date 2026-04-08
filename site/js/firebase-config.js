/* Firebase + Cloudinary Config — RedsssProduction Studios */

const firebaseConfig = {
  apiKey: "AIzaSyDTillZk16z8gaIvrs-wBVZ0QhW6LzEi0U",
  authDomain: "redsssproduction-studios-86bec.firebaseapp.com",
  projectId: "redsssproduction-studios-86bec",
  storageBucket: "redsssproduction-studios-86bec.firebasestorage.app",
  messagingSenderId: "627076589255",
  appId: "1:627076589255:web:c99c6a1111205425fd00e2",
  databaseURL: "https://redsssproduction-studios-86bec-default-rtdb.firebaseio.com"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

const CLOUDINARY_CLOUD = "dgwamtt1j";
const CLOUDINARY_PRESET = "redsss_uploads";
