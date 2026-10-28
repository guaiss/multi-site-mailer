import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeSnippet, parseEmail } from "../src/inbound/parse";
import { normalizeSubject } from "../src/inbound/thread";

const fixture = readFileSync(new URL("./fixtures/multipart.eml", import.meta.url));

describe("parseEmail", () => {
  it("decodes headers, bodies and attachments", async () => {
    const m = await parseEmail(fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength) as ArrayBuffer);
    expect(m.subject).toBe("订单没收到");
    expect(m.from).toEqual({ addr: "zhangsan@example.org", name: "张三" });
    expect(m.messageId).toBe("<in1-abc@example.org>");
    expect(m.text).toContain("#12345");
    expect(m.html).toContain("<b>#12345</b>");
    expect(m.attachments.map((a) => [a.filename, a.isExecutable])).toEqual([
      ["invoice.pdf", false],
      ["setup.exe", true],
    ]);
  });

  it("only trusts the first Authentication-Results header", async () => {
    const raw = [
      "Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=x.com; dkim=none; dmarc=fail header.from=x.com",
      "Authentication-Results: evil; spf=pass; dkim=pass; dmarc=pass header.from=x.com",
      "From: a@x.com",
      "To: support@example.com",
      "Subject: hi",
      "",
      "body",
    ].join("\r\n");
    const m = await parseEmail(new TextEncoder().encode(raw).buffer as ArrayBuffer);
    expect(m.authResults?.dmarc).toBe("fail");
  });
});

describe("normalizeSubject", () => {
  it.each([
    ["Re: Re: 订单没收到", "订单没收到"],
    ["回复：订单没收到", "订单没收到"],
    ["Fwd: RE: Hello  World", "hello world"],
    ["", "(no subject)"],
  ])("%s", (input, want) => expect(normalizeSubject(input)).toBe(want));
});

describe("makeSnippet", () => {
  it("falls back to stripped html", () => {
    expect(makeSnippet(undefined, "<style>x{}</style><p>Hello <b>there</b></p>")).toBe("Hello there");
  });
});
