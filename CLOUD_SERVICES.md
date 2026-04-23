# Cloud Services — RedsssProduction Studios

A quick-reference sheet for every external service the site depends on.
Open this any time you return to the project.

---

## 1. Firebase — Auth + Firestore + Realtime Database

**Dashboard:** https://console.firebase.google.com → project `redsssproduction-studios-86bec`

**What it does:**
| Service | Used for | If it goes down / is disabled |
|---|---|---|
| **Authentication** | Login with email/password and Google | Nobody can log in |
| **Firestore** | User profiles, servers, channels, messages, friend requests, notifications | Entire site is non-functional |
| **Realtime Database (RTDB)** | Online/offline presence dots only (`presence/{uid}`) | Status dots stop updating; everything else still works |

**Key paths in Firestore:**
- `users/{uid}` — profile (username, avatar, status, effectiveStatus, lastSeen)
- `servers/{id}/channels/{id}/messages/{id}` — chat messages
- `servers/{id}/channels/{id}/streams/{uid}` — live stream state
- `presence/{uid}` — in RTDB (not Firestore), online flag only

**How to check RTDB is enabled:**
Console → Realtime Database in sidebar → should show a data tree, not a "Get Started" button.
If not enabled: click Get Started → pick region → Test mode → Done.

**Where keys live in code:** `site/js/firebase-config.js`

---

## 2. Cloudinary — Media Uploads

**Dashboard:** https://cloudinary.com → sign in → Dashboard

**What it does:** Stores every image, GIF, and video uploaded in stream chat, profile pictures, etc.

**Config:**
- Cloud name: `dgwamtt1j`
- Upload preset: `redsss_uploads` (must be set to **Unsigned**)
- Folder: `redsss_avatars` (avatars), other uploads go to root

**If it goes down:** Uploads fail; previously uploaded images/avatars still show (they're served as public URLs).

**Where keys live in code:** `site/js/firebase-config.js` (bottom two constants)

---

## 3. LiveKit — Live Streaming (screen share / video)

**Dashboard:** https://cloud.livekit.io → project `redsssproduction-studios`

**What it does:** Handles all real-time video/screen-share streams in messenger and on the stream viewer widget.

**Server URL:** `wss://redsssproduction-studios-aiosfout.livekit.cloud`

**How it works:**
1. Browser calls `POST /livekit-token` (a Cloudflare Pages Function) with a Firebase ID token
2. The function signs a LiveKit JWT using `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET`
3. Browser connects to LiveKit cloud with that token

**Where the function lives:** `functions/livekit-token.js` (auto-deployed by Cloudflare Pages)

**Where secrets live:** Cloudflare Pages → Settings → Environment Variables
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

**If it goes down / keys are missing:** Streaming and stream viewer fail with "Failed to load stream"; everything else still works.

**If you forget your API keys:** LiveKit Dashboard → your project → Settings → API Keys → create new pair → update Cloudflare env vars.

---

## 4. Cloudflare Pages — Hosting

**Dashboard:** https://dash.cloudflare.com → Workers & Pages → your project

**What it does:**
- Hosts the entire site (the `site/` folder is the build output)
- Auto-deploys every time you `git push` to GitHub
- Runs the `functions/` folder as serverless edge functions (e.g. `/livekit-token`)
- Provides the SSL certificate for the domain

**Build settings:**
- Build command: *(blank)*
- Build output directory: `site`
- Production branch: `main`

**Custom domain:** `redsssproduction.studio` (+ www)

**If it goes down:** Site is unreachable. Check https://www.cloudflarestatus.com

**Environment variables set here** (Cloudflare Pages → Settings → Environment Variables):
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

---

## 5. GitHub — Code Storage + Deploy Trigger

**Repo:** https://github.com/ItsRedCreeper/Redsssproduction-Studios

**What it does:** Stores all the code. Every `git push` to `main` triggers Cloudflare to rebuild and redeploy the site automatically (usually takes ~30 seconds).

**If you lose access:** The code is also on your local machine. Re-authenticate with `git` and push again.

---

## 6. Namecheap — Domain Registrar

**Dashboard:** https://www.namecheap.com → Domain List → `redsssproduction.studio`

**What it does:** Owns the domain name. Nameservers are pointed to Cloudflare so Cloudflare controls all DNS.

**Renewal:** Check expiry date in Namecheap — renew before it expires or the domain goes offline.

**If the domain goes down:** Check Namecheap for expiry. The site still works at the `.pages.dev` URL while you sort it out.

---

## Summary — "What do I need to touch to deploy?"

For normal code changes:
```
git add -A
git commit -m "description"
git push
```
That's it. Cloudflare auto-deploys.

For adding a new environment variable (e.g. new LiveKit key):
→ Cloudflare Pages → Settings → Environment Variables → Add/Edit → Redeploy.

For adding a new login domain (e.g. after renaming the Pages project):
→ Firebase Console → Authentication → Settings → Authorized Domains → Add domain.

---

## Quick Links

| Service | URL |
|---|---|
| Firebase Console | https://console.firebase.google.com |
| Cloudinary Dashboard | https://cloudinary.com |
| LiveKit Dashboard | https://cloud.livekit.io |
| Cloudflare Pages | https://dash.cloudflare.com → Workers & Pages |
| GitHub Repo | https://github.com/ItsRedCreeper/Redsssproduction-Studios |
| Namecheap | https://www.namecheap.com |
| Live Site | https://redsssproduction.studio |
