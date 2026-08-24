import { describe, expect, test } from "bun:test";

import { isPrivateOrigin } from "../cors.ts";

/**
 * The private-network CORS allowance exists so the Studio works from a phone on the office
 * wifi without pinning a DHCP address. Its whole value is that it is BOUNDED — if it ever
 * matched a public host it would be `*` with extra steps, and a page anywhere on the
 * internet could read the client's ledgers out of a browser on the same network.
 */
describe("isPrivateOrigin", () => {
  test("accepts the RFC1918 ranges a home or office network uses", () => {
    for (const origin of [
      "http://192.168.1.50:3000",
      "http://192.168.100.97:3000",
      "http://10.0.0.7:3000",
      "http://172.16.4.9:3000",
      "http://172.31.255.254:3000",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]) {
      expect(`${origin} → ${isPrivateOrigin(origin)}`).toBe(`${origin} → true`);
    }
  });

  test("rejects public hosts", () => {
    for (const origin of [
      "https://evil.example.com",
      "http://8.8.8.8",
      "https://192.168.1.50.evil.com",
      "http://11.0.0.1",
      "http://172.32.0.1",
      "http://172.15.0.1",
    ]) {
      expect(`${origin} → ${isPrivateOrigin(origin)}`).toBe(`${origin} → false`);
    }
  });

  test("rejects the boundaries of the 172.16/12 block correctly", () => {
    // 172.16–172.31 are private; 172.15 and 172.32 are not. Off-by-one here would hand
    // two public /16s the same access as the office wifi.
    expect(isPrivateOrigin("http://172.16.0.1")).toBe(true);
    expect(isPrivateOrigin("http://172.31.0.1")).toBe(true);
    expect(isPrivateOrigin("http://172.15.255.255")).toBe(false);
    expect(isPrivateOrigin("http://172.32.0.1")).toBe(false);
  });

  test("rejects an unparseable Origin rather than guessing", () => {
    expect(isPrivateOrigin("not a url")).toBe(false);
    expect(isPrivateOrigin("")).toBe(false);
  });

  test("is not fooled by a private address appearing elsewhere in the URL", () => {
    expect(isPrivateOrigin("https://example.com/192.168.1.1")).toBe(false);
    expect(isPrivateOrigin("https://user@192.168.1.1.example.com")).toBe(false);
  });
});
