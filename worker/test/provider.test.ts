import { describe, expect, it, vi } from "vitest";
import { CloudflareProvider } from "../src/send/provider";

describe("CloudflareProvider sender addresses", () => {
  it.each([undefined, ""])("uses a plain address without a display name (%s)", async (name) => {
    const send = vi.fn(async (message: EmailMessageBuilder) => {
      // Match the runtime constraint that caused the production send failure.
      if (typeof message.from === "object" && typeof message.from.name !== "string") {
        throw new TypeError("Incorrect type for the 'name' field on 'EmailAddress'");
      }
      return { messageId: "provider-test-id" };
    });
    const provider = new CloudflareProvider({ send } as unknown as SendEmail);
    const result = await provider.send({
      from: { email: "hello@example.com", name },
      to: "recipient@example.net", subject: "Transactional test", text: "Test",
    });
    expect(result).toEqual({ ok: true, messageId: "provider-test-id" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "hello@example.com" }));
  });

  it("preserves a configured sender display name", async () => {
    const send = vi.fn(async () => ({ messageId: "named-provider-test" }));
    const provider = new CloudflareProvider({ send } as unknown as SendEmail);
    await provider.send({
      from: { email: "hello@example.com", name: "Example" },
      to: "recipient@example.net", subject: "Transactional test", text: "Test",
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: { email: "hello@example.com", name: "Example" } }));
  });
});
