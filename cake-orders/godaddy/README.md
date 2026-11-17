# Option C: Pages on her GoDaddy website

The same order form and owner dashboard as option B, as a folder you upload into her GoDaddy hosting:

- **Customer form:** `https://herbakery.com/orders/`
- **Owner dashboard:** `https://herbakery.com/orders/admin.html` (password-protected)
- **Data:** a small database file inside the folder (SQLite), blocked from the web. MySQL can be used instead.

## First: check which GoDaddy product she has
Log in to GoDaddy → **My Products**.
- **Web Hosting** with a **cPanel Admin** button: ✅ this option works. Continue below.
- **Websites + Marketing / Website Builder** (drag-and-drop editor): ❌ it can't run this code. Use option A or B and link to it from her site, or embed it (see the top-level README).

## Setup (about 20 minutes)

### 1. Build the upload package
On a computer with this project, run `./build.sh`. It creates `dist/godaddy-orders.zip`, which contains one folder named `orders`.

### 2. Upload
1. cPanel → **File Manager** → open `public_html`.
2. **Upload** `godaddy-orders.zip`, then right-click it → **Extract**. You now have `public_html/orders/`.
3. Delete the zip.

### 3. Set the password
1. In `public_html/orders/`, copy `config.sample.php` and name the copy `config.php`.
2. Edit `config.php` and set `'ADMIN_PASSWORD' => 'something-long-and-private'`.
3. While you're there, set `'FROM_EMAIL' => 'orders@herbakery.com'` (an address on her domain) to turn on emails.

Visit `https://herbakery.com/orders/`: the form loads with the sample menu. Visit `/orders/admin.html` and sign in. Fill in **Settings → Your email** and replace the sample menu, recipes, inventory and terms.

### 4. Sunday shopping list
cPanel → **Cron Jobs** → Add New Cron Job:
- Common settings: **Once per week** (or minute `0`, hour `7`, weekday `0`)
- Command (replace `USERNAME` with her cPanel username, shown on the cPanel home page):
  ```
  php /home/USERNAME/public_html/orders/cron.php
  ```

The time uses the server's clock, which may not be her time zone. Adjust the hour if the email arrives at an odd time.

### 5. Square (draft invoices)
1. Go to developer.squareup.com → **Create an app** → **Credentials** → **Production** → copy the **Access token**.
2. Paste it into `config.php` as `'SQUARE_ACCESS_TOKEN' => '...'`.
3. Dashboard → **Settings** → **Test Square / show my location ID**, paste the ID into **Square location ID** and save.

### 6. Calendar
Dashboard → **Calendar** shows a private link. Add it to Google Calendar (Other calendars → From URL) or iPhone (Settings → Calendar → Accounts → Add Subscribed Calendar).

## Notes
- **Email delivery:** this uses GoDaddy's built-in mail. If messages land in spam, the fix is to add SPF/DKIM records for her domain, or switch to an SMTP service later.
- **Backups:** the data lives in `orders/data/orders.sqlite`. cPanel's **Backup** includes it, or download that file from File Manager now and then.
- **Updating:** run `./build.sh` again and upload. **Don't overwrite** `config.php` or the `data/` folder.
- **MySQL instead of SQLite (optional):** create a database in cPanel → MySQL Databases, then set `DB_DSN` (e.g. `mysql:host=localhost;dbname=USER_orders;charset=utf8mb4`), `DB_USER` and `DB_PASS` in `config.php`.

## Testing locally
```bash
./build.sh
ORDERS_CONFIG=/path/to/test-config.php php -S 127.0.0.1:8099 -t dist/godaddy/orders
node tests/e2e.cjs http://127.0.0.1:8099/ <password>
bash godaddy/tests/smoke.sh
```
