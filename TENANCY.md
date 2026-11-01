# Running many churches (backend)

Each church gets its **own** Worker, D1 database and R2 bucket in YOUR Cloudflare account, all created by one button.
Nothing is shared between churches: not data, not secrets, not logins.

| Church | Worker | Database | Files |
|---|---|---|---|
| Calvary Temple (original) | updates itself through Cloudflare's GitHub link | `calvary-db` | `calvary-media` |
| every new church `<id>` | `churchdome-<id>` | `churchdome-<id>-db` | `churchdome-<id>-media` |

Each church has a record in `tenants/<id>.json` (names, database id, address, settings, no secrets). That folder is the
list of your customers and the source of truth for each Worker's variables.

## One-time setup (about 15 minutes)

**1. A Cloudflare API token.** Cloudflare dashboard > profile icon > My Profile > API Tokens > Create Token > Create Custom Token.
Permissions (Account level): *Workers Scripts: Edit*, *D1: Edit*, *Workers R2 Storage: Edit*, *Account Settings: Read*.
Account resources: your account only. (Labels move around; pick the closest match.) Copy the token once.
Also copy your **Account ID** (Workers & Pages overview page, right-hand side).

**2. Two GitHub secrets.** In the `calvary-backend` repository: Settings > Secrets and variables > Actions > New repository secret:
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

**3. Upload the new files** to the repository root, keeping folders: `scripts/`, `tenants/`, `migrations/`, `TENANCY.md`
and the **`.github/workflows/`** folder (if the upload page will not take a folder starting with a dot, use
Add file > Create new file and type `.github/workflows/create-church.yml` as the name, then paste each file).
Also replace the changed files in `src/`.

**4. Check:** open the repository's **Actions** tab. You should see five workflows, numbered 1 to 5.

**5. Pay for Workers ($5/month) from your first paying church.** The free plan's 100,000 requests a day is for the
*whole account*, so every church shares it, and the free plan also limits how many databases an account can have
(check Cloudflare's current limits).

## Adding a church

Actions > **1. Create a church** > Run workflow. Fill in:

| Field | Jireh example |
|---|---|
| id | `jireh` |
| church name | `Jireh Temple` |
| app id | `com.churchdome.royalhousejireh` |
| groups | `Men,Women,Youth,Children` |
| app scheme | `royalhousejireh` |
| pastor name / username | `Pastor ...` / `pastor` |

Optional, BEFORE you click Run: add GitHub secrets `FCM_JIREH` (the church's Firebase service-account JSON) and
`PAYSTACK_JIREH` (their Paystack **secret** key). They are attached automatically. If you don't have them yet, run
workflow **4** later.

When the run finishes, open it and read the **Summary**: it shows the server address, the pastor's username and
temporary password (shown once), the exact lines to put in the Android app's `src/jireh/church.json`, and what is still to do.
If a step fails, run it again with the same inputs: it carries on from where it stopped instead of starting over.

## Everyday jobs

| I want to... | Do this |
|---|---|
| Release a backend fix to every church | Change the code in GitHub. **2. Update all churches** runs by itself: tests first, then migrations, then each church |
| Update one church only | Actions > 2 > Run workflow > type its id |
| Give a church its Firebase / Paystack key later | Add GitHub secret `FCM_<ID>` / `PAYSTACK_<ID>`, then **4. Set a church's secrets** |
| A pastor forgot the password | **5. Reset a pastor's password** (new one appears once in the Summary) |
| Add the church's web address | Edit `tenants/<id>.json`: `"WEB_ORIGIN": "https://...pages.dev"`, commit. It redeploys by itself |
| See that backups happen | **3. Back up all churches** runs every night; check its latest Summary |
| Restore a church | `wrangler d1 execute churchdome-<id>-db --remote --file <backup>.sql` (files are in R2 bucket `churchdome-backups/<id>/<date>.sql`) |

Change a church's settings in `tenants/<id>.json`, **never** in the Cloudflare dashboard: the next deploy would overwrite it.

## Backups

Nightly, each church's database is copied to the private R2 bucket `churchdome-backups`. In the dashboard
(R2 > churchdome-backups > Settings > Object lifecycle rules) add a rule to delete files older than 90 days.
**Uploaded sermon/media files are not backed up**; keep the originals.

## Safety notes

- The API token can change every church. Turn on two-step login for your Cloudflare and GitHub accounts, keep the repository **private**, and add as few people as possible: anyone who can open a workflow run can read the pastor password in its Summary.
- Each church has its own random login-signing key (`JWT_SECRET`). The registry file never contains passwords or keys.
- Put these facts in your contract: you host the data, they can export it, and what happens to their Firebase project and database if they leave.
- Money never passes through you: each church uses its own Paystack account.

## Honest limits

- This was tested end to end against a stand-in for Cloudflare (real SQLite databases, the real Worker login code, and the real `wrangler` reading the generated config). It has **not** yet run against your Cloudflare account. The first real run may show a small difference. If it stops, copy the red error text and I'll fix it. It is safe to re-run.
- The GitHub lookup of per-church secrets by name (`FCM_JIREH`) is untested. If a church doesn't receive its key, add it in the Cloudflare dashboard instead (Worker > Settings > Variables and Secrets).
- Calvary stays on its old Cloudflare-GitHub link for now. It is in `tenants/calvary.json` so it is backed up, but not updated by workflow 2.
