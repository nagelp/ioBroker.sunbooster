from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfPower
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
    async_add_entities([SunboosterAcDischargeNumber(entry, client)])


class SunboosterAcDischargeNumber(NumberEntity):
    _attr_should_poll = False
    _attr_has_entity_name = True
    _attr_name = "AC Discharge Power"
    _attr_icon = "mdi:transmission-tower-export"
    _attr_native_min_value = 0
    _attr_native_max_value = 800
    _attr_native_step = 50
    _attr_native_unit_of_measurement = UnitOfPower.WATT
    _attr_mode = NumberMode.BOX

    def __init__(self, entry: ConfigEntry, client: SunboosterClient) -> None:
        self._entry = entry
        self._client = client
        self._attr_unique_id = f"{entry.data['device_key']}_ac_discharge_power"

    @property
    def available(self) -> bool:
        return self._client.available

    @property
    def native_value(self) -> int:
        return self._client.ac_discharge_watt()

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._entry.data["device_key"])},
            name=f"Sunbooster {self._entry.data['device_key']}",
            manufacturer="Sunbooster",
            model=self._entry.data.get("product_key", "Unknown"),
        )

    async def async_set_native_value(self, value: float) -> None:
        watt = int(value)
        await self._client.async_set_ac_discharge_watt(watt)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._client.add_listener(self.async_write_ha_state))