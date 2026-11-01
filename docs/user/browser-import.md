# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

Later login changes stay separate between the two browsers. To refresh an imported desktop browser
profile, open its options under **Settings → Integrations → Browser profiles**, choose **Refresh
from browser profile**, and select or add the sites to refresh. Cookies shared across related sites
can also update those sites; GOAT reports the shared domains. This refresh applies to desktop browser
profiles, not server-run browser profiles. Some sites may still require you to sign in again.

An agent can use an imported profile when you name it, like any other profile. GOAT never imports
on its own.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag GOAT into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen GOAT before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox, Zen, and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.
