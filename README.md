# Booth Leads – Affiliate Fest 2026

Phone app for sales staff to record visitor interests at the booth. It saves on the phone first and syncs to a Google Sheet when there is signal.

- **App (GitHub Pages):** `index.html`, `app.js`, `styles.css`, `sw.js`, `config.js`
- **Backend (Google Apps Script):** `apps-script/Code.gs`

## One-time setup

### 1. Google Sheet + Apps Script
1. Open the leads Google Sheet (tabs: `Staff`, `Products`, `Leads`, `LeadItems`, `EditLog`).
2. **File → Settings → Time zone:** `(GMT+07:00) Bangkok`.
3. **Extensions → Apps Script.** Delete the sample code, paste all of `apps-script/Code.gs`, and save.
4. Choose the `setup` function in the toolbar and click **Run**. Approve the permissions. This adds any missing columns (including `product_SKU` in LeadItems) and formats code/PIN columns as plain text.
5. **Deploy → New deployment →** type **Web app**, Execute as **Me**, Who has access **Anyone** → Deploy. Copy the URL ending in `/exec`.

### 2. Connect the app
Put the URL in `config.js`:
```js
window.APP_CONFIG = { API_URL: 'https://script.google.com/macros/s/XXXX/exec' };
```
and push. Then bump `CACHE` in `sw.js` (for example `booth-leads-v2`) on every later change so phones pick it up.

### 3. Install on iPhone
Open the GitHub Pages link in **Safari** → Share → **Add to Home Screen**. Open it from the icon and log in once while online.

## Managing it during the event
| Task | How |
|---|---|
| Lock a staff member out | Set `active` to FALSE in `Staff` (applies at their next sync) |
| Log out every phone | In Apps Script, run `logoutEveryone` |
| Hide a product | Set `active` to FALSE in `Products` |
| Change the backend code | Deploy → **Manage deployments** → edit → **New version** (keeps the same URL) |

## Data notes
- `Leads.created_at` / `updated_at` are the phone's time when the salesperson saved. `received_at` is when the server got it.
- Walk-in codes look like `W01-003` (staff number + sequence). When a walk-in registers, edit the lead and enter their 5-digit code. All their leads move to the new code and `original_walkin_code` keeps the W-code.
- Every edit is written to `EditLog` (field, old value, new value).
