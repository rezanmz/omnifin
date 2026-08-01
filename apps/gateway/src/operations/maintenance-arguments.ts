const VALUE_ARGUMENTS = new Set(["--input", "--output", "--rollback-output"]);
const FLAG_ARGUMENTS = new Set(["--confirm-gateway-stopped"]);

export interface MaintenanceArguments {
  flags: Set<string>;
  values: Map<string, string>;
}

export function parseMaintenanceArguments(arguments_: string[]): MaintenanceArguments {
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (FLAG_ARGUMENTS.has(argument)) {
      if (flags.has(argument)) throw new Error("usage");
      flags.add(argument);
      continue;
    }
    if (!VALUE_ARGUMENTS.has(argument)) throw new Error("usage");
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) throw new Error("usage");
    values.set(argument, value);
    index += 1;
  }

  return { flags, values };
}

export function requireMaintenanceValue(arguments_: MaintenanceArguments, name: string) {
  const value = arguments_.values.get(name);
  if (!value) throw new Error("usage");
  return value;
}

export function assertOnlyMaintenanceValues(arguments_: MaintenanceArguments, allowed: string[]) {
  for (const name of arguments_.values.keys()) {
    if (!allowed.includes(name)) throw new Error("usage");
  }
}
