/* ==========================================
   Firebase Configuration
   ==========================================
   Replace these placeholder values with your
   actual Firebase project credentials from
   the Firebase Console > Project Settings.
   ========================================== */

const firebaseConfig = {
    apiKey: "AIzaSyA00cVrighKdgnS7wE3xxAuy5fgbpsFtS4",
    authDomain: "redsssproduction-studios-1c6ad.firebaseapp.com",
    projectId: "redsssproduction-studios-1c6ad",
    storageBucket: "redsssproduction-studios-1c6ad.firebasestorage.app",
    messagingSenderId: "963735570944",
    appId: "1:963735570944:web:8735c024e524c8a88da6e5"
    // databaseURL: "" — add after creating Realtime Database
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Export references
const auth = firebase.auth();
const db = firebase.firestore();

// Cloudinary config
const CLOUDINARY_CLOUD_NAME = "dgwamtt1j";
const CLOUDINARY_UPLOAD_PRESET = "redsss_uploads";
