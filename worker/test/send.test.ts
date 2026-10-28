import { describe, expect, it } from "vitest";
import { render, TemplateError } from "../src/send/template";
import { isEmail, parseSendRequest } from "../src/send/validate";

describe("render", () => {
  it("escapes html values", () => {
    expect(render("<p>{{x}}</p>", { x: `<img src=x onerror="a">` }, "html")).toBe(
      "<p>&lt;img src=x onerror=&quot;a&quot;&gt;</p>",
    );
  });
  it("strips CRLF in header mode", () => {
    expect(render("Hi {{n}}", { n: "a\r\nBcc: x@y.z" }, "header")).toBe("Hi a Bcc: x@y.z");
  });
  it("throws on missing variable", () => {
    expect(() => render("{{code}}", {}, "text")).toThrow(TemplateError);
  });
  it("does not resolve prototype keys", () => {
    expect(() => render("{{constructor}}", {}, "text")).toThrow(TemplateError);
  });
});

describe("isEmail", () => {
  it.each(["a@b.co", "user.name+tag@sub.example.com"])("accepts %s", (e) => expect(isEmail(e)).toBe(true));
  it.each(["a@b", "a b@c.com", "a@b.com\r\nBcc: x@y.z", "<a@b.com>", "a@-b.com", "x"])("rejects %s", (e) =>
    expect(isEmail(e)).toBe(false),
  );
});

describe("parseSendRequest", () => {
  it("accepts a template request and lowercases to", () => {
    const r = parseSendRequest({ to: "User@Example.com", template: "login_code", variables: { code: "123456" } }, null);
    expect(r.ok && r.req.to).toBe("user@example.com");
  });
  it("rejects arrays of recipients", () => {
    expect(parseSendRequest({ to: ["a@b.co"], template: "login_code" }, null).ok).toBe(false);
  });
  it("requires exactly one of template or raw", () => {
    expect(parseSendRequest({ to: "a@b.co" }, null).ok).toBe(false);
    expect(parseSendRequest({ to: "a@b.co", template: "x", subject: "s", text: "t" }, null).ok).toBe(false);
  });
  it("rejects non-scalar variables", () => {
    expect(parseSendRequest({ to: "a@b.co", template: "x", variables: { a: { b: 1 } } }, null).ok).toBe(false);
  });
  it("prefers the Idempotency-Key header", () => {
    const r = parseSendRequest({ to: "a@b.co", template: "x", idempotency_key: "body" }, "hdr");
    expect(r.ok && r.req.idempotency_key).toBe("hdr");
  });
});
