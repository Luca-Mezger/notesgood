# Prompt for an AI agent with access to this folder, GitHub and Hostinger

Paste the text below into an agent that can run commands in this project folder and has your GitHub
and Hostinger credentials. Review what it reports back; the one secret you need afterwards is SYNC_KEY.

---

You are in the project folder of **Notesgood**, a web app (TypeScript + esbuild, static output in `dist/`,
PHP sync endpoint in `server/sync.php`). It is already a git repository with commits on branch `main`.
Publish it and set up hosting. Do everything yourself; report the URLs and the sync secret at the end.

1. **GitHub**
   - Create a PUBLIC repository named `notesgood` under my account and push:
     `git remote add origin <repo url> && git push -u origin main`
     Do not rewrite history or add files. If the folder is not a git repository (no `.git`), run
     `git init -b main && git add -A && git commit -m "Notesgood"` first; `.gitignore` is already there.
   - Repository Settings → Pages → Source: **GitHub Actions**. The workflow in
     `.github/workflows/deploy.yml` builds and deploys on every push to `main`.

2. **Hostinger** (shared hosting with PHP)
   - In hPanel, create or reuse an FTP account that can write to the web root of my domain.
   - Create the folder `public_html/notesgood/` (empty; the workflow fills it).
   - Make sure PHP 8.x is active for the domain and that `upload_max_filesize` and `post_max_size`
     are at least 128M (hPanel → Advanced → PHP Configuration), so large PDFs can sync.

3. **Connect them** — in the repo, Settings → Secrets and variables → Actions, add:
   - `FTP_HOST` the FTP hostname from hPanel (e.g. ftp.mydomain.com)
   - `FTP_USER`, `FTP_PASSWORD` the FTP account
   - `FTP_DIR` `/public_html/notesgood/`
   - `SYNC_KEY` a new random secret of at least 32 characters that you generate
   Then run Actions → "Build and deploy" → Run workflow, and confirm all three jobs
   (build, pages, hostinger) are green.

4. **Verify**
   - `https://<my-domain>/notesgood/` loads the app (title "Notesgood") over HTTPS and Chrome offers
     "Install app".
   - `https://<my-domain>/notesgood/sync.php?a=pull&since=0` without a key returns HTTP 401; with
     header `X-Sync-Key: <SYNC_KEY>` it returns `{"rev":0,"items":[]}`.
   - `https://<my-domain>/notesgood/sync-key.txt` must NOT be downloadable. If it is (host ignores
     `.htaccess`), move `sync-key.txt` and `sync-data/` outside the web root, change the two paths at
     the top of `server/sync.php`, commit and push.
   - The GitHub Pages URL loads the app too.

5. **Optional: Android APK** (only if the Android SDK and Java 17 are available or installable)
   - `npm i -g @bubblewrap/cli`, then `bubblewrap init --manifest https://<my-domain>/notesgood/manifest.webmanifest`
     in a new folder `android/` (package id `ch.<my-domain-label>.notesgood`, app name Notesgood), then
     `bubblewrap build`. Keep the generated keystore OUT of git (`android/*.keystore` in `.gitignore`).
   - Put the `assetlinks.json` that Bubblewrap prints at
     `https://<my-domain>/.well-known/assetlinks.json` (upload via FTP), so the app opens without a browser bar.
   - Report where the signed APK is; do not publish it anywhere.

Report back: the repo URL, the Pages URL, the Hostinger app URL, the sync URL
(`https://<my-domain>/notesgood/sync.php`) and the SYNC_KEY. Change nothing else on the hosting account
or in the repo without asking.
