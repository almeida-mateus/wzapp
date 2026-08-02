import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/composer.js";
import { Context } from "../src/context.js";
import type { WhatsappUpdate } from "../src/update.js";

/* ─── Context fakes ────────────────────────────────────────────────────
 * The composer never touches the socket or api — it only reads `ctx.update`
 * (and, for `command`, `ctx.prefix`) and stashes match results. We can
 * therefore drive it with a minimal stub.
 */

function fakeContext(update: WhatsappUpdate, prefix = "/"): Context {
  const ctx = Object.create(Context.prototype) as Context & {
    update: WhatsappUpdate;
    prefix: string;
    match?: RegExpMatchArray | string;
  };
  ctx.update = update;
  ctx.prefix = prefix;
  return ctx;
}

function textMessage(text: string): WhatsappUpdate {
  return {
    type: "message",
    message: {
      key: { remoteJid: "x@s.whatsapp.net", fromMe: false, id: "1" },
      message: { conversation: text },
    },
  } as WhatsappUpdate;
}

function imageUpdate(): WhatsappUpdate {
  return {
    type: "message",
    message: {
      key: { remoteJid: "x@s.whatsapp.net", fromMe: false, id: "1" },
      message: { imageMessage: {} },
    },
  } as WhatsappUpdate;
}

async function dispatch(c: Composer, ctx: Context): Promise<void> {
  await c.middleware()(ctx, async () => undefined);
}

/* ─── Tests ──────────────────────────────────────────────────────────── */

describe("Composer.use", () => {
  it("invokes middleware in order", async () => {
    const order: number[] = [];
    const c = new Composer();
    c.use(async (_ctx, next) => {
      order.push(1);
      await next();
      order.push(4);
    });
    c.use(async (_ctx, next) => {
      order.push(2);
      await next();
      order.push(3);
    });
    await dispatch(c, fakeContext(textMessage("hi")));
    expect(order).toEqual([1, 2, 3, 4]);
  });
});

describe("Composer.on", () => {
  it("only fires when the filter matches", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.on("message:image", handler);
    await dispatch(c, fakeContext(textMessage("hi")));
    expect(handler).not.toHaveBeenCalled();
    await dispatch(c, fakeContext(imageUpdate()));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports array (OR) form", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.on(["message:image", "message:video"], handler);
    await dispatch(c, fakeContext(imageUpdate()));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("Composer.command", () => {
  it("matches /name exactly and sets ctx.match to empty string", async () => {
    const c = new Composer();
    let captured: string | undefined;
    c.command("start", (ctx) => {
      captured = (ctx as Context & { match?: string }).match as string;
    });
    await dispatch(c, fakeContext(textMessage("/start")));
    expect(captured).toBe("");
  });

  it("matches /name <args> and sets ctx.match to the args", async () => {
    const c = new Composer();
    let captured: string | undefined;
    c.command("echo", (ctx) => {
      captured = (ctx as Context & { match?: string }).match as string;
    });
    await dispatch(c, fakeContext(textMessage("/echo hello world")));
    expect(captured).toBe("hello world");
  });

  it("honours a custom prefix via ctx.prefix", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.command("ping", handler);
    await dispatch(c, fakeContext(textMessage("!ping"), "!"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores text without the prefix", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.command("start", handler);
    await dispatch(c, fakeContext(textMessage("start")));
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not fire on non-message updates", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.command("start", handler);
    const presence: WhatsappUpdate = {
      type: "presence",
      jid: "x",
      presences: {},
    };
    await dispatch(c, fakeContext(presence));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("Composer.hears", () => {
  it("matches exact string", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.hears("ping", handler);
    await dispatch(c, fakeContext(textMessage("ping")));
    expect(handler).toHaveBeenCalledTimes(1);
    await dispatch(c, fakeContext(textMessage("pong")));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("matches a regex and stores the match array", async () => {
    const c = new Composer();
    let m: RegExpMatchArray | undefined;
    c.hears(/^echo (.+)$/, (ctx) => {
      m = (ctx as Context & { match?: RegExpMatchArray }).match as RegExpMatchArray;
    });
    await dispatch(c, fakeContext(textMessage("echo banana")));
    expect(m?.[1]).toBe("banana");
  });
});

describe("Composer.branch", () => {
  it("runs the truthy branch when predicate is true", async () => {
    const c = new Composer();
    const t = vi.fn();
    const f = vi.fn();
    c.branch(() => true, t, f);
    await dispatch(c, fakeContext(textMessage("hi")));
    expect(t).toHaveBeenCalledTimes(1);
    expect(f).not.toHaveBeenCalled();
  });

  it("runs the falsy branch when predicate is false", async () => {
    const c = new Composer();
    const t = vi.fn();
    const f = vi.fn();
    c.branch(() => false, t, f);
    await dispatch(c, fakeContext(textMessage("hi")));
    expect(f).toHaveBeenCalledTimes(1);
    expect(t).not.toHaveBeenCalled();
  });
});

describe("Composer.errorBoundary", () => {
  it("catches downstream errors and forwards them to the handler", async () => {
    const c = new Composer();
    const boundary = vi.fn();
    const bound = c.errorBoundary(boundary);
    bound.use(() => {
      throw new Error("boom");
    });
    await dispatch(c, fakeContext(textMessage("hi")));
    expect(boundary).toHaveBeenCalledTimes(1);
  });
});

describe("Composer.fork", () => {
  it("runs forked middleware and awaits it before dispatch resolves", async () => {
    const c = new Composer();
    let forkedDone = false;
    const forked = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      forkedDone = true;
    });
    c.fork(forked);
    const after = vi.fn();
    c.use(after);
    await dispatch(c, fakeContext(textMessage("hi")));
    expect(forked).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    // The forked branch crossed an async gap; dispatch must have awaited it.
    expect(forkedDone).toBe(true);
  });
});

describe("Composer.lazy", () => {
  it("builds middleware per context", async () => {
    const c = new Composer();
    const handler = vi.fn();
    const factory = vi.fn(() => handler);
    c.lazy(factory);
    await dispatch(c, fakeContext(textMessage("hi")));
    await dispatch(c, fakeContext(textMessage("hi again")));
    // The factory runs once per dispatched context, not once at setup.
    expect(factory).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("Composer.ignore", () => {
  function fromMeMessage(): WhatsappUpdate {
    return {
      type: "message",
      message: {
        key: { remoteJid: "x@s.whatsapp.net", fromMe: true, id: "1" },
        message: { conversation: "echo of mine" },
      },
    } as WhatsappUpdate;
  }

  it("drops updates matching the ignored query", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.ignore("message:from_me");
    c.on("message:text", handler);
    await dispatch(c, fakeContext(fromMeMessage()));
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets non-matching updates through", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.ignore("message:from_me");
    c.on("message:text", handler);
    await dispatch(c, fakeContext(textMessage("hi")));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("accepts an array (OR)", async () => {
    const c = new Composer();
    const handler = vi.fn();
    c.ignore(["message:from_me", "message:broadcast"]);
    c.on("message:text", handler);
    await dispatch(c, fakeContext(fromMeMessage()));
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not affect middleware registered BEFORE the ignore", async () => {
    const c = new Composer();
    const before = vi.fn();
    const after = vi.fn();
    c.on("message:from_me", before);
    c.ignore("message:from_me");
    c.on("message:text", after);
    await dispatch(c, fakeContext(fromMeMessage()));
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
  });
});

describe("`next` invariant", () => {
  it("throws if next() is called twice within a composed chain", async () => {
    const c = new Composer();
    c.use(async (_ctx, next) => {
      await next();
      await next();
    });
    // A downstream middleware is required for the `concat`-guarded `next`
    // to actually wrap the inner call — without it, the second `await next()`
    // resolves to the raw dispatcher and slips by.
    c.use(async () => undefined);
    await expect(
      dispatch(c, fakeContext(textMessage("hi"))),
    ).rejects.toThrow(/already called/);
  });
});
