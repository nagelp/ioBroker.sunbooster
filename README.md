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

You need an Android phone with the Sunbooster app, a PC with `adb` ([platform-tools](https://developer.android.com/tools/releases/platform-tools)), and the device registered to your account.

The current app build (V1.1.0) does **not** log the tokens. An older build (**V1.0.0**) logs the full login response, so:

1. Download **SUNBOOSTER V1.0.0** (e.g. from APKPure/APKMirror) and install it:
   `adb uninstall com.sunbooster.app` then `adb install v1.0.0.apk`
2. Start capturing, then log in to the app once:
   ```bash
   adb logcat -c
   adb logcat | grep --line-buffered -E 'emailPwdLogin|QuecRNAPP' > login.log
   ```
3. In `login.log`, find:
   - the `emailPwdLogin--:` line → `data.accessToken.token`, `data.accessToken.expirationTime`, `data.refreshToken.token`, `data.refreshToken.expirationTime`
   - the `Running "QuecRNAPP"` line → `uid`, `productKey`, `deviceKey`
4. You may reinstall the latest app afterwards; the captured token keeps working.

> The expiration values are **unix seconds**. Keep the `Bearer ` prefix on both tokens.

## Configuration

In the adapter admin settings enter: access token, refresh token, both expiry timestamps, `uid`, `productKey`, `deviceKey`. The WebSocket/REST URLs default to the European zone and can be changed under *Advanced*.

The rotating tokens are stored in `sunbooster.<i>.info.tokens` and reused across restarts; the admin fields are only the initial seed.

## Notes & limitations

- **Cloud-dependent.** If the vendor cloud or token scheme changes, this can break.
- **REST read-back lags.** Live values come from the WebSocket; the REST snapshot (used only to seed state on connect) can be a few seconds stale.
- **Using the app in parallel.** After the adapter refreshes tokens, the official app session may need a re-login (clear app data / re-login).
- **GRID (1st gen).** Should work in principle (same cloud/property model) but is untested here; property codes may differ.

## Development

```bash
npm install
npm run test:unit          # pure mapping/unit tests
SUNBOOSTER_CRED=/path/credentials.json npm run test:live   # live device check (sends real commands)
```

## License

MIT — see [LICENSE](LICENSE).
