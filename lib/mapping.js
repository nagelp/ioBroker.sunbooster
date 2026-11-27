'use strict';

/**
 * Property map for the Sunbooster POWERSTATION GRID+ (productKey pe16cX),
 * verified live against the device. Keys are the device "resourceCode"s, which
 * are exactly the keys reported over the WebSocket (MATTR.kv) and also the keys
 * accepted by the REST control endpoint (batchControlDevice, data=[{code:value}]).
 *
 * Feed-in power encoding (verified, matches the original HA integration):
 *   value 0 -> 0 W (off), value n>=1 -> 100 + 50*(n-1) W  (50 W steps, up to 800 W)
 */

const FEED_MIN_W = 100;
const FEED_MAX_W = 800;
const FEED_STEP_W = 50;

/**
 * Convert a feed-in wattage to the device's MIG_connection_data_hm value.
 *
 * @param {number|string} watts feed-in power in W (0 = off)
 * @returns {number} the device value
 */
function feedWattsToValue(watts) {
    const w = Number(watts);
    if (!w || w <= 0) {
        return 0;
    }
    const clamped = Math.min(Math.max(w, FEED_MIN_W), FEED_MAX_W);
    const stepped = Math.round((clamped - FEED_MIN_W) / FEED_STEP_W) * FEED_STEP_W + FEED_MIN_W;
    return (stepped - FEED_MIN_W) / FEED_STEP_W + 1;
}

/**
 * Convert the device's MIG_connection_data_hm value back to a wattage.
 *
 * @param {number|string} value the device value
 * @returns {number} feed-in power in W (0 = off)
 */
function feedValueToWatts(value) {
    const v = Number(value);
    if (!v || v <= 0) {
        return 0;
    }
    return FEED_MIN_W + (v - 1) * FEED_STEP_W;
}

const CHARGE_MODE_STATES = { 0: 'off', 1: 'normal', 2: 'fast', 3: 'slow' };
const DEVICE_STATUS_STATES = { 0: 'discharge', 1: 'charge', 2: 'charge+discharge' };

/**
 * Read-only telemetry. `code` is the device resourceCode / WS key.
 * `type`/`role`/`unit` are the ioBroker object definitions. `parse` coerces the
 * raw (often string) WS value into the state value.
 */
const READONLY = [
    {
        id: 'battery_percentage',
        name: 'Battery charge',
        type: 'number',
        role: 'value.battery',
        unit: '%',
        parse: Number,
    },
    { id: 'temp', name: 'Battery temperature', type: 'number', role: 'value.temperature', unit: '°C', parse: Number },
    {
        id: 'device_status',
        name: 'Device status',
        type: 'number',
        role: 'value',
        states: DEVICE_STATUS_STATES,
        parse: Number,
    },
    {
        id: 'total_input_power',
        name: 'Total input power',
        type: 'number',
        role: 'value.power',
        unit: 'W',
        parse: Number,
    },
    {
        id: 'total_output_power',
        name: 'Total output power',
        type: 'number',
        role: 'value.power',
        unit: 'W',
        parse: Number,
    },
    {
        id: 'charge_mode_power_hm',
        name: 'AC charging input power',
        type: 'number',
        role: 'value.power',
        unit: 'W',
        parse: Number,
    },
    { id: 'ac_output_Power', name: 'AC output power', type: 'number', role: 'value.power', unit: 'W', parse: Number },
    { id: 'dc_output_Power', name: 'DC output power', type: 'number', role: 'value.power', unit: 'W', parse: Number },
    {
        id: 'usb_output_power_hm',
        name: 'USB output power',
        type: 'number',
        role: 'value.power',
        unit: 'W',
        parse: Number,
    },
    {
        id: 'dc_solar_input',
        name: 'Solar/PV input power',
        type: 'number',
        role: 'value.power',
        unit: 'W',
        parse: Number,
    },
    {
        id: 'dc_solar_current_input',
        name: 'Solar/PV input current',
        type: 'number',
        role: 'value.current',
        unit: 'A',
        parse: Number,
    },
    { id: 'remain_time', name: 'Remaining discharge time', type: 'number', role: 'value', unit: 'min', parse: Number },
    {
        id: 'remain_charging_time',
        name: 'Remaining charging time',
        type: 'number',
        role: 'value',
        unit: 'min',
        parse: Number,
    },
    {
        id: 'device_electricity_usage',
        name: 'Energy generated',
        type: 'number',
        role: 'value.power.consumption',
        unit: 'kWh',
        parse: Number,
    },
    { id: 'device_soft_ver', name: 'Firmware version', type: 'string', role: 'text', parse: String },
];

/**
 * Writable controls. `toDevice` maps the ioBroker state value to the device
 * value sent via batchControlDevice. `fromDevice` maps a reported device value
 * back to the state value (for mirroring live state onto the control object).
 */
const CONTROLS = [
    {
        id: 'chargeMode',
        code: 'charge_mode_data_hm',
        name: 'AC charging mode',
        type: 'number',
        role: 'level.mode',
        write: true,
        states: CHARGE_MODE_STATES,
        toDevice: v => Number(v),
        fromDevice: v => Number(v),
    },
    {
        id: 'feedPower',
        code: 'MIG_connection_data_hm',
        name: 'Feed-in power to house',
        type: 'number',
        role: 'level.power',
        unit: 'W',
        write: true,
        min: 0,
        max: FEED_MAX_W,
        step: FEED_STEP_W,
        toDevice: v => feedWattsToValue(v),
        fromDevice: v => feedValueToWatts(v),
    },
    {
        // Off stops timer charging at once; on only arms the timer (see lib/timer.js).
        id: 'chargeTimerEnabled',
        code: 'ac_time_switch',
        name: 'AC charge timer enabled',
        type: 'boolean',
        role: 'switch',
        write: true,
        toDevice: v => Boolean(v),
        fromDevice: v => v === true || v === 'true',
    },
    {
        id: 'smartFeeding',
        code: 'smart_on_grid_switch',
        name: 'Smart feeding',
        type: 'boolean',
        role: 'switch',
        write: true,
        toDevice: v => Boolean(v),
        fromDevice: v => v === true || v === 'true',
    },
    {
        id: 'acOutput',
        code: 'ac_switch_hm',
        name: 'AC outputs',
        type: 'boolean',
        role: 'switch',
        write: true,
        toDevice: v => Boolean(v),
        fromDevice: v => v === true || v === 'true',
    },
    {
        id: 'dcOutput',
        code: 'dc_switch_hm',
        name: 'DC outputs',
        type: 'boolean',
        role: 'switch',
        write: true,
        toDevice: v => Boolean(v),
        fromDevice: v => v === true || v === 'true',
    },
    {
        id: 'usbOutput',
        code: 'usb_switch',
        name: 'USB outputs',
        type: 'boolean',
        role: 'switch',
        write: true,
        toDevice: v => Boolean(v),
        fromDevice: v => v === true || v === 'true',
    },
    {
        id: 'statusLight',
        code: 'breathing_lamp_switch_set',
        name: 'Status light',
        type: 'boolean',
        role: 'switch',
        write: true,
        toDevice: v => Boolean(v),
        fromDevice: v => v === true || v === 'true',
    },
];

/** resourceCode -> control definition (for mirroring live reports onto controls). */
const CONTROL_BY_CODE = {};
for (const c of CONTROLS) {
    CONTROL_BY_CODE[c.code] = c;
}

const READONLY_BY_CODE = {};
for (const r of READONLY) {
    READONLY_BY_CODE[r.id] = r;
}

module.exports = {
    READONLY,
    CONTROLS,
    CONTROL_BY_CODE,
    READONLY_BY_CODE,
    CHARGE_MODE_STATES,
    DEVICE_STATUS_STATES,
    feedWattsToValue,
    feedValueToWatts,
    FEED_MIN_W,
    FEED_MAX_W,
    FEED_STEP_W,
};
