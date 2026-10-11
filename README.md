# Top Bar Swipe

A GNOME Shell extension that sends animated, colored swipe bars across the top panel when things happen: notifications, plugging in the charger, a Bluetooth device connecting. It can also run as a calm ambient loop.

## Features

- **Ambient mode**: a continuous, gentle swipe in your chosen color and direction
- **Notification reactions**: rules for color, direction, stroke count and cycles, matched against the app name or the notification title (never the message body). Every rule has a Preview button
- **Device reactions**: charger and Bluetooth connect/disconnect (UPower, BlueZ), event-driven with no polling. Battery bar: solid up to the level with a soft edge and the percentage shown; swipes run inside it (left to right on connect, back to 0 on disconnect). Low/medium colors are shared; above medium each device shows its own color. Bluetooth devices that report their battery get the bar too; disconnects swipe center-outward
- **Schedule**: battery alerts (play the bar when the battery drops below or reaches a level) and timed scripts (every N minutes or daily at a time)
- **Trigger button** *(optional, off by default)*: a panel button and/or keyboard shortcut that opens a menu of shell commands **you** configure in Preferences. The answer appears right on the top bar. Nothing runs unless you add it, and the shortcut is disabled on the lock screen

Supports GNOME Shell 45, 46 and 47.

## Install

**From extensions.gnome.org** (recommended): *link coming after review*

**From source:**

```bash
git clone https://github.com/koustavbetal/topbar-swipe.git
cd topbar-swipe
make install
# log out and back in (Wayland), then:
gnome-extensions enable topbar-swipe@koustavbetal.github.io
```

## Development

The repo can live directly in the extensions folder (then use `make schemas`, not `make install`, which would replace the folder):

```bash
~/.local/share/gnome-shell/extensions/topbar-swipe@koustavbetal.github.io/
```

| Command        | What it does                                        |
|----------------|-----------------------------------------------------|
| `make schemas` | compile GSettings schemas for running from source   |
| `make pack`    | build the zip to upload to extensions.gnome.org     |
| `make install` | pack and install the zip locally                    |
| `make lint`    | run ESLint                                          |
| `make logs`    | follow GNOME Shell logs                             |

To test without logging out, run a nested shell: `dbus-run-session -- gnome-shell --nested --wayland` (GNOME 45–48).

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
