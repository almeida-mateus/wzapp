import {
  BufferJSON,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
} from "@whiskeysockets/baileys";
import type {
  AuthenticationCreds,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from "@whiskeysockets/baileys";
import type { AuthHandle } from "./bot.js";

/**
 * Minimal key-value contract an auth backend must satisfy. Implement it over
 * Redis, S3, SQLite, Postgres, or anything else that stores strings, and pass
 * it to {@link storageAuthState} to run the bot without a writable disk
 * (containers with ephemeral filesystems, redeploys without re-pairing).
 *
 * Values are opaque serialized JSON; keys are flat strings (`creds`,
 * `pre-key-1`, `session-xyz.0`, ...). Prefix them yourself if the backend is
 * shared (`wa:${key}`).
 *
 * `getMany`/`setMany` are optional batch fast paths. The signal key store is
 * read in bursts, so wiring `getMany` to a pipelined/multi-get command is the
 * single biggest latency win a backend can offer. Without them, calls fall
 * back to per-key `get`/`set`/`delete`.
 *
 * @example
 * import { createClient } from "redis";
 *
 * const redis = createClient({ url: process.env.REDIS_URL });
 * await redis.connect();
 *
 * const storage: AuthStorage = {
 *   get: (key) => redis.get(`wa:${key}`),
 *   set: async (key, value) => { await redis.set(`wa:${key}`, value); },
 *   delete: async (key) => { await redis.del(`wa:${key}`); },
 *   getMany: (keys) => redis.mGet(keys.map((k) => `wa:${k}`)),
 * };
 */
export interface AuthStorage {
  /** Value stored under `key`, or `null`/`undefined` when absent. */
  get(key: string): Promise<string | null | undefined>;
  /** Store `value` under `key`, overwriting any previous value. */
  set(key: string, value: string): Promise<void>;
  /** Remove `key`. Removing an absent key must not throw. */
  delete(key: string): Promise<void>;
  /**
   * Batch read: one result per input key, same order, `null`/`undefined`
   * for absent keys.
   */
  getMany?(keys: string[]): Promise<(string | null | undefined)[]>;
  /**
   * Batch write: apply every entry, where `value: null` means delete.
   * Entries within one call should be applied atomically if the backend
   * supports it (a Redis pipeline/MULTI, a single SQL transaction).
   */
  setMany?(entries: { key: string; value: string | null }[]): Promise<void>;
}

/**
 * Options for {@link storageAuthState}.
 */
export interface StorageAuthOptions {
  /**
   * Wrap the signal key store in Baileys' in-memory cache
   * (`makeCacheableSignalKeyStore`). The store is read far more often than
   * it changes, so the cache absorbs most round trips to the backend.
   * Defaults to `true`; disable only if the same session is served by more
   * than one live socket (it isn't, in a correctly deployed bot).
   */
  cache?: boolean;
  /** Logger forwarded to the signal key cache. Silent when omitted. */
  logger?: Parameters<typeof makeCacheableSignalKeyStore>[1];
}

/**
 * Builds an {@link AuthHandle} on top of any {@link AuthStorage} backend.
 * The storage-backed equivalent of Baileys' `useMultiFileAuthState`: same
 * data, same lifecycle, no filesystem.
 *
 * Fresh credentials are created when the backend has none; pass the handle
 * to `new Bot({ auth })` and the first run prints a QR as usual. Subsequent
 * runs (or redeploys pointing at the same backend) reconnect silently.
 *
 * Writes flow through as they happen: key material is persisted inside the
 * signal store's `set`, credentials whenever Baileys emits `creds.update`
 * (the `Bot` wires that to `saveCreds`).
 *
 * @example
 * import { Bot, storageAuthState } from "@almeidamateus/wzapp";
 *
 * const auth = await storageAuthState(storage); // any AuthStorage impl
 * const bot = new Bot({ auth }).ignore("message:from_me");
 * await bot.start();
 */
export async function storageAuthState(
  storage: AuthStorage,
  opts: StorageAuthOptions = {},
): Promise<AuthHandle> {
  const read = async (key: string): Promise<unknown> => {
    const raw = await storage.get(key);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw, BufferJSON.reviver);
  };
  const serialize = (value: unknown): string =>
    JSON.stringify(value, BufferJSON.replacer);

  const creds: AuthenticationCreds =
    ((await read("creds")) as AuthenticationCreds | null) ?? initAuthCreds();

  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const storageKeys = ids.map((id) => `${type}-${id}`);
      const raws = storage.getMany
        ? await storage.getMany(storageKeys)
        : await Promise.all(storageKeys.map((k) => storage.get(k)));

      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      ids.forEach((id, i) => {
        const raw = raws[i];
        if (raw === null || raw === undefined) return;
        let value = JSON.parse(raw, BufferJSON.reviver);
        // Same revival `useMultiFileAuthState` does: this category is a
        // protobuf message, not a plain object.
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        out[id] = value as SignalDataTypeMap[T];
      });
      return out;
    },
    async set(data: SignalDataSet) {
      const entries: { key: string; value: string | null }[] = [];
      for (const type in data) {
        const category = data[type as keyof SignalDataTypeMap];
        for (const id in category) {
          const value = category[id];
          entries.push({
            key: `${type}-${id}`,
            value: value ? serialize(value) : null,
          });
        }
      }
      if (storage.setMany) {
        await storage.setMany(entries);
        return;
      }
      await Promise.all(
        entries.map((e) =>
          e.value === null ? storage.delete(e.key) : storage.set(e.key, e.value),
        ),
      );
    },
  };

  return {
    state: {
      creds,
      keys:
        opts.cache === false
          ? keys
          : makeCacheableSignalKeyStore(keys, opts.logger),
    },
    saveCreds: async () => {
      await storage.set("creds", serialize(creds));
    },
  };
}

/**
 * In-memory {@link AuthStorage}, with the batch fast paths implemented.
 * Sessions vanish with the process, so this is for tests and experiments,
 * not deployment. Also the reference for what a backend must do.
 *
 * The backing map is exposed as `data` so tests can inspect or preload it.
 */
export function memoryAuthStorage(): AuthStorage & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
    getMany: async (keys) => keys.map((k) => data.get(k) ?? null),
    setMany: async (entries) => {
      for (const { key, value } of entries) {
        if (value === null) data.delete(key);
        else data.set(key, value);
      }
    },
  };
}
