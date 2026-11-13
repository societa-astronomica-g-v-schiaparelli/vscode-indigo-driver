import { contextOf, type Node, type Problem, walk } from "./parser";
import { CONTEXTS } from "./schema";

/** Replace string literals, character literals and comments with spaces, keeping offsets. */
export function stripCode(code: string): string {
  return code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) =>
    " ".repeat(m.length),
  );
}

const attributeOf = (node: Node, name: string): Node | undefined =>
  node.children.find((child) => child.kind === "attribute" && child.keyword === name);

const isLiteralString = (value: string) => /^"[^"]*"$/.test(value.trim());

export function lint(root: Node, text: string): Problem[] {
  const problems: Problem[] = [];
  const add = (start: number, end: number, severity: Problem["severity"], message: string) =>
    problems.push({ start, end: Math.max(end, start + 1), severity, message });
  const at = (node: Node, severity: Problem["severity"], message: string) =>
    add(node.keywordStart, node.nameEnd, severity, message);

  walk(root, (node) => {
    const context = contextOf(node);
    if (context) {
      checkContext(node, context);
    }
    if (node.kind === "attribute") {
      checkAttribute(node);
    }
    if (node.kind === "code") {
      checkCode(node);
    }
  });

  checkDriver(root);
  return problems;

  function checkContext(node: Node, context: NonNullable<ReturnType<typeof contextOf>>) {
    const spec = CONTEXTS[context];
    const seen = new Set<string>();
    for (const child of node.children) {
      if (child.kind === "attribute") {
        if (seen.has(child.keyword)) {
          at(child, "warning", `Duplicate attribute '${child.keyword}'`);
        }
        seen.add(child.keyword);
        // Unknown driver level attributes become #define constants.
        if (context !== "driver" && !(child.keyword in spec.attributes)) {
          at(child, "warning", `Unknown attribute '${child.keyword}' for '${node.keyword}'`);
        }
      } else if (!spec.blocks.includes(child.keyword)) {
        at(child, "warning", `'${child.keyword}' is not valid inside '${node.keyword}'`);
      }
    }
    for (const [name, attribute] of Object.entries(spec.attributes)) {
      if (attribute.mandatory && !seen.has(name)) {
        at(node, "error", `Missing mandatory attribute '${name}'`);
      }
    }
    if (node.kind === "item" && node.parent?.keyword !== "number") {
      for (const child of node.children) {
        if (["min", "max", "step", "format"].includes(child.keyword)) {
          at(child, "error", `'${child.keyword}' is only valid on items of number properties`);
        }
      }
    }
    if (node.kind === "property" || node.kind === "item") {
      checkLocalDeclaration(node);
    }
    if (node.kind === "property") {
      checkProperty(node);
    }
    if (node.kind === "device") {
      checkDevice(node);
    }
  }

  function checkLocalDeclaration(node: Node) {
    // 'item ID;' explicitly takes every default.
    if (node.keyword === "inherited" || (node.kind === "item" && !node.hasBody)) {
      return;
    }
    if (!attributeOf(node, "label")) {
      at(node, "warning", `Set a 'label' on ${node.kind === "item" ? "every item" : "every local property"}`);
    }
  }

  function checkProperty(node: Node) {
    if (node.keyword !== "inherited") {
      const name = attributeOf(node, "name");
      if (name?.value && isLiteralString(name.value) && !name.value.startsWith('"X_')) {
        at(
          name,
          "warning",
          "Custom property names should start with 'X_'; standard properties use their *_PROPERTY_NAME macro",
        );
      }
      const hidden = attributeOf(node, "hidden");
      if (hidden?.value && !["true", "false"].includes(hidden.value)) {
        at(
          hidden,
          "warning",
          "On local properties only a literal 'true' hides the property; an expression is silently ignored",
        );
      }
    }
    const perm = attributeOf(node, "perm");
    if (perm?.value && /(^|_)RO(_|$)/.test(perm.value) && perm.value !== "INDIGO_RO_PERM") {
      at(perm, "warning", "Write exactly 'INDIGO_RO_PERM' to drop the generated change branch");
    }
    const noBranch =
      perm?.value === "INDIGO_RO_PERM" ||
      (node.keyword === "inherited" && !node.children.some((child) => child.keyword === "on_change"));
    if (noBranch) {
      for (const reject of node.children.filter((child) => child.kind === "reject_change")) {
        at(reject, "warning", "This property has no change branch: its reject_change block is ignored");
      }
    }
  }

  function checkDevice(node: Node) {
    if (node.keyword === "aux" && !attributeOf(node, "interface")) {
      at(node, "error", "'aux' devices require an 'interface' (INDIGO_INTERFACE_AUX_*)");
    }
    if (!attributeOf(node, "name") && !attributeOf(node, "name_value")) {
      at(node, "warning", "Set the device 'name' seen by clients");
    }
    const id = attributeOf(node, "id");
    if (
      id &&
      node.children.slice(0, node.children.indexOf(id)).some((c) => c.kind === "property" || c.kind === "code")
    ) {
      at(id, "error", "Device 'id' must precede properties and code blocks");
    }
    const ids = new Map<string, Node>();
    for (const child of node.children) {
      if (child.kind !== "property" || !child.name) {
        continue;
      }
      if (ids.has(child.name)) {
        add(child.nameStart, child.nameEnd, "warning", `Property '${child.name}' is declared more than once`);
      }
      ids.set(child.name, child);
    }
  }

  function checkAttribute(node: Node) {
    const value = node.value ?? "";
    if (!node.isString && (value.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1) {
      add(
        node.valueStart,
        node.valueEnd,
        "warning",
        "Unbalanced quote: the generator ends the value at the first ';', even inside a string",
      );
    }
    if (node.parent?.kind === "driver" && value !== "" && !Number.isNaN(Number(value))) {
      if (node.keyword === "version" && Number(value) === 0) {
        add(node.valueStart, node.valueEnd, "warning", "Driver version must not be 0");
      }
      if (node.keyword === "max_devices" && Number(value) < 1) {
        add(node.valueStart, node.valueEnd, "error", "max_devices must be at least 1");
      }
    }
  }

  function checkCode(node: Node) {
    const code = stripCode(text.slice(node.bodyStart, node.bodyEnd));
    if ((node.keyword === "on_connect" || node.keyword === "on_disconnect") && /\breturn\b/.test(code)) {
      at(
        node,
        "warning",
        `Never 'return' in ${node.keyword}: it skips property definition, messages and the CONNECTION update`,
      );
    }
    if (node.keyword === "on_change" && code.includes("_finalizer")) {
      at(
        node,
        "hint",
        "This body mentions '_finalizer': the generator drops the OK prologue and the final update, the handler must publish its own states",
      );
    }
  }

  function checkDriver(driver: Node) {
    if (driver.name && !/^[a-z][a-z0-9_]*$/.test(driver.name)) {
      add(
        driver.nameStart,
        driver.nameEnd,
        "warning",
        "Driver names are lower case, start with a letter and use only [a-z0-9_]",
      );
    }
    const devices = driver.children.filter((child) => child.kind === "device");
    if (devices.length === 0) {
      at(driver, "error", "At least one device block is required");
    }
    // A device without 'id' is identified by its type.
    const deviceIds = new Set<string>();
    for (const device of devices) {
      const id = attributeOf(device, "id")?.value ?? device.keyword;
      if (deviceIds.has(id)) {
        at(device, "error", `Duplicate device id '${id}': give each device of the same type a distinct 'id'`);
      }
      deviceIds.add(id);
    }
    const serial = driver.children.find((child) => child.kind === "transport" && child.keyword === "serial");
    // Helpers may live in a local header pulled in by any driver level block.
    const localInclude = driver.children.some(
      (child) => child.kind === "code" && /#\s*include\s*"/.test(text.slice(child.bodyStart, child.bodyEnd)),
    );
    if (serial && driver.name && !localInclude) {
      const helpers = driver.children
        .filter((child) => child.kind === "code" && child.keyword === "code")
        .map((child) => stripCode(text.slice(child.bodyStart, child.bodyEnd)))
        .join("\n");
      for (const suffix of ["open", "close"]) {
        if (!new RegExp(`\\b${driver.name}_${suffix}\\b`).test(helpers)) {
          at(serial, "warning", `Serial drivers need ${driver.name}_${suffix}() in the driver 'code' block`);
        }
      }
    }
  }
}
