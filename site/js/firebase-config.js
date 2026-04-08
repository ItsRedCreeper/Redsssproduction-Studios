/* Firebase + Cloudinary Config — RedsssProduction Studios */

const firebaseConfig = {
  apiKey: "AIzaSyA00cVrighKdgnS7wE3xxAuy5fgbpsFtS4",
  authDomain: "redsssproduction-studios-1c6ad.firebaseapp.com",
  projectId: "redsssproduction-studios-1c6ad",
  storageBucket: "redsssproduction-studios-1c6ad.firebasestorage.app",
  messagingSenderId: "963735570944",
  appId: "1:963735570944:web:8735c024e524c8a88da6e5"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

const CLOUDINARY_CLOUD = "dgwamtt1j";
const CLOUDINARY_PRESET = "redsss_uploads";
