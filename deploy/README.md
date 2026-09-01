# Oracle deployment

This deployment is intentionally isolated from other applications on the host.
The dashboard listens on host loopback port `3100`, and the headed Chromium
console listens on host loopback port `6080`. Neither port is public.

Start an SSH tunnel from Windows:

```powershell
ssh -i "C:\Users\AKBAR LAPTOP\.ssh\ytmonitorbot-trial-20260817.key" -L 3100:127.0.0.1:3100 -L 6080:127.0.0.1:6080 opc@170.9.36.175
```

Then open:

- Dashboard: http://127.0.0.1:3100
- Headed browser console: http://127.0.0.1:6080/vnc.html

When connecting a Google account, keep both pages open. Click **Connect Google
Account** in the dashboard, then complete login and 2FA in the browser console.
Sign-in opens normal Chrome without Playwright attached. After signing in, close
the inner Chrome window, leaving the console tab and dashboard open. Only then
does the dashboard attach automation to check the saved session. The noVNC
password unlocks the remote desktop; it is not your Google password.
The Oracle image uses the current stable Google Chrome channel controlled by
Playwright; it does not hide automation or bypass Google security checks.
The Chromium profile and SQLite database are stored in `/opt/livepilot/deploy/data` on
the instance.

Both manual and automated browsers use Chrome's sandbox. The Compose seccomp
profile is the Playwright v1.62.0 Docker profile (Apache-2.0), downloaded from
https://github.com/microsoft/playwright/blob/v1.62.0/utils/docker/seccomp_profile.json.
It permits the user-namespace operations Chrome needs while retaining a syscall
allowlist and `no-new-privileges`. Do not use privileged mode or disable seccomp.

Keep the Compose `hostname: livepilot-browser` stable across deployments. Chrome
uses the hostname when deciding whether a persistent profile is already in use.
Do not share this data directory with another running deployment. If migrating
an old container leaves a "profile in use on another computer" warning, stop
every browser using that profile before an administrator removes only the stale
`SingletonLock`, `SingletonSocket`, and `SingletonCookie` symlinks. Never delete
the profile or its sign-in data to clear a startup lock.

When public access is enabled, use the password-protected endpoints:

- Dashboard: https://livepilot.170.9.36.175.sslip.io
- Headed browser console: https://browser.livepilot.170.9.36.175.sslip.io/vnc.html
