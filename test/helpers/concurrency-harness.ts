import { basename, dirname } from "path";
import { existsSync, watch } from "fs";
import type { Database } from "bun:sqlite";

export interface WorkerEvent {
  type: string;
  worker: number;
  round?: number;
  [key: string]: unknown;
}

export interface WorkerExit {
  worker: number;
  exitCode: number;
  stderr: string;
}

export interface WorkerGroup {
  readonly processes: Bun.Subprocess[];
  readonly events: WorkerEvent[];
  waitForCount(
    predicate: (event: WorkerEvent) => boolean,
    count: number,
    timeoutMilliseconds?: number,
  ): Promise<WorkerEvent[]>;
  finish(): Promise<WorkerExit[]>;
  stop(): Promise<WorkerExit[]>;
}

export function emitWorkerEvent(event: Omit<WorkerEvent, "worker"> & { worker?: number }): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;

  await new Promise<void>((resolve, reject) => {
    const directory = dirname(path);
    const name = basename(path);
    let settled = false;
    const watcher = watch(directory, (_event, filename) => {
      if ((!filename || filename.toString() === name) && existsSync(path)) finish();
    });

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      watcher.close();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      watcher.close();
      resolve();
    };

    watcher.on("error", fail);
    if (existsSync(path)) finish();
  });
}

export function overrideFirstQueryGet(
  db: Database,
  matches: (sql: string) => boolean,
  value: unknown,
): Database {
  let used = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          const statement = target.query(sql);
          if (used || !matches(sql)) return statement;
          used = true;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "get") return () => value;
              const member = Reflect.get(statementTarget, statementProperty, statementTarget);
              return typeof member === "function" ? member.bind(statementTarget) : member;
            },
          });
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  }) as Database;
}

export function observeFirstQueryGet(
  db: Database,
  matches: (sql: string) => boolean,
  onGet: () => void,
): Database {
  let observed = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          const statement = target.query(sql);
          if (observed || !matches(sql)) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "get") {
                return (...args: Parameters<typeof statementTarget.get>) => {
                  const result = statementTarget.get(...args);
                  if (!observed) {
                    observed = true;
                    onGet();
                  }
                  return result;
                };
              }
              const member = Reflect.get(statementTarget, statementProperty, statementTarget);
              return typeof member === "function" ? member.bind(statementTarget) : member;
            },
          });
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  }) as Database;
}

export function launchWorkers(
  scriptPath: string,
  count: number,
  environment: Record<string, string>,
): WorkerGroup {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const events: WorkerEvent[] = [];
  const waiters: Array<{
    predicate: (event: WorkerEvent) => boolean;
    count: number;
    resolve: (events: WorkerEvent[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const processes = Array.from({ length: count }, (_, worker) =>
    Bun.spawn([process.execPath, scriptPath], {
      cwd: process.cwd(),
      env: {
        ...inheritedEnvironment,
        ...environment,
        AGZ_CONCURRENCY_WORKER: String(worker),
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );

  const outputDone = processes.map((child, worker) =>
    consumeOutput(child.stdout, worker, (event) => {
      events.push(event);
      for (let index = waiters.length - 1; index >= 0; index--) {
        const waiter = waiters[index]!;
        const matching = events.filter(waiter.predicate);
        if (matching.length < waiter.count) continue;
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(matching.slice(0, waiter.count));
      }
    }),
  );

  let finishPromise: Promise<WorkerExit[]> | undefined;
  const finish = () => {
    finishPromise ??= Promise.all(
      processes.map(async (child, worker) => {
        const exitCode = await child.exited;
        await outputDone[worker];
        const stderr = child.stderr ? await new Response(child.stderr).text() : "";
        return { worker, exitCode, stderr };
      }),
    );
    return finishPromise;
  };

  return {
    processes,
    events,
    waitForCount(predicate, count, timeoutMilliseconds = 30_000) {
      const matching = events.filter(predicate);
      if (matching.length >= count) return Promise.resolve(matching.slice(0, count));
      return new Promise<WorkerEvent[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              `timed out waiting for ${count} worker events; received ${events.filter(predicate).length}`,
            ),
          );
        }, timeoutMilliseconds);
        waiters.push({ predicate, count, resolve, reject, timer });
      });
    },
    finish,
    async stop() {
      for (const child of processes) {
        try {
          child.kill();
        } catch {
          // The child may have exited between the status check and kill.
        }
      }
      return finish();
    },
  };
}

async function consumeOutput(
  stream: ReadableStream<Uint8Array> | null,
  worker: number,
  emit: (event: WorkerEvent) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) emit(parseEvent(line, worker));
  }
  pending += decoder.decode();
  if (pending.trim()) emit(parseEvent(pending, worker));
}

function parseEvent(line: string, worker: number): WorkerEvent {
  try {
    const value = JSON.parse(line) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...(value as Record<string, unknown>), worker: Number((value as { worker?: unknown }).worker ?? worker) } as WorkerEvent;
    }
  } catch {
    // Preserve non-JSON output as an event so the parent reports it instead of hanging.
  }
  return { type: "raw-output", worker, raw: line };
}
