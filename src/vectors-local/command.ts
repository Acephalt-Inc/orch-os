import { parseOrigin, probe, stockTransport, type Transport } from "./client.js";

interface Output { out(text: string): void; err(text: string): void }

export async function runVectorsCommand(args: string[], io: Output, transport: Transport = stockTransport): Promise<number> {
  if (args.length !== 4 || args[0] !== "connect-local" || args[1] !== "--preview" || args[2] !== "--url") {
    io.err("vectors connect-local: USAGE\n");
    return 2;
  }
  try {
    const origin = parseOrigin(args[3]);
    if (!origin) throw new Error("refused");
    const dimension = await probe(origin, transport);
    io.out(`vectors connect-local: PROBE_OK dimension=${dimension}\n`);
    return 0;
  } catch {
    io.err("vectors connect-local: REFUSED\n");
    return 1;
  }
}
