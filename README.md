# ioBroker.sunbooster

Unofficial ioBroker adapter to **monitor and control the Sunbooster POWERSTATION GRID / GRID+** through the vendor cloud (Quectel/Acceleronix). It reads live telemetry over a WebSocket and sends commands over the documented REST control API.

> Unofficial and not affiliated with or supported by Sunbooster. Provided "as is", without warranty. Use at your own risk. The adapter uses authentication tokens obtained from your own account/device; nothing is sent anywhere except the vendor cloud your app already uses.

Tested live against a **POWERSTATION GRID+** (productKey `pe16cX`), European zone.

## What it does

- **Telemetry** (`sunbooster.<i>.device.*`): battery %, temperature, input/output power, AC/DC/USB/solar power, charging power, remaining times, device status, firmware.
- **Controls** (`sunbooster.<i>.control.*`, writable):
  - `chargeMode` — AC charging: `0` off, `1` normal, `2` fast, `3` slow
  - `feedPower` — feed-in power to the house in watts: `0` (off) or `100…800` in 50 W steps
  - `acOutput`, `dcOutput`, `usbOutput`, `smartFeeding`, `statusLight` — on/off switches

### Switching between feed-in and charging

- **Charge from AC** (e.g. from fuel-cell / PV surplus): set `control.feedPower = 0`, then `control.chargeMode = 3` (slow). Watch `device.charge_mode_power_hm` for the actual draw. Note: the device will not charge when the battery is already full.
- **Feed the house**: set `control.chargeMode = 0`, then `control.feedPower = 200` (or your target, 50 W steps).

Deciding *when* to switch is up to you (scripts, Tibber price, fuel-cell output, …).

## Why tokens instead of username/password

Sunbooster never shipped the promised API. The app talks to the Quectel/Acceleronix cloud, which **does** have a documented end-user API. This adapter uses that API with an access/refresh token pair taken from your own logged-in app session. The refresh token is valid ~30 days and is rotated automatically while the adapter runs, so you normally extract it only once.

## Obtaining the tokens (one-time)

You need an Android phone, a PC with [`adb`](https://developer.android.com/tools/releases/platform-tools) and [Node.js](https://nodejs.org), and your POWERSTATION registered to your Sunbooster account.

The current app (V1.1.0) doesn't log the login, but the older **V1.0.0** does:

1. Install SUNBOOSTER **V1.0.0** (e.g. from APKPure/APKMirror):
   ```bash
   adb uninstall com.sunbooster.app
   adb install sunbooster-v1.0.0.apk
   ```
2. Capture a login:
   ```bash
   adb logcat -c
   # now log in to the app and open your POWERSTATION, wait ~10 seconds
   adb logcat -d > login.log
   ```
3. Extract the credentials:
   ```bash
   node tools/extract-credentials.js login.log
   ```
   Without a clone of this repo, download the single file first (it has no dependencies):
   `curl -O https://raw.githubusercontent.com/nagelp/ioBroker.sunbooster/main/tools/extract-credentials.js`

   This writes `credentials.json` and prints the values for the adapter settings.

You can reinstall the latest app afterwards; the tokens keep working.

> [!IMPORTANT]
> **The app gets logged out shortly after the adapter starts.** The adapter continues the app session you captured, and its first token refresh invalidates the app's copy. This is expected and only happens once: log in to the app again (if that doesn't work, clear the app's data or reinstall it). After that, the app and the adapter work side by side.

## Installation

On the ioBroker host:

```bash
iobroker url https://github.com/nagelp/ioBroker.sunbooster
```

Then add an instance of `sunbooster` in the admin and configure it as below.

## Configuration

In the adapter admin settings enter the seven values printed by `extract-credentials.js`, exactly as shown (tokens include the `Bearer ` prefix). The WebSocket/REST URLs default to the European zone and can be changed under *Advanced*.

**Live updates:** the device only reports on its own when something changes. Like the app does while it's open, the adapter asks it every 10 seconds to push live values (*Advanced → Live update interval*; `0` turns this off). While this runs, changed values arrive about every 5 seconds. Each request is one small cloud API call.

The rotating tokens are stored in `sunbooster.<i>.info.tokens` and reused across restarts; the admin fields are only the initial seed. Once the adapter runs, it owns the token chain: every refresh invalidates the previous refresh token, so don't use the same `credentials.json` anywhere else (it goes stale after the adapter's first refresh).

## Notes & limitations

- **Cloud-dependent.** If the vendor cloud or token scheme changes, this can break.
- **REST read-back lags.** The cloud's REST values are only as fresh as the device's last report; the adapter uses them only to fill in all states on connect and takes live values from the WebSocket.
- **GRID (1st gen).** Should work in principle (same cloud/property model) but is untested here; property codes may differ.

## Development

```bash
npm install
npm run test:unit          # unit tests (mapping, credential extraction)
SUNBOOSTER_CRED=/path/credentials.json npm run test:live   # live device check (sends real commands)
```

## Credits

This adapter is inspired by and started as a fork of [ha-sunbooster-grid](https://github.com/Shad0wWeaver/ha-sunbooster-grid), the Home Assistant integration by [Shad0wWeaver](https://github.com/Shad0wWeaver). The core ideas came from there: capturing the app's tokens via `adb logcat`, the cloud WebSocket for live values, the token refresh, the property names and the feed-in power encoding. Many thanks to Shad0wWeaver for figuring all of this out and sharing it!

Most of the code in this repository, and much of this README, was written by an AI assistant (GitHub Copilot with Claude Fable 5.2 and Opus 5.5 model). [nagelp](https://github.com/nagelp) directed the work and tested the adapter against a real POWERSTATION GRID+.

## License

MIT — see [LICENSE](LICENSE).
