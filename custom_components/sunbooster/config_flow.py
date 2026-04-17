from __future__ import annotations

import time

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import (
    CONF_ACCESS_EXPIRATION,
    CONF_DEVICE_KEY,
    CONF_PRODUCT_KEY,
    CONF_REFRESH_EXPIRATION,
    CONF_REFRESH_TOKEN,
    CONF_TOKEN,
    CONF_UID,
    DOMAIN,
)

DEFAULT_ACCESS_LIFETIME = 7200
DEFAULT_REFRESH_LIFETIME = 2592000


class SunboosterConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None) -> FlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                user_input[CONF_ACCESS_EXPIRATION] = int(
                    user_input[CONF_ACCESS_EXPIRATION]
                )
                user_input[CONF_REFRESH_EXPIRATION] = int(
                    user_input[CONF_REFRESH_EXPIRATION]
                )
            except (TypeError, ValueError):
                errors["base"] = "invalid_expiration"
            else:
                await self.async_set_unique_id(user_input[CONF_DEVICE_KEY])
                self._abort_if_unique_id_configured()

                return self.async_create_entry(
                    title=f"Sunbooster {user_input[CONF_DEVICE_KEY]}",
                    data=user_input,
                )

        now = int(time.time())

        schema = vol.Schema(
            {
                vol.Required(CONF_TOKEN): str,
                vol.Required(CONF_REFRESH_TOKEN): str,
                vol.Required(
                    CONF_ACCESS_EXPIRATION,
                    default=str(now + DEFAULT_ACCESS_LIFETIME),
                ): str,
                vol.Required(
                    CONF_REFRESH_EXPIRATION,
                    default=str(now + DEFAULT_REFRESH_LIFETIME),
                ): str,
                vol.Required(CONF_UID): str,
                vol.Required(CONF_DEVICE_KEY): str,
                vol.Required(CONF_PRODUCT_KEY): str,
            }
        )

        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
        )