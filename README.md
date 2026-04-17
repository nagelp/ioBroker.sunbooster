# ha-sunbooster-grid

This is an unofficial Home Assistant custom integration to control Sunbooster Powerstation Grid.

## Disclaimer

This is an unofficial integration and is not affiliated with or supported by Sunbooster.

This software is provided "as is", without warranty of any kind. Use at your own risk.

The author is not responsible for any damage, data loss, account issues, or unexpected behavior caused by the use of this integration. See licencse section for more details.

The integration uses authentication data provided by the user from their own device.
No credentials are transmitted or stored externally.

---
The following is supported:
- sensors for DC/AC charging/discharging power, charge/remaining time, temperature and other
- turn on/off AC charge/discharge (from/to house grid), power to house grid is supported 100W - 800W
- turn on/off AC outlets as well USB ports

What's not supported:
- pretty much everything else, such as: emergency light/display light changes, change for standby modes, charge time window. Use the official app to control these.

This integration can be used along with the official Sunbooster app. The main purpose is to control/automate the most basic features, e.g. to avoid SOC falling below 25% when discharging to house grid or automatically charge via AC when you have solar surplus or a temporary low energy price.

Tested with:
- Sunbooster Powerstation Grid (1st generation) in European zone/account
- Android app

Untested:
- Sunbooster Powerstation Grid+ as well as any other zone
- iphone app

# Setup

I created a python script you can conveniently run on your computer to get the data you need to set up the integration in HA (only tested on Windows 11 so far). If it doesn't work on your OS there are manual steps further down. The script basically connects to your phone via ADB, runs a command to log the necessary data from the Sunbooster app and outputs the needed data on your screen. This is only required once.

**Please note:**
due to technical limitations the official app will stop working shortly later after you set up the integration in HA successfully. To fix the app simply delete its data (all, not just cache) via the app settings. If you don't know how to do that, uninstall the app fully and reinstall it. Then log into the app as usual with your account data. From this point on, you can use both the integration and app at the same time. I suspect the same might apply to the iphoen app but it's untested so far. Feel free to confirm if you test it with an iphone.

## What you need

- Python (unless you extract the required data yourself, see below)
- An already existing account for the Sunbooster app and your device registered to it
- An Android phone with the Sunbooster app installed (be sure to log out of the app first)
- USB cable to connect your phone to your PC
- Android Platform Tools (ADB), available at https://developer.android.com/tools/releases/platform-tools to run adb commands
- The extraction script: extract_sunbooster_values.py

1. Extract the ADB tools to a folder of your choice, e.g. c:\adb
2. Download and move the script to that same folder
3. Enable USB debugging (developer options) on your Android phone, then connect your phone via USB to your computer, unlock it and allow USB debugging when you see the popup.
   
   If you'd rather want to log by yourself do the following (be sure to start logging before you log into the app), else go to step 4:
   ```bat
   adb devices
   adb logcat -c
   adb logcat | findstr /i "QuecTokenManager save token access token refresh token token-refresh websocket_login QuecDeviceListManager" > sunbooster_filtered_log.txt
   python extract_sunbooster_values.py sunbooster_filtered_log.txt

4. Run the script: python extract_sunbooster_values.py

The script should output the following on your screen:

- (access) token (copy the complete string after the "=", starting with "Bearer", so that the later pasted token is "Bearer xxx...yyy")
- refresh token (same as above applies)
- uid
- productKey
- deviceKey
- deviceName and productName (only for debug purposes, not required for HA)

Sometimes the script doesn't seem to work properly and does not output the uid for example. In that case, repeat all steps and wait longer after you log into the Sunbooster app (up to a minute should be safe) before pressing a key to continue. Alternatively, run the ADB commands yourself and get the data from the output manually.

## Integration installation
1. Create a aub folder in your HA directory "custom_components" called Sunbooster and copy all files and folders of this integration into that sub folder
2. Restart Home Assistant
3. Add the new "Sunbooster" integration via the UI.
4. Fill in the required values you received from the script. Do not change the expiration values, leave them on default, then hit submit.
  <img width="263" height="448" alt="sunbooster_ha_setup" src="https://github.com/user-attachments/assets/5009155c-45a9-41ce-817f-8b252c45223d" />

5. You should see a new device in that ingegration now along with the sensors and switches to control it.



## FAQ
**Q:** Help! The app suddenly no longer works anymore correctly after I successfully added the Sunbooster in the integration.\
**A:** This is unavoidable but fixable. Delete the app's memory (not just its cache) in the app settings or uninstall and reinstall the app.

**Q:** Does the integration replace the official app? Will the official app still work?\
**A:** No, this integration merely adds support for Home Assistant. You can still use the official app along with this integration at the same time.

**Q:** I have the newer Sunbooster Powerstation Grid+, will the integration work?\
**A:** currently untested, feel free to give it a go and let me know.

**Q:** How do I know which generation of Sunbooster Powerstation Grid I have?\
**A:** if your Sunbooster Powerstation has a port on the side to connect the EXTENSION battery then you have the newer generation. Else you have the 1st generation.

**Q:** why does the integration not simply ask for username/password, why the workaround with the script? Is the script safe to use?\
**A:** due to some limitations I had to decide to do it this way, sorry. The script will only read a filtered log of your phone and store that data only on your computer locally. If you feel unsafe about that you can also check the script and run the required commands yourself, then extract the data yourself manually. I merely created it for users who want to save time or are not experienced enough to get the data themselves.

**Q:** I ran the script but it's not working!\
**A:** Worst thing you can do is to only report "it's not working" as no one can read your mind or your screen. Always be specific (imagine you describe what happens on your computer to a blind person). There's a good chance you did not read everything properly and forgot a step (I speak of self-experience). Also, the script is not 100% stable, sometimes it will not output everything, see above.
