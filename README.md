# companion-surface-logitech-mx-dialpad

A Bitfocus Companion 5 surface module for the Logitech MX Creative Dialpad (Bluetooth): the dial and roller
as rotary controls, plus the four buttons. See [HELP.md](./companion/HELP.md).

## Build

Every push to GitHub builds the module (the Build workflow); download the `.tgz` from the run's artifacts, or
from the release for a `v*` tag, and import it on Companion's Modules page (Import module package).

To build on a computer: Node.js 22 and `corepack yarn install && corepack yarn package`. On Windows, run
`set PSExecutionPolicyPreference=Bypass` in the same Command Prompt first, or the package is built without its
code (Companion then says "Module files missing").

## How it works

The Dialpad speaks Logitech HID++ 2.0 on its vendor collection (usage page 0xFF43). On connect the module
diverts the four buttons (ReprogControlsV4, 0x1B04) and switches the dial and roller (undocumented feature
0x4610) to report to the host, then turns their notifications into Companion key and rotate events. The
Dialpad forgets this when it reconnects, so the module redoes it on a wireless-status notification and checks
every 15 seconds.
