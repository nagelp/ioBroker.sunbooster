from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import AC_CHARGE_MODES, DOMAIN
from .coordinator import SunboosterClient


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    client: SunboosterClient = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([SunboosterAcChargeSelect(entry, client)])


class SunboosterAcChargeSelect(SelectEntity):
    _attr_should_poll = False
    _attr_has_entity_name = True
    _attr_name = "AC Charge Mode"
    _attr_icon = "mdi:power-plug-battery"
    _attr_options = AC_CHARGE_MODES

    def __init__(self, entry: ConfigEntry, client: SunboosterClient) -> None:
        self._entry = entry
        self._client = client
        self._attr_unique_id = f"{entry.data['device_key']}_ac_charge_mode"

    @property
    def available(self) -> bool:
        return self._client.available

    @property
    def current_option(self) -> str | None:
        return self._client.ac_charge_mode()

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._entry.data["device_key"])},
            name=f"Sunbooster {self._entry.data['device_key']}",
            manufacturer="Sunbooster",
            model=self._entry.data.get("product_key", "Unknown"),
        )

    async def async_select_option(self, option: str) -> None:
        await self._client.async_set_ac_charge_mode(option)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._client.add_listener(self.async_write_ha_state))