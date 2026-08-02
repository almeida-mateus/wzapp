import { describe, expect, it, vi } from "vitest";
import { proto } from "@whiskeysockets/baileys";
import { memoryAuthStorage, storageAuthState } from "../src/auth.js";
import type { AuthStorage } from "../src/auth.js";

// The cache wrapper is exercised implicitly by the default path; these tests
// disable it wherever they need to observe raw backend traffic.

describe("storageAuthState", () => {
  it("creates fresh creds when the backend is empty and persists on saveCreds", async () => {
    const storage = memoryAuthStorage();
    const auth = await storageAuthState(storage);

    expect(auth.state.creds.noiseKey.public).toBeInstanceOf(Uint8Array);
    expect(storage.data.has("creds")).toBe(false);

    await auth.saveCreds();
    expect(storage.data.has("creds")).toBe(true);
  });

  it("reloads the same creds on a second call over the same backend", async () => {
    const storage = memoryAuthStorage();
    const first = await storageAuthState(storage);
    await first.saveCreds();

    const second = await storageAuthState(storage);
    expect(Buffer.from(second.state.creds.noiseKey.public)).toEqual(
      Buffer.from(first.state.creds.noiseKey.public),
    );
    expect(second.state.creds.registrationId).toBe(
      first.state.creds.registrationId,
    );
  });

  it("round-trips signal keys, reviving Buffers", async () => {
    const storage = memoryAuthStorage();
    const auth = await storageAuthState(storage, { cache: false });

    const keyPair = {
      public: Buffer.from([1, 2, 3]),
      private: Buffer.from([4, 5, 6]),
    };
    await auth.state.keys.set({ "pre-key": { "1": keyPair } });

    const out = await auth.state.keys.get("pre-key", ["1", "999"]);
    expect(Buffer.from(out["1"]!.public)).toEqual(keyPair.public);
    expect(Buffer.from(out["1"]!.private)).toEqual(keyPair.private);
    expect(out["999"]).toBeUndefined();
  });

  it("deletes keys stored as null", async () => {
    const storage = memoryAuthStorage();
    const auth = await storageAuthState(storage, { cache: false });

    await auth.state.keys.set({
      session: { abc: Buffer.from([7]) as unknown as Uint8Array },
    });
    expect(storage.data.has("session-abc")).toBe(true);

    await auth.state.keys.set({ session: { abc: null } });
    expect(storage.data.has("session-abc")).toBe(false);
  });

  it("revives app-state-sync-key values as protobuf messages", async () => {
    const storage = memoryAuthStorage();
    const auth = await storageAuthState(storage, { cache: false });

    const key = proto.Message.AppStateSyncKeyData.fromObject({
      keyData: Buffer.from([9, 9]),
    });
    await auth.state.keys.set({ "app-state-sync-key": { k1: key } });

    const out = await auth.state.keys.get("app-state-sync-key", ["k1"]);
    expect(out["k1"]).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(Buffer.from(out["k1"]!.keyData!)).toEqual(Buffer.from([9, 9]));
  });

  it("prefers the batch fast paths when the backend provides them", async () => {
    const storage = memoryAuthStorage();
    const getMany = vi.spyOn(storage, "getMany");
    const setMany = vi.spyOn(storage, "setMany");
    const get = vi.spyOn(storage, "get");

    const auth = await storageAuthState(storage, { cache: false });
    await auth.state.keys.set({
      "pre-key": { "1": { public: Buffer.alloc(1), private: Buffer.alloc(1) } },
    });
    await auth.state.keys.get("pre-key", ["1"]);

    expect(setMany).toHaveBeenCalledTimes(1);
    expect(getMany).toHaveBeenCalledTimes(1);
    // `get` is only used for the initial creds read, never for signal keys.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("creds");
  });

  it("falls back to per-key calls when the batch methods are absent", async () => {
    const backing = memoryAuthStorage();
    const storage: AuthStorage = {
      get: (k) => backing.get(k),
      set: (k, v) => backing.set(k, v),
      delete: (k) => backing.delete(k),
    };
    const auth = await storageAuthState(storage, { cache: false });

    await auth.state.keys.set({
      "pre-key": {
        "1": { public: Buffer.alloc(1), private: Buffer.alloc(1) },
        "2": null,
      },
    });
    const out = await auth.state.keys.get("pre-key", ["1", "2"]);
    expect(out["1"]).toBeDefined();
    expect(out["2"]).toBeUndefined();
  });
});
