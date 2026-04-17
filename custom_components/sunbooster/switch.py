from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import SunboosterClient


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    client: SunboosterClient = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            SunboosterUsbSwitch(entry, client),
            SunboosterAcOutputSwitch(entry, client),
        ]
    )


class _SunboosterBaseSwitch(SwitchEntity):
    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(self, entry: ConfigEntry, client: SunboosterClient) -> None:
        self._entry = entry
        self._client = client

    @property
    def available(self) -> bool:
        return self._client.available

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._entry.data["device_key"])},
            name=f"Sunbooster {self._entry.data['device_key']}",
            manufacturer="Sunbooster",
            model=self._entry.data.get("product_key", "Unknown"),
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._client.add_listener(self.async_write_ha_state))


class SunboosterUsbSwitch(_SunboosterBaseSwitch):
    _attr_name = "USB"
    _attr_icon = "mdi:usb-port"

    def __init__(self, entry: ConfigEntry, client: SunboosterClient) -> None:
        super().__init__(entry, client)
        self._attr_unique_id = f"{entry.data['device_key']}_usb"

    @property
    def is_on(self) -> bool | None:
        return self._client.usb_is_on()

    async def async_turn_on(self, **kwargs) -> None:
        await self._client.async_set_usb(True)

    async def async_turn_off(self, **kwargs) -> None:
        await self._client.async_set_usb(False)


class SunboosterAcOutputSwitch(_SunboosterBaseSwitch):
    _attr_name = "AC Output"
    _attr_icon = "mdi:power-socket-eu"

    def __init__(self, entry: ConfigEntry, client: SunboosterClient) -> None:
        super().__init__(entry, client)
        self._attr_unique_id = f"{entry.data['device_key']}_ac_output"

    @property
    def is_on(self) -> bool | None:
        return self._client.ac_output_is_on()

    async def async_turn_on(self, **kwargs) -> None:
        await self._client.async_set_ac_output(True)

    async def async_turn_off(self, **kwargs) -> None:
        await self._client.async_set_ac_output(False)