export const FAULTS = ['none', 'pool_leak', 'cpu_burn'] as const;
export type Fault = (typeof FAULTS)[number];

export type Config = {
  fault: Fault;
  cpuIter: number;
  serviceVersion: string;
  port: number;
  databaseUrl: string;
};

/** Fault flag and friends, read once at startup (simulates a deploy). Unknown values fail fast. */
export function parseFault(raw: string | undefined): Fault {
  const v = raw ?? 'none';
  if ((FAULTS as readonly string[]).includes(v)) return v as Fault;
  throw new Error(`invalid FAULT "${v}" (expected one of ${FAULTS.join(', ')})`);
}

export function parseCpuIter(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 300000; // scenario-db-pool.md S2
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid CPU_ITER "${raw}" (expected a positive integer)`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    fault: parseFault(env.FAULT),
    cpuIter: parseCpuIter(env.CPU_ITER),
    serviceVersion: env.SERVICE_VERSION ?? '1.0.0',
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? 'postgres://demo:demo@localhost:5432/demo',
  };
}
