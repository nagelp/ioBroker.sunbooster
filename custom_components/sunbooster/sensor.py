from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    PERCENTAGE,
    UnitOfElectricCurrent,
    UnitOfPower,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import SunboosterClient


SENSORS: tuple[SensorEntityDescription, ...] = (
    SensorEntityDescription(
        key="online",
        name="Online",
        icon="mdi:lan-connect",
    ),
    SensorEntityDescription(
        key="battery_percentage",
        name="Battery",
        native_unit_of_measurement=PERCENTAGE,
        device_class=SensorDeviceClass.BATTERY,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="temp",
        name="Temperature",
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        device_class=SensorDeviceClass.TEMPERATURE,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="total_input_power",
        name="Total Input Power",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="charge_mode_power_hm",
        name="AC Charge Power",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="total_output_power",
        name="Total Output Power",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="ac_output_Power",
        name="AC Output Power",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="dc_output_Power",
        name="DC Output Power",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="dc_solar_input",
        name="DC Solar Input",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="dc_solar_current_input",
        name="DC Solar Current Input",
        native_unit_of_measurement=UnitOfElectricCurrent.AMPERE,
        device_class=SensorDeviceClass.CURRENT,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="remain_charging_time",
        name="Remaining Charging Time",
        native_unit_of_measurement="min",
        icon="mdi:battery-clock",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="remain_time",
        name="Remaining Runtime",
        native_unit_of_measurement="min",
        icon="mdi:timer-outline",
        state_class=SensorStateClass.MEASUREMENT,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    client: SunboosterClient = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        SunboosterSensor(entry, client, description) for description in SENSORS
    )


class SunboosterSensor(SensorEntity):
    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(
        self,
        entry: ConfigEntry,
        client: SunboosterClient,
        description: SensorEntityDescription,
    ) -> None:
        self.entity_description = description
        self._entry = entry
        self._client = client
        self._attr_unique_id = f"{entry.data['device_key']}_{description.key}"

    @property
    def available(self) -> bool:
        return self._client.available

    @property
    def native_value(self):
        value = self._client.data.get(self.entity_description.key)

        if self.entity_description.key == "battery_percentage" and value is not None:
            try:
                return int(round(float(value)))
            except (TypeError, ValueError):
                return value

        return value

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