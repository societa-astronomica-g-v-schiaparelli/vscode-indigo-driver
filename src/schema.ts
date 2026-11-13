/** Static description of the .driver DSL accepted by indigo_generator. */

export type ValueKind = "string" | "expression" | "boolean" | "integer" | "identifier";

export interface AttributeSpec {
  kind: ValueKind;
  doc: string;
  /** Suggested values offered by completion. */
  values?: string[];
  mandatory?: boolean;
}

export interface BlockSpec {
  doc: string;
}

export const DEVICE_TYPES = [
  "ccd",
  "wheel",
  "focuser",
  "mount",
  "guider",
  "rotator",
  "dome",
  "gps",
  "ao",
  "aux",
  "polaralign",
];
export const PROPERTY_KINDS = ["inherited", "switch", "text", "number", "light"];
export const TRANSPORTS = ["serial", "hid", "libusb", "sdk"];
export const CODE_BLOCKS = [
  "include",
  "define",
  "data",
  "code",
  "on_init",
  "on_shutdown",
  "on_attach",
  "on_detach",
  "on_connect",
  "on_disconnect",
  "on_timer",
  "on_change",
  "on_change_request",
  "discover",
  "plug",
  "unplug",
  "unplug_match",
];

export type ContextName =
  | "driver"
  | "serial"
  | "pattern"
  | "hid"
  | "libusb"
  | "sdk"
  | "device"
  | "inherited"
  | "property"
  | "item"
  | "reject_change";

const BOOL = ["true", "false"];

const bool = (doc: string): AttributeSpec => ({ kind: "boolean", doc, values: BOOL });
const expr = (doc: string, values?: string[], mandatory = false): AttributeSpec => ({
  kind: "expression",
  doc,
  values,
  mandatory,
});
const ident = (doc: string): AttributeSpec => ({ kind: "identifier", doc });
const str = (doc: string, mandatory = false): AttributeSpec => ({ kind: "string", doc, mandatory });

const PROPERTY_COMMON: Record<string, AttributeSpec> = {
  name: expr(
    'Property name. A string such as `"X_FOO"` (custom properties must start with `X_`) or a standard name macro.',
  ),
  label: expr("Label shown by clients. Set it on every local property."),
  perm: expr(
    "Permission. Write exactly `INDIGO_RO_PERM` to drop the generated change branch; an equivalent macro generates useless handlers.",
    ["INDIGO_RW_PERM", "INDIGO_RO_PERM", "INDIGO_WO_PERM"],
  ),
  rule: expr("Switch rule.", ["INDIGO_ONE_OF_MANY_RULE", "INDIGO_AT_MOST_ONE_RULE", "INDIGO_ANY_OF_MANY_RULE"]),
  hidden: expr("Initial hidden state."),
  persistent: bool("Save the property on `CONFIG.SAVE`. Hidden and read-only properties are never saved."),
  preserve_values: bool("Copy only the `target` of number items (positions, temperatures, coordinates)."),
  asynchronous_change: bool(
    "Default `true`. With `false` the handler runs in the bus context: use it only for code that never blocks.",
  ),
  pass_through_change: bool("After the generated change branch, continue to the device class change handler."),
  accept_while_busy: bool("Accept changes while BUSY. Only meaningful for `GUIDER_GUIDE_RA/DEC`."),
  handler: expr("Override the generated change handler name."),
  handle: expr("Override the generated property or item handle."),
};

export const CONTEXTS: Record<
  ContextName,
  { attributes: Record<string, AttributeSpec>; blocks: string[]; doc: string }
> = {
  driver: {
    doc: "Top level driver definition. Any attribute not listed here becomes a `#define NAME value` constant.",
    attributes: {
      label: str(
        'Human readable driver label (`DRIVER_LABEL`). Strings have no escapes: the first `"` closes the string.',
        true,
      ),
      author: str("Author, with an optional e-mail between `<` and `>`.", true),
      copyright: str("Copyright holder line copied into the generated headers.", true),
      version: {
        kind: "integer",
        doc: "Driver build number; `DRIVER_VERSION` is `0x03000000 + version`. Never 0, increment on every behavior change.",
        mandatory: true,
      },
      multi_device_support: bool("Set the flag in `indigo_driver_info`. Default `false`."),
      max_devices: {
        kind: "integer",
        doc: "Number of simultaneously attached devices. Only for `libusb` and `sdk` drivers (default 5).",
      },
      cpp: bool("Generate a `.cpp` file. Use only when C++ is really needed."),
      supported_architecture: str(
        "Preprocessor condition wrapped around the implementation, e.g. `!defined(__i386__)`. Avoid it: drivers should compile everywhere.",
      ),
    },
    blocks: ["include", "define", "data", "code", "on_init", "on_shutdown", ...TRANSPORTS, ...DEVICE_TYPES],
  },
  serial: {
    doc: "Serial transport (also TCP/UDP). Adds `DEVICE_PORT`/`DEVICE_PORTS` and an `indigo_uni_handle *handle` to the private data. The block may be empty.",
    attributes: {
      no_ports: bool("Do not create `DEVICE_PORTS` and skip port enumeration."),
      configurable_speed: bool("Show `DEVICE_BAUDRATE`."),
    },
    blocks: ["pattern"],
  },
  pattern: {
    doc: "Automatic serial port matching rule. May be repeated. A bare `pattern;` matches any port.",
    attributes: {
      vendor: expr("Vendor name pattern."),
      product: expr("Product name pattern."),
      serial: expr("Serial number pattern."),
      vid: expr("USB vendor id."),
      pid: expr("USB product id."),
      exact_match: expr("Require exact pattern matching.", BOOL),
    },
    blocks: [],
  },
  hid: {
    doc: "HID transport (requires hidapi, not usable by custom out-of-tree drivers).",
    attributes: {
      hotplug: bool("Enable hot-plug. Default `true`."),
      vid: expr("USB vendor id."),
      pid: expr("USB product id."),
    },
    blocks: [],
  },
  libusb: {
    doc: "libusb transport. The shared `code` block must provide `<name>_match(libusb_device *dev, const char **name)`.",
    attributes: {
      hotplug: bool("Enable hot-plug. Default `true`."),
      vid: expr("USB vendor id."),
      pid: expr("USB product id."),
    },
    blocks: [],
  },
  sdk: {
    doc: "Vendor SDK transport (requires the manufacturer library).",
    attributes: {
      usb: bool(
        "Default `true`. Use `false` with `hotplug = false` and `discover` for SDK-enumerated non-USB devices.",
      ),
      discovery_retries: expr("SDK discovery retry count."),
      hotplug: bool("Enable hot-plug. Default `true`."),
      vid: expr("USB vendor id."),
      pid: expr("USB product id."),
    },
    blocks: ["discover", "plug", "unplug", "unplug_match"],
  },
  device: {
    doc: "Logical device. The first device block of the driver is the master.",
    attributes: {
      id: ident(
        "Logical identifier. Needed only with two devices of the same type; put it before properties and code blocks.",
      ),
      name: expr("Device name seen by clients. Must differ from the upstream driver name."),
      name_value: expr("Runtime device name expression."),
      attach_if: expr("Condition for attaching this logical device."),
      additional_instances: bool("Enable `ADDITIONAL_INSTANCES`."),
      interface: expr("Mandatory for `aux`: one or more `INDIGO_INTERFACE_AUX_*` flags combined with `|`.", [
        "INDIGO_INTERFACE_AUX_POWERBOX",
        "INDIGO_INTERFACE_AUX_WEATHER",
        "INDIGO_INTERFACE_AUX_SQM",
        "INDIGO_INTERFACE_AUX_LIGHTBOX",
        "INDIGO_INTERFACE_AUX_DUSTCAP",
        "INDIGO_INTERFACE_AUX_SHUTTER",
        "INDIGO_INTERFACE_AUX_GPIO",
        "INDIGO_INTERFACE_AUX_JOYSTICK",
      ]),
    },
    blocks: ["code", "on_attach", "on_detach", "on_connect", "on_disconnect", "on_timer", ...PROPERTY_KINDS],
  },
  inherited: {
    doc: "Property owned by the device class base driver and customized here. Listing it makes it visible unless `hidden = true`.",
    attributes: {
      label: PROPERTY_COMMON.label,
      name: PROPERTY_COMMON.name,
      perm: PROPERTY_COMMON.perm,
      rule: PROPERTY_COMMON.rule,
      hidden: PROPERTY_COMMON.hidden,
      persistent: PROPERTY_COMMON.persistent,
      preserve_values: PROPERTY_COMMON.preserve_values,
      asynchronous_change: PROPERTY_COMMON.asynchronous_change,
      pass_through_change: PROPERTY_COMMON.pass_through_change,
      accept_while_busy: PROPERTY_COMMON.accept_while_busy,
      handler: PROPERTY_COMMON.handler,
      handle: PROPERTY_COMMON.handle,
    },
    blocks: ["code", "on_change_request", "reject_change", "on_attach", "on_change", "on_detach"],
  },
  property: {
    doc: "Locally defined property, created on connection (or always with `always_defined`).",
    attributes: {
      ...PROPERTY_COMMON,
      group: expr("Property group. Default `MAIN_GROUP`.", ["MAIN_GROUP"]),
      always_defined: bool("Define the property even when disconnected."),
      pointer: expr("Override the private property pointer field."),
    },
    blocks: ["code", "on_change_request", "reject_change", "on_attach", "on_change", "on_detach", "item"],
  },
  item: {
    doc: "Property item. `item ID;` takes every default.",
    attributes: {
      name: expr("Item name."),
      label: expr("Item label."),
      value: expr("Initial value."),
      min: expr("Minimum (number items only)."),
      max: expr("Maximum (number items only)."),
      step: expr("Step (number items only)."),
      format: expr('printf style format (number items only), e.g. `"%.2f"`.'),
      handle: PROPERTY_COMMON.handle,
    },
    blocks: [],
  },
  reject_change: {
    doc: "Reject a change request before values are copied (bus context: no I/O). May be repeated.",
    attributes: {
      condition: expr("Reject the change when this C expression is true.", undefined, true),
      message: str("Message published with the rejection.", true),
    },
    blocks: [],
  },
};

/** Hover documentation for every block keyword. */
export const BLOCK_DOCS: Record<string, BlockSpec> = {
  include: { doc: "Extra `#include` directives, emitted after the standard headers." },
  define: { doc: "Extra `#define` directives." },
  data: { doc: "Extra fields of `<name>_private_data`." },
  code: { doc: "Hand written helpers: protocol functions, `<name>_open`, `<name>_close`." },
  on_init: {
    doc: "Runs at the start of `INDIGO_DRIVER_INIT`, before private data and devices exist. Cannot use `PRIVATE_DATA`.",
  },
  on_shutdown: { doc: "Runs at the end of `INDIGO_DRIVER_SHUTDOWN`, after detach and release." },
  on_attach: { doc: "Runs after the base class attach and before local properties are created." },
  on_detach: { doc: "Runs before local properties are released." },
  on_connect: {
    doc: "Connection branch. Store the result in `connection_result` and never `return`: it would skip property definition, messages and the CONNECTION update.",
  },
  on_disconnect: {
    doc: "Disconnection branch. Stop moving hardware here. Never `return`: it would skip generator owned cleanup.",
  },
  on_timer: {
    doc: "Body of the timer callback, run once after a successful connection. Reschedule it with `indigo_execute_handler_in()` to poll.",
  },
  on_change: {
    doc: "Body of the change handler. An empty block means copy values, set OK and update. A body containing `_finalizer` disables the generated OK prologue and final update.",
  },
  on_change_request: { doc: "Runs in the bus context before values are copied. No I/O here." },
  discover: { doc: "SDK discovery: call `process_plug_event_handler(NULL, handle)` for each device." },
  plug: { doc: "Runs after USB filtering; fill `private_data` and `name`, or set `plug_result = false`." },
  unplug: { doc: "Runs before the generated detach; release SDK side reservations." },
  unplug_match: { doc: "Set `unplug_result` to tell whether this device matches the removed USB device." },
  serial: { doc: CONTEXTS.serial.doc },
  hid: { doc: CONTEXTS.hid.doc },
  libusb: { doc: CONTEXTS.libusb.doc },
  sdk: { doc: CONTEXTS.sdk.doc },
  pattern: { doc: CONTEXTS.pattern.doc },
  reject_change: { doc: CONTEXTS.reject_change.doc },
  item: { doc: CONTEXTS.item.doc },
  inherited: { doc: CONTEXTS.inherited.doc },
  switch: { doc: CONTEXTS.property.doc + " Switch property." },
  text: { doc: CONTEXTS.property.doc + " Text property." },
  number: { doc: CONTEXTS.property.doc + " Number property." },
  light: { doc: CONTEXTS.property.doc + " Light property." },
  driver: { doc: CONTEXTS.driver.doc },
};
for (const device of DEVICE_TYPES) {
  BLOCK_DOCS[device] = { doc: `\`${device}\` logical device. ${CONTEXTS.device.doc}` };
}
