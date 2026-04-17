DOMAIN = "sunbooster"

CONF_TOKEN = "token"
CONF_REFRESH_TOKEN = "refresh_token"
CONF_ACCESS_EXPIRATION = "access_expiration"
CONF_REFRESH_EXPIRATION = "refresh_expiration"
CONF_DEVICE_KEY = "device_key"
CONF_PRODUCT_KEY = "product_key"
CONF_UID = "uid"

DEFAULT_REFRESH_MARGIN = 300

PLATFORMS = ["sensor", "switch", "select", "number", "binary_sensor"]

WS_URL = "wss://iot-ws.quecteleu.com/ws/v1"
REFRESH_URL = "https://iot-api.acceleronix.io/v2/enduser/enduserapi/refreshToken"

MQTT_HOST = "iot-south.acceleronix.io"
MQTT_PORT = 8443
MQTT_PATH = "/ws/v2"
MQTT_KEEPALIVE = 40
MQTT_COMMAND_TIMEOUT = 8

AC_CHARGE_MODES = ["off", "slow", "normal", "fast"]

MESSAGE_TYPES = [
    "ONLINE",
    "STATUS",
    "RAW-UPLINK",
    "MATTR-REPORT",
    "MEVENT-INFO",
    "MEVENT-WARN",
    "MEVENT-ERROR",
    "LOCATION-INFO-KV",
    "MSERV-OUTPUT",
    "MATTR-READRESP",
]