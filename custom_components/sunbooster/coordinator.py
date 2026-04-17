from __future__ import annotations

import asyncio
import json
import ssl
import time
from collections.abc import Callable
from typing import Any

import paho.mqtt.client as mqtt
from aiohttp import ClientError, ClientSession, WSMsgType
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
import logging

from .const import (
    AC_CHARGE_MODES,
    CONF_ACCESS_EXPIRATION,
    CONF_DEVICE_KEY,
    CONF_PRODUCT_KEY,
    CONF_REFRESH_EXPIRATION,
    CONF_REFRESH_TOKEN,
    CONF_TOKEN,
    CONF_UID,
    DEFAULT_REFRESH_MARGIN,
    MESSAGE_TYPES,
    MQTT_COMMAND_TIMEOUT,
    MQTT_HOST,
    MQTT_KEEPALIVE,
    MQTT_PATH,
    MQTT_PORT,
    REFRESH_URL,
    WS_URL,
)

_LOGGER = logging.getLogger(__name__)


class SunboosterAuthError(Exception):
    """Raised when authentication fails and refresh cannot recover."""


class SunboosterCommandError(Exception):
    """Raised when a write command fails."""


class SunboosterClient:
    """WebSocket + token refresh + MQTT command client for Sunbooster."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.session: ClientSession = async_get_clientsession(hass)

        self.access_token: str = self._normalize_token(entry.data[CONF_TOKEN])
        self.refresh_token: str = self._normalize_token(entry.data[CONF_REFRESH_TOKEN])
        self.access_expiration: int = int(entry.data[CONF_ACCESS_EXPIRATION])
        self.refresh_expiration: int = int(entry.data[CONF_REFRESH_EXPIRATION])
        self.device_key: str = entry.data[CONF_DEVICE_KEY]
        self.product_key: str = entry.data[CONF_PRODUCT_KEY]
        self.uid: str = entry.data[CONF_UID]

        self.refresh_margin = DEFAULT_REFRESH_MARGIN

        self.data: dict[str, Any] = {"online": None}
        self.control_state: dict[str, Any] = {
            "ac_discharge_watt": 0,
        }
        self.available = False
        self.auth_failed = False

        self._listeners: list[Callable[[], None]] = []
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    @staticmethod
    def _normalize_token(token: str) -> str:
        token = token.strip()
        if not token:
            raise ValueError("Token is empty")
        if token.startswith("Bearer Bearer "):
            token = token.replace("Bearer Bearer ", "Bearer ", 1)
        return token if token.startswith("Bearer ") else f"Bearer {token}"

    def add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)

        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    def _notify(self) -> None:
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:
                _LOGGER.exception("Listener callback failed")

    def _seconds_until_access_expiry(self) -> int:
        return self.access_expiration - int(time.time())

    def _seconds_until_refresh_expiry(self) -> int:
        return self.refresh_expiration - int(time.time())

    def _access_expires_soon(self) -> bool:
        return self._seconds_until_access_expiry() <= self.refresh_margin

    async def start(self) -> None:
        self._stop_event.clear()
        self._task = self.hass.async_create_task(self._run_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _store_tokens(self) -> None:
        new_data = {
            **self.entry.data,
            CONF_TOKEN: self.access_token,
            CONF_REFRESH_TOKEN: self.refresh_token,
            CONF_ACCESS_EXPIRATION: self.access_expiration,
            CONF_REFRESH_EXPIRATION: self.refresh_expiration,
        }
        self.hass.config_entries.async_update_entry(self.entry, data=new_data)

    async def _refresh_tokens(self) -> None:
        if self._seconds_until_refresh_expiry() <= 0:
            raise SunboosterAuthError("Refresh token has already expired")

        _LOGGER.info("Refreshing Sunbooster tokens")

        try:
            async with self.session.put(
                REFRESH_URL,
                data={"refreshToken": self.refresh_token},
                timeout=15,
            ) as response:
                text = await response.text()

                if response.status != 200:
                    raise SunboosterAuthError(
                        f"Refresh HTTP failed: {response.status} {text}"
                    )

                try:
                    payload = json.loads(text)
                except json.JSONDecodeError as exc:
                    raise SunboosterAuthError(
                        f"Refresh response is not valid JSON: {text}"
                    ) from exc
        except (ClientError, asyncio.TimeoutError) as exc:
            raise RuntimeError(f"Refresh request failed: {exc}") from exc

        if payload.get("code") != 200:
            raise SunboosterAuthError(f"Refresh failed: {payload}")

        data = payload.get("data") or {}
        access = data.get("accessToken") or {}
        refresh = data.get("refreshToken") or {}

        new_access = access.get("token")
        new_access_exp = access.get("expirationTime")
        new_refresh = refresh.get("token")
        new_refresh_exp = refresh.get("expirationTime")

        if not all([new_access, new_access_exp, new_refresh, new_refresh_exp]):
            raise SunboosterAuthError(f"Refresh response incomplete: {payload}")

        self.access_token = self._normalize_token(new_access)
        self.access_expiration = int(new_access_exp)
        self.refresh_token = self._normalize_token(new_refresh)
        self.refresh_expiration = int(new_refresh_exp)

        await self._store_tokens()

        _LOGGER.info(
            "Sunbooster token refresh successful. Access expires in %s seconds, refresh expires in %s seconds.",
            self._seconds_until_access_expiry(),
            self._seconds_until_refresh_expiry(),
        )

    async def _ensure_valid_access_token(self) -> None:
        if self._access_expires_soon():
            _LOGGER.info(
                "Access token expires soon (%s seconds remaining), refreshing now",
                self._seconds_until_access_expiry(),
            )
            await self._refresh_tokens()

    async def _ws_login_and_subscribe(self):
        ws = await self.session.ws_connect(
            WS_URL,
            heartbeat=20,
            receive_timeout=30,
        )

        try:
            await ws.send_json(
                {
                    "cmd": "login",
                    "data": {"token": self.access_token},
                }
            )
            login_msg = await ws.receive()

            if login_msg.type != WSMsgType.TEXT:
                raise RuntimeError(f"Unexpected login message type: {login_msg.type}")

            login_payload = json.loads(login_msg.data)
            login_data = login_payload.get("data") or {}
            if login_payload.get("cmd") != "login_resp" or login_data.get("code") != 1:
                raise SunboosterAuthError(f"WebSocket login failed: {login_payload}")

            await ws.send_json(
                {
                    "cmd": "subscribe",
                    "data": [
                        {
                            "deviceKey": self.device_key,
                            "productKey": self.product_key,
                            "messageType": MESSAGE_TYPES,
                        }
                    ],
                }
            )
            subscribe_msg = await ws.receive()

            if subscribe_msg.type != WSMsgType.TEXT:
                raise RuntimeError(
                    f"Unexpected subscribe message type: {subscribe_msg.type}"
                )

            subscribe_payload = json.loads(subscribe_msg.data)
            subscribe_data = subscribe_payload.get("data")
            if (
                not isinstance(subscribe_data, list)
                or not subscribe_data
                or subscribe_data[0].get("code") != 1
            ):
                raise RuntimeError(f"WebSocket subscribe failed: {subscribe_payload}")

            return ws

        except Exception:
            await ws.close()
            raise

    async def _connect_with_retry(self):
        await self._ensure_valid_access_token()

        try:
            return await self._ws_login_and_subscribe()
        except SunboosterAuthError as exc:
            _LOGGER.warning("WebSocket login failed, trying token refresh: %s", exc)
            await self._refresh_tokens()
            return await self._ws_login_and_subscribe()

    @staticmethod
    def _is_ws_token_invalid_message(obj: dict[str, Any]) -> bool:
        if obj.get("cmd") == "login_resp":
            data = obj.get("data") or {}
            return data.get("code") == 4008

        if obj.get("cmd") == "error":
            data = obj.get("data") or {}
            return data.get("code") in (4008, 4010)

        return False

    def _handle_ws_message(self, obj: dict[str, Any]) -> None:
        payload = obj.get("data", {})
        msg_type = payload.get("type")
        inner = payload.get("data", {})

        changed = False

        if msg_type == "ONLINE":
            self.data["online"] = inner.get("value") == 1
            changed = True

        elif msg_type == "MATTR":
            kv = inner.get("kv", {})
            if isinstance(kv, dict):
                self.data.update(kv)
                changed = True

                # Updated mapping based on latest verified summary:
                # 0=off, 1=normal, 2=fast, 3=slow
                charge_mode = kv.get("charge_mode_data_hm")
                if charge_mode in (0, 1, 2, 3):
                    self.control_state["ac_charge_mode"] = {
                        0: "off",
                        1: "normal",
                        2: "fast",
                        3: "slow",
                    }[charge_mode]

        if changed:
            self.available = True
            self._notify()

    async def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            ws = None
            try:
                self.auth_failed = False
                ws = await self._connect_with_retry()

                self.available = True
                self._notify()

                while not self._stop_event.is_set():
                    await self._ensure_valid_access_token()

                    msg = await ws.receive()

                    if msg.type == WSMsgType.TEXT:
                        obj = json.loads(msg.data)

                        if self._is_ws_token_invalid_message(obj):
                            _LOGGER.warning(
                                "Server reported token problem, refreshing and reconnecting"
                            )
                            await ws.close()
                            await self._refresh_tokens()
                            break

                        if obj.get("cmd") != "message":
                            continue

                        self._handle_ws_message(obj)
                        continue

                    if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING):
                        raise RuntimeError("WebSocket closed")

                    if msg.type == WSMsgType.ERROR:
                        raise RuntimeError(f"WebSocket error: {ws.exception()}")

            except asyncio.CancelledError:
                raise
            except SunboosterAuthError as err:
                self.available = False
                self.auth_failed = True
                _LOGGER.warning("Sunbooster authentication failed: %s", err)
                self._notify()
                await asyncio.sleep(30)
            except Exception as err:
                self.available = False
                _LOGGER.warning("Sunbooster connection error: %s", err)
                self._notify()
                await asyncio.sleep(10)
            finally:
                if ws is not None:
                    await ws.close()

    def usb_is_on(self) -> bool | None:
        value = self.data.get("usb_switch")
        return None if value is None else bool(value)

    def ac_output_is_on(self) -> bool | None:
        value = self.data.get("ac_switch_hm")
        return None if value is None else bool(value)

    def ac_charge_mode(self) -> str | None:
        raw = self.data.get("charge_mode_data_hm")
        mapping = {0: "off", 1: "normal", 2: "fast", 3: "slow"}
        return mapping.get(raw)

    def ac_discharge_watt(self) -> int:
        return int(self.control_state.get("ac_discharge_watt", 0))

    def is_ac_connected(self) -> bool:
        charge_mode = self.data.get("charge_mode_data_hm", 0)
        total_input_power = self.data.get("total_input_power", 0) or 0
        charge_mode_power = self.data.get("charge_mode_power_hm", 0) or 0
        return bool(charge_mode != 0 or total_input_power > 0 or charge_mode_power > 0)

    async def async_set_usb(self, enabled: bool) -> None:
        payload = self._usb_payload(enabled)
        await self._async_send_mqtt_command(payload)
        self.data["usb_switch"] = enabled
        self._notify()

    async def async_set_ac_output(self, enabled: bool) -> None:
        payload = self._ac_output_payload(enabled)
        await self._async_send_mqtt_command(payload)
        self.data["ac_switch_hm"] = enabled
        self._notify()

    async def async_set_ac_charge_mode(self, mode: str) -> None:
        mode = mode.lower()
        if mode not in AC_CHARGE_MODES:
            raise ValueError(f"Unsupported AC charge mode: {mode}")

        payload = self._ac_charge_payload(mode)
        await self._async_send_mqtt_command(payload)
        self.data["charge_mode_data_hm"] = {
            "off": 0,
            "normal": 1,
            "fast": 2,
            "slow": 3,
        }[mode]
        self.control_state["ac_charge_mode"] = mode
        self._notify()

    async def async_set_ac_discharge_watt(self, watt: int) -> None:
        watt = int(watt)
        payload = self._mig_payload(watt)
        await self._async_send_mqtt_command(payload)
        self.control_state["ac_discharge_watt"] = watt
        self._notify()

    async def _async_send_mqtt_command(self, payload: bytes) -> None:
        await self._ensure_valid_access_token()
        try:
            await self.hass.async_add_executor_job(self._sync_send_mqtt_command, payload)
        except SunboosterAuthError:
            await self._refresh_tokens()
            await self.hass.async_add_executor_job(self._sync_send_mqtt_command, payload)

    def _sync_send_mqtt_command(self, payload: bytes) -> None:
        access_token = self.access_token
        client_id = self._build_client_id(self.uid)
        pub_bus, sub_ack, sub_bus, sub_onl = self._build_topics(
            self.product_key, self.device_key
        )

        state = {
            "connected_ok": False,
            "ack_seen": False,
            "bus_seen": False,
            "auth_error": None,
            "error": None,
        }

        def on_connect(client, userdata, flags, rc):
            if rc != 0:
                state["error"] = f"MQTT connect rc={rc}"
                return

            state["connected_ok"] = True
            client.subscribe(sub_ack)
            client.subscribe(sub_bus)
            client.subscribe(sub_onl)
            client.publish(pub_bus, payload=payload, qos=0)

        def on_message(client, userdata, msg):
            if msg.topic.endswith("/ack_") or msg.topic.endswith("/onl_"):
                try:
                    text = msg.payload.decode("utf-8")
                except Exception:
                    text = repr(msg.payload)

                if '"type":"SENDACK"' in text and '"status":"succ"' in text:
                    state["ack_seen"] = True

                if "token validation failed" in text or '"code":4008' in text:
                    state["auth_error"] = "MQTT token validation failed"

            elif msg.topic.endswith("/bus"):
                state["bus_seen"] = True

        def on_disconnect(client, userdata, rc):
            return None

        client = self._create_mqtt_client(client_id, access_token)
        client.on_connect = on_connect
        client.on_message = on_message
        client.on_disconnect = on_disconnect

        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=MQTT_KEEPALIVE)
            client.loop_start()
            start = time.time()

            while time.time() - start < MQTT_COMMAND_TIMEOUT:
                if state["auth_error"]:
                    raise SunboosterAuthError(state["auth_error"])
                if state["error"]:
                    raise SunboosterCommandError(state["error"])
                if state["ack_seen"]:
                    return
                time.sleep(0.2)

            raise SunboosterCommandError("No SENDACK received from device")
        finally:
            try:
                client.loop_stop()
            except Exception:
                pass
            try:
                client.disconnect()
            except Exception:
                pass

    @staticmethod
    def _build_client_id(uid: str) -> str:
        return f"qu_{uid}_{int(time.time() * 1000)}"

    @staticmethod
    def _build_topics(product_key: str, device_key: str) -> tuple[str, str, str, str]:
        base = f"qd{product_key}{device_key}"
        pub_bus = f"q/1/d/{base}/bus"
        sub_ack = f"q/2/d/{base}/ack_"
        sub_bus = f"q/2/d/{base}/bus"
        sub_onl = f"q/2/d/{base}/onl_"
        return pub_bus, sub_ack, sub_bus, sub_onl

    @staticmethod
    def _create_mqtt_client(client_id: str, access_token: str) -> mqtt.Client:
        try:
            client = mqtt.Client(
                callback_api_version=mqtt.CallbackAPIVersion.VERSION1,
                client_id=client_id,
                transport="websockets",
                protocol=mqtt.MQTTv311,
            )
        except Exception:
            client = mqtt.Client(
                client_id=client_id,
                transport="websockets",
                protocol=mqtt.MQTTv311,
            )

        client.username_pw_set(username="", password=access_token)
        client.ws_set_options(path=MQTT_PATH)
        client.tls_set(cert_reqs=ssl.CERT_NONE)
        client.tls_insecure_set(True)
        return client

    @staticmethod
    def _usb_payload(on: bool) -> bytes:
        if on:
            return bytes.fromhex("AA AA 00 07 23 00 0E 00 13 01 01")
        return bytes.fromhex("AA AA 00 07 23 00 0F 00 13 01 00")

    @staticmethod
    def _ac_output_payload(on: bool) -> bytes:
        if on:
            return bytes.fromhex("AA AA 00 07 FC 00 27 00 13 01 C1")
        return bytes.fromhex("AA AA 00 07 FC 00 28 00 13 01 C0")

    @staticmethod
    def _mig_value_from_watt(watt: int) -> int:
        if watt == 0:
            return 0
        if watt < 100 or watt > 800 or watt % 50 != 0:
            raise ValueError("Discharge watt must be 0 or between 100 and 800 in 50 W steps")
        return ((watt - 100) // 50) + 1

    @classmethod
    def _mig_payload(cls, watt: int) -> bytes:
        mig_val = cls._mig_value_from_watt(watt)
        return bytes.fromhex(f"AA AA 00 09 28 00 0A 00 13 01 0A 00 {mig_val:02X}")

    @staticmethod
    def _ac_charge_payload(mode: str) -> bytes:
        mode = mode.lower()
        if mode == "off":
            return bytes.fromhex("AA AA 00 09 00 00 13 00 13 00 DA 00 00")
        if mode == "normal":
            return bytes.fromhex("AA AA 00 09 F8 00 08 00 13 00 DA 00 01")
        if mode == "fast":
            return bytes.fromhex("AA AA 00 09 FB 00 0D 00 13 00 DA 00 02")
        if mode == "slow":
            return bytes.fromhex("AA AA 00 09 06 00 17 00 13 00 DA 00 03")
        raise ValueError(f"Unsupported AC charge mode: {mode}")