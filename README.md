# tidal-dowloader

A web app for quickly searching and downloading high-quality audio files using a Tidal HiFi/HiFi Plus subscription.
Node.js/Express port of the download, decryption and tagging pipeline from
[Tidal-Media-Downloader](https://github.com/yaronzz/Tidal-Media-Downloader) by @yaronzz (Apache-2.0). See `NOTICE`
for full attribution.

⚠️ **Important notes**

* Private use only.
* Needs a Tidal HiFi subscription.
* Do not use this to distribute or pirate music.
* This relies on undocumented Tidal endpoints; it may violate Tidal's Terms of Service and could be illegal to use
  in your jurisdiction depending on local anti-circumvention law. Use at your own risk.

---

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/GLOXIOU/tidal-dowloader
   cd tidal-dowloader
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file from the example and fill it in:

   ```bash
   cp .env.example .env
   ```

   ```
    JWT_SECRET=(Random long secret used to sign the session JWT cookie. Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

    PORT=3000 (Port the web server listens on)

    DOWNLOAD_DIR=./downloads (Where downloaded files are written by default)
   ```

4. Start the server:

   ```bash
   npm start
   ```

5. Open `http://localhost:3000`.

---

## How It Works

* Log in with your Tidal account via Tidal's own OAuth2 device-code flow: the app shows a short code, you enter it
  on tidal.com, and it never sees your password.
* Search any track/album/playlist in the search bar, or paste a `tidal.com/browse/...` link to preview it.
* Download it in the best quality your subscription allows (FLAC for Lossless/Max, AAC otherwise), fully tagged
  with cover art.
* (Planned) an optional toggle to automatically move finished downloads into a folder of your choice.

---

## License

Apache License 2.0 — see `LICENSE` and `NOTICE`.
