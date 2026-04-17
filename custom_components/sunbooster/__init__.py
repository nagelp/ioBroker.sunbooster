from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryError

from .const import (
    CONF_ACCESS_EXPIRATION,
    CONF_DEVICE_KEY,
    CONF_PRODUCT_KEY,
    CONF_REFRESH_EXPIRATION,
    CONF_REFRESH_TOKEN,
    CONF_TOKEN,
    CONF_UID,
    DOMAIN,
    PLATFORMS,
)
from .coordinator import SunboosterClient


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    required = [
        CONF_TOKEN,
        CONF_REFRESH_TOKEN,
        CONF_ACCESS_EXPIRATION,
        CONF_REFRESH_EXPIRATION,
        CONF_DEVICE_KEY,
        CONF_PRODUCT_KEY,
        CONF_UID,
    ]
    missing = [key for key in required if key not in entry.data]
    if missing:
        raise ConfigEntryError(
            f"Missing required config data for Sunbooster: {', '.join(missing)}"
        )

    hass.data.setdefault(DOMAIN, {})

    client = SunboosterClient(hass, entry)
    hass.data[DOMAIN][entry.entry_id] = client

    await client.start()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    client = hass.data[DOMAIN].get(entry.entry_id)

    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    if unload_ok:
        if client:
            await client.stop()
        hass.data[DOMAIN].pop(entry.entry_id, None)

    return unload_ok