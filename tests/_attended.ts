// Existing process-lifecycle tests explicitly exercise the attended, unlimited-command path.
// Live admission is separately tested against the packed binary with isolated no-spend tools.
import { afterEach, beforeEach } from "vitest";
import { Workers, type StartOptions } from "../src/workers.js";

export function useAttendedTerminal(): void {
  let previous: PropertyDescriptor | undefined;
  beforeEach(() => {
    previous = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    if (previous) Object.defineProperty(process.stdin, "isTTY", previous);
    else delete (process.stdin as any).isTTY;
  });
}
export class AttendedWorkers extends Workers {
  override start(name: string, opts: StartOptions = {}): Record<string, any> {
    return super.start(name, { force: true, ...opts });
  }
}
