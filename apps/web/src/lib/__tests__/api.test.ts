import { afterEach, describe, expect, test } from "bun:test";

/**
 * The rule this file protects: the API address must be resolved from the page the visitor
 * loaded, not compiled into the bundle.
 *
 * Getting this wrong is invisible on the machine that serves the site — localhost resolves
 * there — and breaks for every other visitor, which is a long way to travel to find a
 * one-line bug. `api.ts` reads its configuration at module scope, so each case imports a
 * fresh copy with the environment already set.
 */

const MODULE = "../api.ts";

async function loadWith(env: Record<string, string | undefined>, href?: string) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (href) {
    const url = new URL(href);
    (globalThis as { window?: unknown }).window = {
      location: { protocol: url.protocol, hostname: url.hostname },
    };
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  // Bust the module cache so module-scope constants are re-read.
  const mod = (await import(`${MODULE}?t=${Math.random()}`)) as typeof import("../api.ts");
  return mod;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete process.env.NEXT_PUBLIC_RAG_API_URL;
  delete process.env.NEXT_PUBLIC_RAG_API_PORT;
});

describe("apiBaseUrl", () => {
  test("derives the API host from the address the page was opened on", async () => {
    const { apiBaseUrl } = await loadWith({}, "http://192.168.1.50:3000/studio/qa");
    expect(apiBaseUrl()).toBe("http://192.168.1.50:7730");
  });

  test("still works on localhost", async () => {
    const { apiBaseUrl } = await loadWith({}, "http://localhost:3000/");
    expect(apiBaseUrl()).toBe("http://localhost:7730");
  });

  test("keeps the page's scheme, so an https deployment does not fall back to http", async () => {
    const { apiBaseUrl } = await loadWith({}, "https://books.example.com/chat");
    expect(apiBaseUrl()).toBe("https://books.example.com:7730");
  });

  test("honours an explicit override over derivation", async () => {
    // A reverse proxy or a separate API host cannot be inferred — it has to be declared.
    const { apiBaseUrl } = await loadWith(
      { NEXT_PUBLIC_RAG_API_URL: "https://api.example.com" },
      "https://books.example.com/",
    );
    expect(apiBaseUrl()).toBe("https://api.example.com");
  });

  test("trims a trailing slash so callers can concatenate paths safely", async () => {
    const { apiBaseUrl } = await loadWith({ NEXT_PUBLIC_RAG_API_URL: "https://api.example.com/" });
    expect(apiBaseUrl()).toBe("https://api.example.com");
  });

  test("treats a blank override as unset rather than as an empty base", async () => {
    const { apiBaseUrl } = await loadWith(
      { NEXT_PUBLIC_RAG_API_URL: "   " },
      "http://10.0.0.7:3000/",
    );
    expect(apiBaseUrl()).toBe("http://10.0.0.7:7730");
  });

  test("respects a non-default API port", async () => {
    const { apiBaseUrl } = await loadWith(
      { NEXT_PUBLIC_RAG_API_PORT: "8080" },
      "http://192.168.1.50:3000/",
    );
    expect(apiBaseUrl()).toBe("http://192.168.1.50:8080");
  });

  test("falls back to loopback on the server, where there is no page to derive from", async () => {
    const { apiBaseUrl } = await loadWith({});
    expect(apiBaseUrl()).toBe("http://localhost:7730");
  });

  test("the UI label is identical on server and client, so hydration cannot mismatch", async () => {
    const onServer = await loadWith({});
    const onClient = await loadWith({}, "http://192.168.1.50:3000/");
    expect(onClient.apiBaseUrlLabel()).toBe(onServer.apiBaseUrlLabel());
  });

  test("the label shows the real address when one is configured", async () => {
    const { apiBaseUrlLabel } = await loadWith({
      NEXT_PUBLIC_RAG_API_URL: "https://api.example.com",
    });
    expect(apiBaseUrlLabel()).toBe("https://api.example.com");
  });
});
